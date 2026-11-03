import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

async function sourceFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(
        entries.map(async (entry) => {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) return sourceFiles(full);
            return entry.name.endsWith(".ts") ? [full] : [];
        }),
    );
    return nested.flat();
}

/** Packages that must never be reachable from the root entry point. */
const NODE_ONLY = /^(?:node:|node-ble$|@stoprocent\/|@serialport\/)/;

/**
 * Walks runtime imports, re-exports, dynamic imports, and require calls.
 * Type-only edges are skipped because they are erased from the output.
 */
async function importGraph(entry: string): Promise<Map<string, string[]>> {
    const graph = new Map<string, string[]>();
    const queue = [entry];

    while (queue.length > 0) {
        const file = queue.pop();
        if (!file || graph.has(file)) continue;

        const text = await readFile(file, "utf8");
        const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        const deps: string[] = [];
        const add = (specifier: string): void => {
            if (!specifier.startsWith(".")) {
                deps.push(specifier);
                return;
            }
            const base = path.resolve(path.dirname(file), specifier.replace(/\.(?:mjs|cjs|js)$/, ".ts"));
            const candidates = /\.[cm]?tsx?$/.test(base) ? [base] : [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")];
            const resolved = candidates.find((candidate) => sourceFilesSyncExists(candidate));
            const target = resolved ?? base;
            deps.push(target);
            queue.push(target);
        };
        const visit = (node: ts.Node): void => {
            if (ts.isImportDeclaration(node)) {
                const clause = node.importClause;
                const typeOnly =
                    clause?.isTypeOnly ||
                    (clause?.namedBindings &&
                        ts.isNamedImports(clause.namedBindings) &&
                        clause.namedBindings.elements.length > 0 &&
                        clause.namedBindings.elements.every((element) => element.isTypeOnly));
                if (!typeOnly && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text);
            } else if (ts.isExportDeclaration(node)) {
                const typeOnly =
                    node.isTypeOnly ||
                    (node.exportClause &&
                        ts.isNamedExports(node.exportClause) &&
                        node.exportClause.elements.length > 0 &&
                        node.exportClause.elements.every((element) => element.isTypeOnly));
                if (!typeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text);
            } else if (
                ts.isCallExpression(node) &&
                node.arguments.length === 1 &&
                node.arguments[0] &&
                ts.isStringLiteral(node.arguments[0])
            ) {
                if (
                    node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                    (ts.isIdentifier(node.expression) && node.expression.text === "require")
                )
                    add(node.arguments[0].text);
            }
            ts.forEachChild(node, visit);
        };
        visit(source);

        graph.set(file, deps);
    }

    return graph;
}

function sourceFilesSyncExists(file: string): boolean {
    try {
        return ts.sys.fileExists(file);
    } catch {
        return false;
    }
}

describe("mobile packaging gate", () => {
    it("follows transitive value re-exports and dynamic imports", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "haritorax-architecture-"));
        try {
            const entry = path.join(root, "index.ts");
            await writeFile(entry, 'export { value } from "./barrel.js";');
            await writeFile(path.join(root, "barrel.ts"), 'export * from "@serialport/stream";\nvoid import("node:buffer");');

            const graph = await importGraph(entry);
            assert.deepEqual(graph.get(path.join(root, "index.ts")), [path.join(root, "barrel.ts")]);
            assert.deepEqual(graph.get(path.join(root, "barrel.ts")), ["@serialport/stream", "node:buffer"]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("root entry point reaches no Node-only module", async () => {
        const graph = await importGraph(path.join(SRC, "index.ts"));
        const offenders: string[] = [];

        for (const [file, deps] of graph) {
            for (const dep of deps) {
                if (!dep.startsWith("/") && NODE_ONLY.test(dep)) {
                    offenders.push(`${path.relative(ROOT, file)} -> ${dep}`);
                }
            }
        }

        assert.deepEqual(offenders, [], `root entry reaches Node-only modules: ${offenders.join(", ")}`);
    });

    it("root entry does not import connection implementations", async () => {
        // serial.ts and ble.ts are Node-only and live behind subpath exports.
        const graph = await importGraph(path.join(SRC, "index.ts"));
        const offenders = [...graph.keys()]
            .map((file) => path.relative(SRC, file))
            .filter((file) => {
                const normalised = file.split(path.sep).join("/");
                return normalised.startsWith("connections/") && normalised !== "connections/contract.ts";
            });

        assert.deepEqual(offenders, [], `root entry imports connection implementations: ${offenders.join(", ")}`);
    });
});

describe("architecture gates", () => {
    it("has no module-level mutable state", async () => {
        const MUTABLE_LET = /^(?:export\s+)?(?:let|var)\s+/;
        const MUTABLE_LITERAL =
            /^(?:export\s+)?const\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*(?:new\s+(?:Map|Set|WeakMap|WeakSet)\b|\[|\{)/;
        const FROZEN = /=\s*Object\.freeze\(/;
        const offenders: string[] = [];

        for (const file of await sourceFiles(SRC)) {
            const lines = (await readFile(file, "utf8")).split("\n");
            let inBlockComment = false;

            lines.forEach((line, index) => {
                const trimmed = line.trim();
                if (inBlockComment) {
                    if (trimmed.includes("*/")) inBlockComment = false;
                    return;
                }
                if (trimmed.startsWith("/*")) {
                    if (!trimmed.includes("*/")) inBlockComment = true;
                    return;
                }
                if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;

                // Module scope only: anything indented is inside a function or class.
                if (line !== line.trimStart()) return;
                if (FROZEN.test(trimmed)) return;

                if (MUTABLE_LET.test(trimmed) || MUTABLE_LITERAL.test(trimmed)) {
                    offenders.push(`${path.relative(SRC, file)}:${index + 1} ${trimmed}`);
                }
            });
        }

        assert.deepEqual(offenders, []);
    });

    it("keeps Buffer and ad-hoc base64 codecs out of everything but the wire layers", async () => {
        const offenders: string[] = [];
        const patterns: [RegExp, string][] = [
            [/\bBuffer\b/, "Buffer"],
            [/from\s+["']buffer["']/, 'import from "buffer"'],
            [/\b(?:atob|btoa)\b|toString\(\s*["']base64["']\s*\)/, "base64 codec"],
        ];

        // Connections own the arriving bytes; everything above them must not
        // hand-roll conversions. Base64 itself comes from `base64-js`.
        for (const file of await sourceFiles(SRC)) {
            const relative = path.relative(SRC, file);
            if (relative.startsWith(`connections${path.sep}`)) continue;

            const text = await readFile(file, "utf8");
            for (const [pattern, label] of patterns) {
                if (pattern.test(text)) offenders.push(`${relative} uses ${label}`);
            }
        }

        assert.deepEqual(offenders, []);
    });
});
