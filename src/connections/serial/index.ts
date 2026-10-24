import { HaritoraXError } from "../../lib/errors.js";
import { Logger } from "../../lib/logging.js";
import { asciiDecode, asciiEncode, parseLine, splitLines } from "../../protocol/framing.js";
import { modelFromFirmware, parseInfo } from "../../protocol/messages.js";
import type { Connection, Frame, ListOptions } from "../contract.js";
import type { EndpointDescriptor, DisconnectReason, Unsubscribe } from "../../types.js";

export interface SerialPort {
    readonly isOpen: boolean;
    on(event: "data", listener: (chunk: Uint8Array) => void): void;
    on(event: "close", listener: () => void): void;
    on(event: "error", listener: (error: Error) => void): void;
    write(data: string, callback: (error?: Error | null) => void): void;
    close(callback?: (error?: Error | null) => void): void;
    removeAllListeners(): void;
}

export interface PortSummary {
    path: string;
    vendorId?: string | null;
    productId?: string | null;
    manufacturer?: string | null;
    pnpId?: string | null;
    serialNumber?: string | null;
}

export interface SerialBackend {
    list(): Promise<ReadonlyArray<PortSummary>>;
    open(path: string): Promise<SerialPort>;
}

export interface SerialOptions {
    logger?: Logger;
    heartbeatIntervalMs?: number;
    includeWired?: boolean;
}

const DONGLE_IDS: Readonly<Record<string, "GX6" | "GX2">> = Object.freeze({
    "1915:520f": "GX2",
    "04da:3f18": "GX6",
});

const OPEN_COMMANDS = Object.freeze(["r0:", "r1:", "r:", "o:"]);
const DELAYED_COMMANDS = Object.freeze(["i:", "i0:", "i1:", "o0:", "o1:", "v0:", "v1:"]);
const DELAYED_MS = 1_500;

const DONGLE_HEARTBEAT = Object.freeze(["i:"]);
const WIRED_HEARTBEAT = Object.freeze(["report send info\nblt send info"]);
const HEARTBEAT_MS = 5_000;

// on windows, serialport can't read BusReportedDesc (only place that shows "HaritoraX"), so have to list all SPP ports (shown as BTHENUM) and check each one for a heartbeat reply
const SPP_SERVICE_GUID = "00001101-0000-1000-8000-00805f9b34fb";
const SPP_TIMEOUT = 800;

const MAX_PENDING_BYTES = 64 * 1024;

interface OpenPort {
    port: SerialPort;
    pending: Uint8Array;
    timers: Array<ReturnType<typeof setTimeout>>;
    // true when close() was called by us, so the close event is not a loss
    intentional: boolean;
}

export class SerialConnection implements Connection {
    readonly kind = "serial" as const;

    readonly #backend: SerialBackend;
    readonly #log: Logger;
    readonly #heartbeatMs: number;
    readonly #includeWired: boolean;

    readonly #ports = new Map<string, OpenPort>();
    readonly #wiredEndpoints = new Set<string>();
    readonly #dataHandlers = new Set<(frame: Frame) => void>();
    readonly #lostHandlers = new Set<(endpointId: string, reason: DisconnectReason) => void>();

    constructor(backend: SerialBackend, options: SerialOptions = {}) {
        this.#backend = backend;
        this.#log = options.logger ?? new Logger("silent");
        this.#heartbeatMs = options.heartbeatIntervalMs ?? HEARTBEAT_MS;
        this.#includeWired = options.includeWired ?? false;
    }

    async list(options?: ListOptions): Promise<EndpointDescriptor[]> {
        if (options?.signal?.aborted) return [];

        const ports = await this.#backend.list().catch((error: unknown) => {
            if (error instanceof HaritoraXError) throw error;
            throw new HaritoraXError("LINK_UNAVAILABLE", "Failed to enumerate serial ports", { cause: error });
        });

        const endpoints: EndpointDescriptor[] = [];
        const wiredCandidates: PortSummary[] = [];

        for (const port of ports) {
            const dongle = DONGLE_IDS[`${port.vendorId}:${port.productId}`.toLowerCase()];
            if (dongle) {
                endpoints.push({ id: port.path, connection: this.kind, displayName: `${dongle} (${port.path})`, dongle });
            } else if (this.#includeWired && isWiredPort(port)) {
                wiredCandidates.push(port);
            }
        }

        for (const port of wiredCandidates) {
            if (await this.#probeWiredPort(port)) {
                this.#wiredEndpoints.add(port.path);
                endpoints.push({
                    id: port.path,
                    connection: this.kind,
                    displayName: `HaritoraX Wired (${port.path})`,
                    model: "wired" as const,
                });
            }
        }

        return endpoints;
    }

    // tries a port candidate to see if it is a wired device by sending a heartbeat and waiting for a reply
    async #probeWiredPort(port: PortSummary): Promise<boolean> {
        let handle: SerialPort | undefined;
        try {
            handle = await this.#backend.open(port.path);
            return await new Promise<boolean>((resolve) => {
                let settled = false;
                let pending: Uint8Array = new Uint8Array(0);

                const finish = (result: boolean): void => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    handle?.removeAllListeners();
                    resolve(result);
                };

                const timer = setTimeout(() => finish(false), SPP_TIMEOUT);

                handle?.on("data", (chunk: Uint8Array) => {
                    const { lines, rest } = splitLines(pending, chunk);
                    pending = rest;
                    for (const line of lines) {
                        const { identifier, payload } = parseLine(line);
                        if (identifier !== "i") continue;
                        const info = parseInfo(payload);
                        if (info && modelFromFirmware(info.model) === "wired") {
                            finish(true);
                            return;
                        }
                    }
                });
                handle?.on("close", () => finish(false));
                handle?.on("error", () => finish(false));

                if (handle) {
                    const target = handle;
                    this.#writeProbe(target, "report send info\nblt send info\n");
                }
            });
        } catch (error) {
            this.#log.debug(`Wired probe failed on ${port.path}`, { error: String(error) });
            return false;
        } finally {
            if (handle) this.#closeHandle(handle);
        }
    }

    #writeProbe(handle: SerialPort, data: string): Promise<void> {
        return new Promise((resolve) => {
            handle.write(data, (error) => {
                if (error) this.#log.debug(`Wired probe write failed: ${String(error)}`);
                resolve();
            });
        });
    }

    #closeHandle(handle: SerialPort): Promise<void> {
        handle.removeAllListeners();
        if (!handle.isOpen) return Promise.resolve();
        return new Promise((resolve) => handle.close(() => resolve()));
    }

    async open(endpointId: string): Promise<void> {
        if (this.#ports.has(endpointId)) return;

        const port = await this.#backend.open(endpointId).catch((error: unknown) => {
            if (error instanceof HaritoraXError) throw error;
            throw new HaritoraXError("CONNECTION_FAILED", `Failed to open ${endpointId}`, { cause: error });
        });

        const entry: OpenPort = { port, pending: new Uint8Array(0), timers: [], intentional: false };
        this.#ports.set(endpointId, entry);

        port.on("data", (chunk) => this.#onData(endpointId, chunk));
        port.on("close", () => this.#onClose(endpointId));
        port.on("error", (error) => this.#log.error(`Serial error on ${endpointId}`, { error: String(error) }));

        this.#send(endpointId, OPEN_COMMANDS);
        entry.timers.push(setTimeout(() => this.#send(endpointId, DELAYED_COMMANDS), DELAYED_MS));

        if (this.#heartbeatMs > 0) {
            const heartbeat = this.#wiredEndpoints.has(endpointId) ? WIRED_HEARTBEAT : DONGLE_HEARTBEAT;
            entry.timers.push(setInterval(() => this.#send(endpointId, heartbeat), this.#heartbeatMs));
        }
    }

    async close(endpointId: string): Promise<void> {
        const entry = this.#ports.get(endpointId);
        if (!entry) return;

        entry.intentional = true;
        this.#ports.delete(endpointId);
        for (const timer of entry.timers) clearTimeout(timer);

        try {
            entry.port.removeAllListeners();
            if (entry.port.isOpen) await new Promise<void>((resolve) => entry.port.close(() => resolve()));
        } catch (error) {
            this.#log.error(`Failed to close ${endpointId}`, { error: String(error) });
        }
    }

    write(endpointId: string, data: Uint8Array): Promise<void> {
        const entry = this.#ports.get(endpointId);
        if (!entry) return Promise.reject(new HaritoraXError("DEVICE_NOT_FOUND", `${endpointId} is not open`));

        // the dongle expects every command wrapped in newlines
        return new Promise((resolve, reject) => {
            entry.port.write(`\n${asciiDecode(data)}\n`, (error) => {
                if (error) reject(new HaritoraXError("WRITE_FAILED", `Failed to write to ${endpointId}`, { cause: error }));
                else resolve();
            });
        });
    }

    onData(handler: (frame: Frame) => void): Unsubscribe {
        this.#dataHandlers.add(handler);
        return () => this.#dataHandlers.delete(handler);
    }

    onLost(handler: (endpointId: string, reason: DisconnectReason) => void): Unsubscribe {
        this.#lostHandlers.add(handler);
        return () => this.#lostHandlers.delete(handler);
    }

    async dispose(): Promise<void> {
        for (const endpointId of [...this.#ports.keys()]) await this.close(endpointId);

        this.#dataHandlers.clear();
        this.#lostHandlers.clear();
    }

    /*
     * internals
     */

    #send(endpointId: string, commands: readonly string[]): void {
        for (const command of commands) {
            void this.write(endpointId, asciiEncode(command)).catch((error: unknown) => {
                this.#log.error(`Failed to send "${command}" to ${endpointId}`, { error: String(error) });
            });
        }
    }

    #onData(endpointId: string, chunk: Uint8Array): void {
        const entry = this.#ports.get(endpointId);
        if (!entry) return;

        const { lines, rest } = splitLines(entry.pending, chunk);
        entry.pending = rest.length > MAX_PENDING_BYTES ? new Uint8Array(0) : rest;

        if (entry.pending.length === 0 && rest.length > 0) {
            this.#log.warn(`Dropped ${rest.length} un-terminated bytes from ${endpointId}`);
        }

        for (const line of lines) {
            for (const handler of [...this.#dataHandlers]) handler({ endpointId, data: line });
        }
    }

    #onClose(endpointId: string): void {
        const entry = this.#ports.get(endpointId);
        if (!entry) return;

        this.#ports.delete(endpointId);
        for (const timer of entry.timers) clearTimeout(timer);

        if (entry.intentional) return;

        this.#log.warn(`Lost ${endpointId}`);
        for (const handler of [...this.#lostHandlers]) handler(endpointId, "remote");
    }
}

// annoying to detect wired trackers guh.
function isWiredPort(port: PortSummary): boolean {
    const path = port.path.toLowerCase();
    if (path.startsWith("/dev/rfcomm") || path.includes("haritora")) return true;

    if ((port.pnpId ?? "").toLowerCase().includes(SPP_SERVICE_GUID)) return true;

    const name = `${port.manufacturer ?? ""} ${port.pnpId ?? ""} ${port.serialNumber ?? ""}`.toLowerCase();
    return name.includes("haritora");
}
