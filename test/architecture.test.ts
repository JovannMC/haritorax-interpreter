import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

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
 * Walks the static import graph from src/index.ts. Type-only imports are
 * skipped: they are erased at build time and cannot pull a runtime dependency
 * into a bundle.
 */
async function importGraph(entry: string): Promise<Map<string, string[]>> {
    const graph = new Map<string, string[]>();
    const queue = [entry];

    while (queue.length > 0) {
        const file = queue.pop();
        if (!file || graph.has(file)) continue;

        const text = await readFile(file, "utf8");
        const deps: string[] = [];

        for (const match of text.matchAll(/^import\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gm)) {
            if (match[1]) continue; // type-only
            const specifier = match[2];
            if (!specifier) continue;

            if (!specifier.startsWith(".")) {
                deps.push(specifier);
                continue;
            }

            const resolved = path.resolve(path.dirname(file), specifier.replace(/\.js$/, ".ts"));
            deps.push(resolved);
            queue.push(resolved);
        }

        graph.set(file, deps);
    }

    return graph;
}

describe("mobile packaging gate", () => {
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
