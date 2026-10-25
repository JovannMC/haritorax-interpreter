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
import { parseArgs } from "node:util";
import { createBleConnection } from "./connections/ble/noble.js";
import type { Connection } from "./connections/contract.js";
import { createSerialConnection } from "./connections/serial/serial-node.js";
import type { EndpointDescriptor } from "./types.js";

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

    const requested = values.ports?.split(",").map((port) => port.trim());

    const connections: Array<{ connection: Connection; targets: EndpointDescriptor[] }> = [];

    const serial = createSerialConnection(values.wired ? { includeWired: true } : undefined);
    try {
        const targets = await listTargets(serial, requested);
        if (targets.length > 0) connections.push({ connection: serial, targets });
    } catch (error) {
        console.error(`Could not list serial ports: ${(error as Error).message}`);
        process.exit(1);
    }

    try {
        const binding = values.binding as "auto" | "hci" | "dbus" | "mac" | "win" | undefined;
        const ble = createBleConnection(binding ? { binding } : undefined);
        const targets = await listTargets(ble, requested);
        if (targets.length > 0) connections.push({ connection: ble, targets });
    } catch (error) {
        console.error(`BLE unavailable, continuing with serial only: ${(error as Error).message}`);
    }

    if (connections.length === 0) {
        console.error("No HaritoraX endpoints found.");
        console.error(requested ? `Requested: ${requested.join(", ")}` : "Are the trackers / dongles powered on?");
        process.exit(1);
    }

    const allTargets = connections.flatMap((entry) => entry.targets);
    console.log(`Watching ${allTargets.length} endpoint(s): ${allTargets.map((endpoint) => endpoint.id).join(", ")}`);
    if (logPath) console.log(`logging to ${logPath}`);
    console.log("Ctrl+C to stop.\n");

    for (const { connection, targets } of connections) {
        const isBle = connection.kind === "ble";

        connection.onData((frame) => {
            const id = isBle ? `${frame.endpointId}:${frame.characteristic}` : frame.endpointId;
            const text = isBle ? hex(frame.data) : ascii(frame.data);

            const line = `${id} - ${text}`;
            console.log(line);
            logStream?.write(`${line}\n`);
        });

        for (const target of targets) {
            try {
                await connection.open(target.id);
            } catch (error) {
                console.error(`Failed to open ${target.id}: ${(error as Error).message}`);
            }
        }
    }

    let stopping = false;
    async function shutdown() {
        if (stopping) return;
        stopping = true;

        for (const { connection, targets } of connections) {
            for (const target of targets) await connection.close(target.id).catch(() => {});
            await connection.dispose().catch(() => {});
        }

        if (logStream) await new Promise((resolve) => logStream.end(resolve));
        process.exit(0);
    }

    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
})();

/*
 * helpers
 */

async function listTargets(connection: Connection, requested: string[] | undefined) {
    const discovered = await connection.list();
    return requested ? discovered.filter((endpoint) => requested.includes(endpoint.id)) : discovered;
}

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
