import { autoDetect } from "@serialport/bindings-cpp";
import { SerialPortStream } from "@serialport/stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SerialConnection } from "./index.js";
import type { SerialBackend, SerialOptions } from "./index.js";
import type { Connection } from "../contract.js";

// from haritora_setting.json in HaritoraConfigurator
const BAUD_RATE = 500_000;
const execFileAsync = promisify(execFile);

export interface NodeSerialOptions extends SerialOptions {
    backend?: SerialBackend;
    autoBindWired?: boolean;
}

export function createSerialConnection(options: NodeSerialOptions = {}): Connection {
    return new SerialConnection(options.backend ?? createNodeBackend(options), options);
}

function createNodeBackend(options: NodeSerialOptions): SerialBackend {
    const binding = autoDetect();

    return {
        list: async () => {
            if (options.autoBindWired) await autoBindWiredPorts();
            return binding.list();
        },
        open: (path) => Promise.resolve(new SerialPortStream({ path, baudRate: BAUD_RATE, binding })),
    };
}

async function autoBindWiredPorts(): Promise<void> {
    if (process.platform !== "linux") return;

    const devices = await runCommand("bluetoothctl", ["devices", "Paired"]).catch(() => "");
    const candidates = [...devices.matchAll(/^Device\s+([0-9a-f:]{17})\s+(.+)$/gim)].filter((match) =>
        /haritora/i.test(match[2] ?? ""),
    );

    for (const candidate of candidates) {
        const address = candidate[1];
        if (!address) continue;

        const info = await runCommand("bluetoothctl", ["info", address]).catch(() => "");
        if (!/Connected:\s+yes/i.test(info)) continue;

        const records = await runCommand("sdptool", ["browse", address]).catch(() => "");
        if (!hasSerialPortService(records)) continue;

        const channel = /Channel:\s*(\d+)/i.exec(records)?.[1];
        if (!channel) continue;

        const device = await firstFreeRfcommDevice();
        if (device === undefined) return;

        await runCommand("rfcomm", ["bind", String(device), address, channel]).catch(() => undefined);
    }
}

function hasSerialPortService(records: string): boolean {
    return /Serial Port|0x1101|00001101-0000-1000-8000-00805f9b34fb/i.test(records);
}

async function firstFreeRfcommDevice(): Promise<number | undefined> {
    const existing = await runCommand("rfcomm", ["-a"]).catch(() => "");
    const used = new Set(
        [...existing.matchAll(/rfcomm(\d+):/gi)].map((match) => Number.parseInt(match[1] ?? "", 10)).filter(Number.isInteger),
    );

    for (let device = 0; device < 16; device++) {
        if (!used.has(device)) return device;
    }
    return undefined;
}

async function runCommand(command: string, args: string[]): Promise<string> {
    const result = await execFileAsync(command, args, { encoding: "utf8" });
    return result.stdout;
}

export type { PortSummary, SerialBackend, SerialOptions, SerialPort } from "./index.js";
