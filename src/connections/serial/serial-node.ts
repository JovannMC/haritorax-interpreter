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
    const operationTimeoutMs = options.operationTimeoutMs ?? 5_000;

    return {
        list: async (listOptions) => {
            if (options.autoBindWired) await autoBindWiredPorts(listOptions?.signal, operationTimeoutMs);
            return waitWithDeadline(
                binding.list(),
                operationTimeoutMs,
                "Timed out enumerating serial ports",
                listOptions?.signal,
            );
        },
        open: async (path, signal) => {
            const port = new SerialPortStream({ path, baudRate: BAUD_RATE, binding, autoOpen: false });
            const opening = new Promise<void>((resolve, reject) => {
                port.open((error) => (error ? reject(error) : resolve()));
            });
            try {
                await waitWithDeadline(opening, operationTimeoutMs, `Timed out opening ${path}`, signal);
                return port;
            } catch (error) {
                void opening.then(
                    () => {
                        if (port.isOpen) port.close(() => {});
                    },
                    () => {},
                );
                throw error;
            }
        },
    };
}

async function autoBindWiredPorts(signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
    if (process.platform !== "linux") return;

    const devices = await runCommand("bluetoothctl", ["devices", "Paired"], timeoutMs, signal).catch(() => "");
    const candidates = [...devices.matchAll(/^Device\s+([0-9a-f:]{17})\s+(.+)$/gim)].filter((match) =>
        /haritora/i.test(match[2] ?? ""),
    );

    for (const candidate of candidates) {
        const address = candidate[1];
        if (!address) continue;

        const info = await runCommand("bluetoothctl", ["info", address], timeoutMs, signal).catch(() => "");
        if (!/Connected:\s+yes/i.test(info)) continue;

        const records = await runCommand("sdptool", ["browse", address], timeoutMs, signal).catch(() => "");
        if (!hasSerialPortService(records)) continue;

        const channel = /Channel:\s*(\d+)/i.exec(records)?.[1];
        if (!channel) continue;

        const device = await firstFreeRfcommDevice(timeoutMs, signal);
        if (device === undefined) return;

        await runCommand("rfcomm", ["bind", String(device), address, channel], timeoutMs, signal).catch(() => undefined);
    }
}

function hasSerialPortService(records: string): boolean {
    return /Serial Port|0x1101|00001101-0000-1000-8000-00805f9b34fb/i.test(records);
}

async function firstFreeRfcommDevice(timeoutMs: number, signal?: AbortSignal): Promise<number | undefined> {
    const existing = await runCommand("rfcomm", ["-a"], timeoutMs, signal).catch(() => "");
    const used = new Set(
        [...existing.matchAll(/rfcomm(\d+):/gi)].map((match) => Number.parseInt(match[1] ?? "", 10)).filter(Number.isInteger),
    );

    for (let device = 0; device < 16; device++) {
        if (!used.has(device)) return device;
    }
    return undefined;
}

async function runCommand(command: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
    const result = await execFileAsync(command, args, { encoding: "utf8", timeout: timeoutMs, signal });
    return result.stdout;
}

function waitWithDeadline<T>(operation: Promise<T>, timeoutMs: number, message: string, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new Error(message));
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            callback();
        };
        const onAbort = (): void => finish(() => reject(new Error(message)));
        const timer = setTimeout(() => finish(() => reject(new Error(message))), timeoutMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        operation.then(
            (value) => finish(() => resolve(value)),
            (error: unknown) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
        );
    });
}

export type { PortSummary, SerialBackend, SerialOptions, SerialPort } from "./index.js";
