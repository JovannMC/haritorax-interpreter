import { HaritoraXError } from "./errors.js";
import { Logger, type LogSink } from "./logging.js";
import { Emitter } from "./emitter.js";
import { parseLine } from "./protocol/framing.js";
import type { Connection, Frame, ListOptions } from "./connections/contract.js";
import type {
    DeviceDescriptor,
    DisconnectReason,
    EventHandler,
    Events,
    LogLevel,
    TrackerSnapshot,
    Unsubscribe,
} from "./types.js";

export interface HaritoraXOptions {
    connections?: Connection[];
    logLevel?: LogLevel;
    onLog?: LogSink;
}

export class HaritoraX {
    readonly #emitter = new Emitter();
    readonly #log: Logger;
    readonly #connections: Connection[];

    #endpoints: DeviceDescriptor[] = [];
    readonly #endpointOwners = new Map<string, Connection>();
    readonly #open = new Set<string>();
    readonly #devices = new Map<string, TrackerSnapshot>();
    readonly #subscriptions: Unsubscribe[] = [];

    #discovery: AbortController | undefined;

    constructor(options: HaritoraXOptions = {}) {
        this.#connections = options.connections ?? [];
        this.#log = new Logger(
            options.logLevel ?? "info",
            options.onLog ?? ((entry) => console.log(`[${entry.level}] ${entry.message}`)),
        );
        this.#emitter.setErrorHandler((event, error) =>
            this.#log.error(`Listener for "${event}" threw`, { error: String(error) }),
        );

        for (const connection of this.#connections) {
            this.#subscriptions.push(connection.onData((frame) => this.#onFrame(frame)));
            this.#subscriptions.push(connection.onLost((endpointId, reason) => this.#onLost(endpointId, reason)));
        }
    }

    /*
     * device discovery and connection
     */

    // check what endpoints every connection can see, serial ports and BLE peripherals
    async discover(options?: ListOptions): Promise<DeviceDescriptor[]> {
        this.#discovery?.abort();
        const controller = new AbortController();
        this.#discovery = controller;

        const results = await Promise.all(
            this.#connections.map(async (connection) => {
                try {
                    return { connection, found: await connection.list({ ...options, signal: controller.signal }) };
                } catch (error) {
                    this.#log.error(`Discovery failed for "${connection.kind}"`, { error: String(error) });
                    this.#emitter.emit("error", { error: toError(error) });
                    return { connection, found: [] as DeviceDescriptor[] };
                }
            }),
        );

        const merged = new Map<string, DeviceDescriptor>();
        this.#endpointOwners.clear();

        for (const { connection, found } of results) {
            for (const descriptor of found) {
                merged.set(descriptor.id, descriptor);
                this.#endpointOwners.set(descriptor.id, connection);
            }
        }

        this.#endpoints = [...merged.values()];

        this.#log.info(`Discovered ${this.#endpoints.length} endpoint(s)`, {
            ids: this.#endpoints.map((descriptor) => descriptor.id).join(","),
        });

        return this.#endpoints;
    }

    stopDiscovery(): Promise<void> {
        this.#discovery?.abort();
        this.#discovery = undefined;
        return Promise.resolve();
    }

    getEndpoints(): DeviceDescriptor[] {
        return [...this.#endpoints];
    }

    getDevices(): TrackerSnapshot[] {
        return [...this.#devices.values()];
    }

    getDevice(deviceId: string): TrackerSnapshot | undefined {
        return this.#devices.get(deviceId);
    }

    async connect(endpointId: string): Promise<void> {
        const connection = this.#endpointOwners.get(endpointId);
        if (!connection) {
            throw new HaritoraXError("DEVICE_NOT_FOUND", `Unknown endpoint "${endpointId}", call discover() first`);
        }

        if (this.#open.has(endpointId)) return;

        await connection.open(endpointId);
        this.#open.add(endpointId);
        this.#emitter.emit("device:connected", { deviceId: endpointId });
        this.#log.info(`Connected ${endpointId}`);
    }

    async disconnect(endpointId: string): Promise<void> {
        if (!this.#open.delete(endpointId)) return;

        await this.#endpointOwners.get(endpointId)?.close(endpointId);
        this.#emitter.emit("device:disconnected", { deviceId: endpointId, reason: "requested" });
        this.#log.info(`Disconnected ${endpointId}`);
    }

    /*
     * listeners and disposal
     */

    async dispose(): Promise<void> {
        this.#discovery?.abort();
        this.#discovery = undefined;

        for (const unsubscribe of this.#subscriptions) unsubscribe();
        this.#subscriptions.length = 0;

        await Promise.all(
            this.#connections.map((connection) =>
                connection.dispose().catch((error: unknown) => {
                    this.#log.error(`Connection "${connection.kind}" failed to dispose`, { error: String(error) });
                }),
            ),
        );

        this.#emitter.removeAllListeners();
        this.#open.clear();
        this.#endpoints = [];
        this.#endpointOwners.clear();
        this.#devices.clear();
        this.#log.info("Disposed");
    }

    on<E extends keyof Events>(event: E, handler: EventHandler<E>): Unsubscribe {
        return this.#emitter.on(event, handler);
    }

    /*
     * internal stuff
     */

    #onFrame(frame: Frame): void {
        if (!this.#log.enabled("debug")) return;

        const { identifier, payload } = parseLine(frame.data);
        this.#log.debug(`Frame ${identifier || "(none)"} from ${frame.endpointId}`, {
            bytes: frame.data.length,
            payload: payload.length > 120 ? `${payload.slice(0, 120)}…` : payload,
        });
    }

    #onLost(endpointId: string, reason: DisconnectReason): void {
        if (!this.#open.delete(endpointId)) return;

        this.#emitter.emit("device:disconnected", { deviceId: endpointId, reason });
    }
}

export function createHaritoraX(options?: HaritoraXOptions): HaritoraX {
    return new HaritoraX(options);
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}
