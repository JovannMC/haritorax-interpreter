#!/usr/bin/env node
/**
 * Logs raw serial frames from the GX dongles
 *
 *   pnpm build
 *   node test/rawdata-serial.mjs                      # all ports, writes a log file
 *   node test/rawdata-serial.mjs --only x             # IMU frames only
 *   node test/rawdata-serial.mjs --ports /dev/ttyUSB0
 *   node test/rawdata-serial.mjs --log capture.txt
 *   node test/rawdata-serial.mjs --no-log             # console only
 */
import { createWriteStream } from "node:fs";
import { parseArgs } from "node:util";
import { createSerialConnection } from "../dist/connections/serial/serial-node.js";

const { values } = parseArgs({
    options: {
        ports: { type: "string" },
        only: { type: "string" },
        log: { type: "string" },
        "no-log": { type: "boolean", default: false },
    },
});

const logPath = values["no-log"] ? undefined : (values.log ?? defaultLogPath());
const logStream = logPath ? createWriteStream(logPath) : undefined;

const serial = createSerialConnection();

let discovered;
try {
    discovered = await serial.list();
} catch (error) {
    console.error(`Could not list serial ports: ${error.message}`);
    process.exit(1);
}

const requested = values.ports?.split(",").map((port) => port.trim());
const targets = requested ? discovered.filter((endpoint) => requested.includes(endpoint.id)) : discovered;

if (targets.length === 0) {
    console.error("No GX dongle ports found.");
    console.error(requested ? `Requested: ${requested.join(", ")}` : "Is the dongle plugged in?");
    process.exit(1);
}

console.log(`Watching ${targets.length} port(s): ${targets.map((endpoint) => endpoint.id).join(", ")}`);
if (logPath) console.log(`logging to ${logPath}`);
console.log("Ctrl+C to stop.\n");

serial.onData((frame) => {
    const text = ascii(frame.data);
    const colon = text.indexOf(":");
    const identifier = colon === -1 ? text : text.slice(0, colon);

    if (values.only && !identifier.toLowerCase().startsWith(values.only.toLowerCase())) return;

    const line = `${frame.endpointId} - ${text}`;
    console.log(line);
    logStream?.write(`${line}\n`);
});

for (const target of targets) {
    try {
        await serial.open(target.id);
    } catch (error) {
        console.error(`Failed to open ${target.id}: ${error.message}`);
    }
}

let stopping = false;
async function shutdown() {
    if (stopping) return;
    stopping = true;

    for (const target of targets) await serial.close(target.id).catch(() => {});
    await serial.dispose();

    if (logStream) await new Promise((resolve) => logStream.end(resolve));
    process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

/*
 * helpers
 */

function defaultLogPath() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `rawdata-${stamp}.log`;
}

function ascii(bytes) {
    let text = "";
    for (const byte of bytes) text += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".";
    return text;
}
