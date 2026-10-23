import { HaritoraXError } from "./lib/errors.js";
import { Logger, type LogSink } from "./lib/logging.js";
import { Emitter } from "./lib/emitter.js";
import { DeviceRegistry } from "./core/device-registry.js";
import { DongleController } from "./core/dongle-controller.js";
import { asciiEncode, parseIdentifier, parseLine } from "./protocol/framing.js";
import type { Connection, Frame, ListOptions } from "./connections/contract.js";
import type {
    BodyPart,
    EndpointDescriptor,
    DisconnectReason,
    EventHandler,
    Events,
    LogLevel,
    DeviceSnapshot,
    TrackerSnapshot,
    Unsubscribe,
} from "./types.js";

export class HaritoraX {
    readonly #emitter = new Emitter();
    readonly #log: Logger;
    readonly #connections: Connection[];
    readonly #registry: DeviceRegistry;
    readonly #dongle: DongleController;

    #endpoints: EndpointDescriptor[] = [];
    readonly #endpointOwners = new Map<string, Connection>();
    readonly #open = new Set<string>();
    readonly #subscriptions: Unsubscribe[] = [];

    #discovery: AbortController | undefined;

    constructor(options: HaritoraXOptions = {}) {
        this.#connections = options.connections ?? [];
        this.#log = new Logger(options.logLevel ?? "info", (entry) => {
            if (options.onLog) options.onLog(entry);
            else console.log(`[${entry.level}] ${entry.message}`);
            this.#emitter.emit("log", entry);
        });
        this.#emitter.setErrorHandler((event, error) => {
            // Logging from a throwing "log" listener would recurse forever.
            if (event === "log") return;
            this.#log.error(`Listener for "${event}" threw`, { error: String(error) });
        });

        this.#registry = new DeviceRegistry({ emitter: this.#emitter, log: this.#log });
        this.#dongle = new DongleController({
            emitter: this.#emitter,
            log: this.#log,
            registry: this.#registry,
            isOpen: (endpointId) => this.#open.has(endpointId),
            connectionKind: (endpointId) => this.#endpointOwners.get(endpointId)?.kind ?? "serial",
            write: (endpointId, command) => this.#writeCommand(endpointId, command),
            onChannel: (endpointId, channel) => this.#applyChannel(endpointId, channel),
        });

        for (const connection of this.#connections) {
            this.#subscriptions.push(connection.onData((frame) => this.#onFrame(frame)));
            this.#subscriptions.push(connection.onLost((endpointId, reason) => this.#onLost(endpointId, reason)));
        }
    }

    /*
     * device discovery and connection
     */

    // check what endpoints every connection can see, serial ports and BLE peripherals
    async discover(options?: ListOptions): Promise<EndpointDescriptor[]> {
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
                    return { connection, found: [] as EndpointDescriptor[] };
                }
            }),
        );

        const merged = new Map<string, EndpointDescriptor>();
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

    getEndpoints(): EndpointDescriptor[] {
        return [...this.#endpoints];
    }

    getDevices(): DeviceSnapshot[] {
        return this.#registry.listDevices();
    }

    getDevice(deviceId: string): DeviceSnapshot | undefined {
        return this.#registry.getDevice(deviceId);
    }

    getTrackers(): TrackerSnapshot[] {
        return this.#registry.listTrackers();
    }

    getTracker(trackerId: string): TrackerSnapshot | undefined {
        return this.#registry.getTracker(trackerId);
    }

    getBodyPart(trackerId: string): BodyPart | undefined {
        return this.#registry.getBodyPart(trackerId);
    }

    /*
     * dongle control
     */

    getChannel(endpointId: string): number | undefined {
        return this.#dongle.getChannel(endpointId);
    }

    setChannel(endpointId: string, channel: number): Promise<void> {
        return this.#dongle.setChannel(endpointId, channel);
    }

    pair(endpointId: string, slot: string | number): Promise<void> {
        return this.#dongle.pair(endpointId, slot);
    }

    unpair(endpointId: string, slot: string | number): Promise<void> {
        return this.#dongle.unpair(endpointId, slot);
    }

    async connect(endpointId: string): Promise<void> {
        const connection = this.#endpointOwners.get(endpointId);
        if (!connection) {
            throw new HaritoraXError("DEVICE_NOT_FOUND", `Unknown endpoint "${endpointId}", call discover() first`);
        }

        if (this.#open.has(endpointId)) return;

        await connection.open(endpointId);
        this.#open.add(endpointId);

        const descriptor = this.#endpoints.find((endpoint) => endpoint.id === endpointId);
        this.#emitter.emit("endpoint:connected", {
            endpointId,
            connection: connection.kind,
            displayName: descriptor?.displayName ?? endpointId,
        });
        this.#log.info(`Connected ${endpointId}`);
    }

    async disconnect(endpointId: string): Promise<void> {
        if (!this.#open.delete(endpointId)) return;

        await this.#endpointOwners.get(endpointId)?.close(endpointId);
        this.#dropEndpoint(endpointId, "requested");
        this.#log.info(`Disconnected ${endpointId}`);
    }

    /*
     * listeners and disposal
     */

    async dispose(): Promise<void> {
        this.#discovery?.abort();
        this.#discovery = undefined;
        this.#dongle.dispose();

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
        this.#registry.dispose();
        this.#log.info("Disposed");
    }

    on<E extends keyof Events>(event: E, handler: EventHandler<E>): Unsubscribe {
        return this.#emitter.on(event, handler);
    }

    /*
     * internal stuff
     */

    #onFrame(frame: Frame): void {
        let identifier = "";

        try {
            const line = parseLine(frame.data);
            identifier = line.identifier;
            const { payload } = line;

            if (this.#log.enabled("debug")) {
                this.#log.debug(`Frame ${identifier || "(none)"} from ${frame.endpointId}`, {
                    bytes: frame.data.length,
                    payload: payload.length > 120 ? `${payload.slice(0, 120)}…` : payload,
                });
            }

            const parsed = parseIdentifier(identifier);
            if (!parsed) return;

            this.#dongle.handleFrame(frame.endpointId, parsed.name, parsed.slot, payload);
        } catch (error) {
            this.#log.warn(`Failed to handle "${identifier || "(unknown)"}" from ${frame.endpointId}`, {
                error: String(error),
            });
        }
    }

    #applyChannel(endpointId: string, channel: number): void {
        const descriptor = this.#endpoints.find((endpoint) => endpoint.id === endpointId);
        if (descriptor) descriptor.channel = channel;

        this.#log.info(`Channel of ${endpointId} is ${channel}`);
        this.#emitter.emit("channel", { endpointId, channel });
    }

    async #writeCommand(endpointId: string, command: string): Promise<void> {
        const connection = this.#endpointOwners.get(endpointId);
        if (!connection) throw new HaritoraXError("DEVICE_NOT_FOUND", `Unknown endpoint "${endpointId}"`);

        return connection.write(endpointId, asciiEncode(command));
    }

    #dropEndpoint(endpointId: string, reason: DisconnectReason): void {
        this.#registry.removeDevicesAtEndpoint(endpointId, reason);
        this.#dongle.forgetEndpoint(endpointId);
        this.#emitter.emit("endpoint:disconnected", { endpointId, reason });
    }

    #onLost(endpointId: string, reason: DisconnectReason): void {
        if (!this.#open.delete(endpointId)) return;
        this.#dropEndpoint(endpointId, reason);
    }
}

export function createHaritoraX(options?: HaritoraXOptions): HaritoraX {
    return new HaritoraX(options);
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

/*
 * types
 */

export interface HaritoraXOptions {
    connections?: Connection[];
    logLevel?: LogLevel;
    onLog?: LogSink;
}
