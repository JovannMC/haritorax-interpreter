#!/usr/bin/env node
/**
 * capture raw data from HaritoraX devices (trackers and dongle) over serial or BLE, printing to console or log file
 *
 * npx haritorax-trace                        # all discovered serial ports and BLE trackers, writes a log file
 * npx haritorax-trace --ports /dev/ttyUSB0   # specific endpoints (serial paths and/or BLE names)
 * npx haritorax-trace --log capture.txt      # custom log path
 * npx haritorax-trace --no-log               # console only
 * npx haritorax-trace --wired                # also list wired SPP ports
 * npx haritorax-trace --binding dbus         # force a noble binding (hci | dbus | mac | win)
 *
 */
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createBleConnection } from "./connections/ble/noble.js";
import type { Connection } from "./connections/contract.js";
import { createSerialConnection } from "./connections/serial/serial-node.js";
import { Logger } from "./lib/logging.js";

void (async () => {
    const { values } = parseArgs({
        options: {
            ports: { type: "string" },
            log: { type: "string" },
            "no-log": { type: "boolean", default: false },
            wired: { type: "boolean", default: false },
            binding: { type: "string" },
        },
    });

    const logPath = values["no-log"] ? undefined : (values.log ?? defaultLogPath());
    const logStream = logPath ? createWriteStream(logPath) : undefined;
    if (logStream) await once(logStream, "open");

    function writeLine(line: string, error = false): void {
        if (error) console.error(line);
        else console.log(line);
        logStream?.write(`${line}\n`);
    }

    if (logPath) writeLine(`Logging to ${resolve(logPath)}`);
    writeLine("Starting HaritoraX trace. Ctrl+C to stop.");

    const logger = new Logger("debug", (entry) => {
        const details = entry.data ? ` ${JSON.stringify(entry.data)}` : "";
        writeLine(`[${entry.level}] ${entry.message}${details}`, entry.level === "error" || entry.level === "warn");
    });

    const requested = values.ports?.split(",").map((port) => port.trim());
    const connections: Connection[] = [];
    const opened: string[] = [];
    const abort = new AbortController();
    let stopping = false;

    async function shutdown(code = 0): Promise<void> {
        if (stopping) return;
        stopping = true;
        abort.abort();

        await Promise.all(connections.map((connection) => connection.dispose().catch(() => {})));
        if (logStream && !logStream.destroyed) await new Promise<void>((resolve) => logStream.end(resolve));
        process.exit(code);
    }

    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
    logStream?.on("error", (error) => {
        console.error(`Failed to write ${logPath}: ${error.message}`);
        void shutdown(1);
    });

    async function capture(connection: Connection): Promise<void> {
        connections.push(connection);
        const isBle = connection.kind === "ble";

        connection.onData((frame) => {
            const id = isBle ? `${frame.endpointId}:${frame.characteristic}` : frame.endpointId;
            const text = isBle ? hex(frame.data) : ascii(frame.data);
            writeLine(`${id} - ${text}`);
        });
        connection.onLost((id, reason) => {
            writeLine(`Lost ${id}: ${reason}`, true);
        });

        writeLine(`Discovering ${isBle ? "BLE" : "serial"} endpoints...`);
        const discovered = await connection.list({ signal: abort.signal });
        if (stopping) return;
        const targets = requested
            ? discovered.filter((endpoint) => requested.includes(endpoint.id) || requested.includes(endpoint.displayName))
            : discovered;
        writeLine(`Found ${targets.length} matching ${connection.kind} endpoint(s).`);

        for (const target of targets) {
            if (stopping) return;
            writeLine(`Opening ${target.displayName} (${target.id})...`);
            try {
                await connection.open(target.id);
                opened.push(target.id);
                writeLine(`Watching ${target.id}`);
            } catch (error) {
                writeLine(`Failed to open ${target.id}: ${(error as Error).message}`, true);
            }
        }
    }

    try {
        await capture(createSerialConnection({ includeWired: values.wired, logger }));
    } catch (error) {
        writeLine(`Serial unavailable: ${(error as Error).message}`, true);
    }

    if (stopping) return;
    try {
        const binding = values.binding as "auto" | "hci" | "dbus" | "mac" | "win" | undefined;
        await capture(createBleConnection({ binding, logger }));
    } catch (error) {
        writeLine(`BLE unavailable, continuing with serial only: ${(error as Error).message}`, true);
    }

    if (stopping) return;
    if (opened.length === 0) {
        writeLine("No HaritoraX endpoints could be opened.", true);
        writeLine(requested ? `Requested: ${requested.join(", ")}` : "Are the trackers / dongles powered on?", true);
        await shutdown(1);
    } else {
        writeLine(`Watching ${opened.length} endpoint(s): ${opened.join(", ")}`);
    }
})().catch((error: unknown) => {
    console.error(`Trace failed: ${String(error)}`);
    process.exitCode = 1;
});

/*
 * helpers
 */

function defaultLogPath() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `HaritoraX-${stamp}.log`;
}

function ascii(bytes: Uint8Array) {
    let text = "";
    for (const byte of bytes) text += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".";
    return text;
}

function hex(bytes: Uint8Array) {
    let text = "";
    for (const byte of bytes) text += byte.toString(16).padStart(2, "0");
    return text;
}
