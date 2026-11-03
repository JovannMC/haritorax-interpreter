import { HaritoraXError } from "../../lib/errors.js";
import { Logger } from "../../lib/logging.js";
import { asciiDecode, asciiEncode, parseLine, splitLines } from "../../protocol/codec/framing.js";
import { modelFromFirmware, parseInfo } from "../../protocol/codec/messages.js";
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
    list(options?: ListOptions): Promise<ReadonlyArray<PortSummary>>;
    open(path: string, signal?: AbortSignal): Promise<SerialPort>;
}

export interface SerialOptions {
    logger?: Logger;
    heartbeatIntervalMs?: number;
    includeWired?: boolean;
    serialPorts?: readonly string[];
    operationTimeoutMs?: number;
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

// on windows, serialport package can't read BusReportedDesc (only place that shows "HaritoraX"), so have to list all SPP ports (shown as BTHENUM) and check each one for a heartbeat reply
const SPP_SERVICE_GUID = "00001101-0000-1000-8000-00805f9b34fb";
const SPP_TIMEOUT = 800;
const DEFAULT_OPERATION_TIMEOUT_MS = 5_000;

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
    readonly #serialPorts: readonly string[];
    readonly #operationTimeoutMs: number;

    readonly #ports = new Map<string, OpenPort>();
    readonly #wiredEndpoints = new Set<string>();
    readonly #dataHandlers = new Set<(frame: Frame) => void>();
    readonly #lostHandlers = new Set<(endpointId: string, reason: DisconnectReason) => void>();

    constructor(backend: SerialBackend, options: SerialOptions = {}) {
        this.#backend = backend;
        this.#log = options.logger ?? new Logger("silent");
        this.#heartbeatMs = options.heartbeatIntervalMs ?? HEARTBEAT_MS;
        this.#includeWired = options.includeWired ?? false;
        this.#serialPorts = options.serialPorts ?? [];
        this.#operationTimeoutMs = Math.max(1, options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS);
    }

    async list(options?: ListOptions): Promise<EndpointDescriptor[]> {
        if (options?.signal?.aborted) return [];
        const deadlineAt = Date.now() + Math.min(options?.timeoutMs ?? this.#operationTimeoutMs, this.#operationTimeoutMs);
        const deadlineController = new AbortController();
        const signal = options?.signal ? AbortSignal.any([options.signal, deadlineController.signal]) : deadlineController.signal;
        const deadlineTimer = setTimeout(() => deadlineController.abort(), Math.max(1, deadlineAt - Date.now()));
        try {
            return await this.#listUntil({ ...options, signal }, deadlineAt);
        } finally {
            clearTimeout(deadlineTimer);
        }
    }

    async #listUntil(options: ListOptions, deadlineAt: number): Promise<EndpointDescriptor[]> {
        const signal = options.signal;
        const remaining = (): number => Math.max(1, deadlineAt - Date.now());

        let ports: ReadonlyArray<PortSummary> = [];
        try {
            ports = await withDeadline(this.#backend.list(options), remaining(), "Timed out enumerating serial ports", signal);
        } catch (error: unknown) {
            if (this.#serialPorts.length === 0) {
                if (error instanceof HaritoraXError) throw error;
                throw new HaritoraXError("LINK_UNAVAILABLE", "Failed to enumerate serial ports", { cause: error });
            }
            this.#log.warn("Serial enumeration failed, trying manually configured serial ports", { error: String(error) });
        }
        if (signal?.aborted) return [];

        const endpoints: EndpointDescriptor[] = [];
        const manualCandidates: PortSummary[] = [];
        const manualPaths = new Set(this.#serialPorts);
        const wiredCandidates: PortSummary[] = [];
        const detectedPaths = new Set<string>();
        const wiredEndpoints = new Set([...this.#ports.keys()].filter((path) => this.#wiredEndpoints.has(path)));

        for (const port of ports) {
            const dongle = DONGLE_IDS[`${port.vendorId}:${port.productId}`.toLowerCase()];
            if (dongle) {
                detectedPaths.add(port.path);
                this.#wiredEndpoints.delete(port.path);
                wiredEndpoints.delete(port.path);
                endpoints.push({ id: port.path, connection: this.kind, displayName: `${dongle} (${port.path})`, dongle });
            } else if (this.#includeWired && !manualPaths.has(port.path) && isWiredPort(port)) {
                wiredCandidates.push(port);
            }
        }

        for (const path of this.#serialPorts) {
            if (!detectedPaths.has(path)) manualCandidates.push({ path });
        }

        for (const port of manualCandidates) {
            if (signal?.aborted || Date.now() >= deadlineAt) return endpoints;
            if (this.#ports.has(port.path)) {
                const wired = this.#wiredEndpoints.has(port.path);
                if (wired) {
                    endpoints.push({
                        id: port.path,
                        connection: this.kind,
                        displayName: `HaritoraX Wired (${port.path})`,
                        model: "wired",
                    });
                } else {
                    endpoints.push({
                        id: port.path,
                        connection: this.kind,
                        displayName: `Serial (${port.path})`,
                    });
                }
                continue;
            }

            const probe = await this.#probeSerialPort(port, signal, remaining());
            if (probe.wired) {
                wiredEndpoints.add(port.path);
                endpoints.push({
                    id: port.path,
                    connection: this.kind,
                    displayName: `HaritoraX Wired (${port.path})`,
                    model: "wired" as const,
                });
            } else {
                endpoints.push({
                    id: port.path,
                    connection: this.kind,
                    displayName: `Serial (${port.path})`,
                });
            }
        }

        for (const port of wiredCandidates) {
            if (signal?.aborted || Date.now() >= deadlineAt) return endpoints;
            if (this.#ports.has(port.path)) {
                if (this.#wiredEndpoints.has(port.path)) {
                    endpoints.push({
                        id: port.path,
                        connection: this.kind,
                        displayName: `HaritoraX Wired (${port.path})`,
                        model: "wired",
                    });
                }
                continue;
            }

            if ((await this.#probeSerialPort(port, signal, remaining())).wired) {
                wiredEndpoints.add(port.path);
                endpoints.push({
                    id: port.path,
                    connection: this.kind,
                    displayName: `HaritoraX Wired (${port.path})`,
                    model: "wired" as const,
                });
            }
        }

        this.#wiredEndpoints.clear();
        for (const path of wiredEndpoints) this.#wiredEndpoints.add(path);

        return endpoints;
    }

    // tries a port candidate by sending both the wired and generic serial info requests.
    async #probeSerialPort(
        port: PortSummary,
        signal?: AbortSignal,
        timeoutMs = this.#operationTimeoutMs,
    ): Promise<{ wired: boolean }> {
        if (signal?.aborted) return { wired: false };
        let handle: SerialPort | undefined;
        try {
            handle = await openWithLateCleanup(this.#backend.open(port.path, signal), timeoutMs, signal);
            return await new Promise<{ wired: boolean }>((resolve) => {
                let settled = false;
                let pending: Uint8Array = new Uint8Array(0);
                const timer = setTimeout(() => finish({ wired: false }), Math.min(SPP_TIMEOUT, timeoutMs));

                const finish = (result: { wired: boolean }): void => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    signal?.removeEventListener("abort", onAbort);
                    handle?.removeAllListeners();
                    resolve(result);
                };

                const onAbort = (): void => finish({ wired: false });
                signal?.addEventListener("abort", onAbort, { once: true });
                if (signal?.aborted) {
                    finish({ wired: false });
                    return;
                }

                handle?.on("data", (chunk: Uint8Array) => {
                    const { lines, rest } = splitLines(pending, chunk);
                    pending = rest;
                    if (pending.length > MAX_PENDING_BYTES) {
                        finish({ wired: false });
                        return;
                    }
                    for (const line of lines) {
                        const { identifier, payload } = parseLine(line);
                        if (identifier !== "i") continue;
                        const info = parseInfo(payload);
                        if (!info) continue;
                        let wired = false;
                        try {
                            wired = modelFromFirmware(info.model) === "wired";
                        } catch {
                            // unknown firmware is still a valid response for a manual port
                        }
                        finish({ wired });
                        return;
                    }
                });
                handle?.on("close", () => finish({ wired: false }));
                handle?.on("error", () => finish({ wired: false }));

                if (handle) {
                    const target = handle;
                    void this.#writeProbe(target, "report send info\nblt send info\n")
                        .then(() => (settled ? undefined : this.#writeProbe(target, "i:\n")))
                        .catch((error: unknown) => {
                            this.#log.debug(`Wired probe write failed: ${String(error)}`);
                            finish({ wired: false });
                        });
                }
            });
        } catch (error) {
            this.#log.debug(`Wired probe failed on ${port.path}`, { error: String(error) });
            return { wired: false };
        } finally {
            if (handle) await this.#closeHandle(handle);
        }
    }

    #writeProbe(handle: SerialPort, data: string): Promise<void> {
        return withDeadline(
            new Promise<void>((resolve, reject) => {
                handle.write(data, (error) => {
                    if (error) {
                        this.#log.debug(`Wired probe write failed: ${String(error)}`);
                        reject(error);
                    } else resolve();
                });
            }),
            this.#operationTimeoutMs,
            "Timed out writing to serial probe",
        );
    }

    #closeHandle(handle: SerialPort): Promise<void> {
        handle.removeAllListeners();
        if (!handle.isOpen) return Promise.resolve();
        return withDeadline(
            new Promise<void>((resolve, reject) => handle.close((error) => (error ? reject(error) : resolve()))),
            this.#operationTimeoutMs,
            "Timed out closing serial probe",
        );
    }

    async open(endpointId: string): Promise<void> {
        if (this.#ports.has(endpointId)) return;

        const port = await openWithLateCleanup(this.#backend.open(endpointId), this.#operationTimeoutMs).catch(
            (error: unknown) => {
                if (error instanceof HaritoraXError) throw error;
                throw new HaritoraXError("CONNECTION_FAILED", `Failed to open ${endpointId}`, { cause: error });
            },
        );

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
            if (entry.port.isOpen) {
                await withDeadline(
                    new Promise<void>((resolve, reject) => entry.port.close((error) => (error ? reject(error) : resolve()))),
                    this.#operationTimeoutMs,
                    `Timed out closing ${endpointId}`,
                );
            }
        } catch (error) {
            this.#log.error(`Failed to close ${endpointId}`, { error: String(error) });
        }
    }

    write(endpointId: string, data: Uint8Array): Promise<void> {
        const entry = this.#ports.get(endpointId);
        if (!entry) return Promise.reject(new HaritoraXError("DEVICE_NOT_FOUND", `${endpointId} is not open`));

        // the dongle expects every command wrapped in newlines
        return withDeadline(
            new Promise<void>((resolve, reject) => {
                entry.port.write(`\n${asciiDecode(data)}\n`, (error) => {
                    if (error) reject(new HaritoraXError("WRITE_FAILED", `Failed to write to ${endpointId}`, { cause: error }));
                    else resolve();
                });
            }),
            this.#operationTimeoutMs,
            `Timed out writing to ${endpointId}`,
        );
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

function withDeadline<T>(operation: Promise<T>, timeoutMs: number, message: string, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new HaritoraXError("LINK_UNAVAILABLE", message));
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            callback();
        };
        const onAbort = (): void => finish(() => reject(new HaritoraXError("LINK_UNAVAILABLE", message)));
        const timer = setTimeout(() => finish(() => reject(new HaritoraXError("LINK_UNAVAILABLE", message))), timeoutMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        operation.then(
            (value) => finish(() => resolve(value)),
            (error: unknown) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
        );
    });
}

async function openWithLateCleanup(operation: Promise<SerialPort>, timeoutMs: number, signal?: AbortSignal): Promise<SerialPort> {
    let waiting = true;
    const guarded = operation.then((port) => {
        if (!waiting) void closeLatePort(port);
        return port;
    });
    try {
        return await withDeadline(guarded, timeoutMs, "Timed out opening serial port", signal);
    } finally {
        waiting = false;
    }
}

function closeLatePort(port: SerialPort): void {
    try {
        port.removeAllListeners();
        if (port.isOpen) port.close(() => {});
    } catch {
        // ignore
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
