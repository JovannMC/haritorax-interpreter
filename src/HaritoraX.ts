import { HaritoraXError } from "./lib/errors.js";
import { Logger, type LogSink } from "./lib/logging.js";
import { Emitter } from "./lib/emitter.js";
import { copyDeviceSnapshot, copyTrackerSnapshot, DeviceRegistry } from "./core/device-registry.js";
import { DongleController } from "./core/controller/dongle-controller.js";
import { WiredController } from "./core/controller/wired-controller.js";
import { BleController } from "./core/controller/ble-controller.js";
import type { ProtocolHandler } from "./core/protocol-handler.js";
import { asciiEncode, parseIdentifier, parseLine } from "./protocol/codec/framing.js";
import type { BleCharacteristic } from "./protocol/endpoint/ble.js";
import { bodyPartBaseLocked, baseLockRemovedIn } from "./protocol/firmware.js";
import type { Connection, Frame, ListOptions } from "./connections/contract.js";
import type {
    BodyPart,
    ConnectionKind,
    EndpointDescriptor,
    DisconnectReason,
    EventHandler,
    Events,
    LogLevel,
    DeviceSnapshot,
    TrackerSnapshot,
    TrackerSettings,
    Unsubscribe,
} from "./types.js";

export class HaritoraX {
    readonly #emitter = new Emitter();
    readonly #log: Logger;
    readonly #connections: Connection[];
    readonly #registry: DeviceRegistry;
    readonly #dongle: DongleController;
    readonly #wired: WiredController;
    readonly #ble: BleController;
    readonly #handlers = new Map<string, ProtocolHandler>();

    #endpoints: EndpointDescriptor[] = [];
    readonly #endpointOwners = new Map<string, Connection>();
    readonly #open = new Set<string>();
    readonly #subscriptions: Unsubscribe[] = [];
    readonly #endpointOperations = new Map<string, Promise<void>>();

    #scanController: AbortController | undefined;
    #scanning: Promise<EndpointDescriptor[]> | undefined;
    #scanGeneration = 0;
    #disposed = false;

    constructor(options: HaritoraXOptions = {}) {
        this.#connections = options.connections ?? [];
        this.#log = options.logger ?? new Logger(options.logLevel ?? "info");
        this.#subscriptions.push(
            this.#log.onEntry((entry) => {
                if (options.onLog) options.onLog(entry);
                else if (!options.logger) console.log(`[${entry.level}] ${entry.message}`);
                this.#emitter.emit("log", entry);
            }),
        );
        this.#emitter.setErrorHandler((event, error) => {
            if (event === "log") return;
            this.#log.error(`Listener for "${event}" threw`, { error: String(error) });
        });

        const connectionKind = (endpointId: string): ConnectionKind => this.#endpointOwners.get(endpointId)?.kind ?? "serial";

        this.#registry = new DeviceRegistry({ emitter: this.#emitter, log: this.#log });
        this.#dongle = new DongleController({
            emitter: this.#emitter,
            log: this.#log,
            registry: this.#registry,
            isOpen: (endpointId) => this.#open.has(endpointId),
            connectionKind,
            write: (endpointId, command) => this.#writeCommand(endpointId, command),
            onChannel: (endpointId, channel) => this.#applyChannel(endpointId, channel),
            buttonDebounceMs: options.buttonDebounceMs,
            pairingTimeoutMs: options.pairingTimeoutMs,
        });
        this.#wired = new WiredController({
            emitter: this.#emitter,
            log: this.#log,
            registry: this.#registry,
            connectionKind,
            write: (endpointId, command) => this.#writeCommand(endpointId, command),
        });
        this.#ble = new BleController({
            emitter: this.#emitter,
            log: this.#log,
            registry: this.#registry,
            connectionKind,
            write: (endpointId, characteristic, data) => this.#writeBleCommand(endpointId, characteristic, data),
            buttonDebounceMs: options.buttonDebounceMs,
        });

        for (const connection of this.#connections) {
            this.#subscriptions.push(connection.onData((frame) => this.#onFrame(frame)));
            this.#subscriptions.push(connection.onLost((endpointId, reason) => this.#onLost(endpointId, reason)));
            if (connection.kind === "ble" && connection.onRssi) {
                this.#subscriptions.push(
                    connection.onRssi((endpointId, rssi) => {
                        this.#onBleRssi(endpointId, rssi);
                    }),
                );
            }
        }
    }

    /*
     * device discovery and connection
     */

    // check what endpoints every connection can see, serial ports and BLE peripherals
    discover(options?: ListOptions): Promise<EndpointDescriptor[]> {
        if (this.#disposed || options?.signal?.aborted) return Promise.resolve(this.#endpoints);
        if (this.#scanning) return this.#scanning;

        const controller = new AbortController();
        const signal = options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
        const generation = ++this.#scanGeneration;
        const timeout = options?.timeoutMs;
        const timeoutId = timeout !== undefined && timeout >= 0 ? setTimeout(() => controller.abort(), timeout) : undefined;
        this.#scanController = controller;

        const done = this.#scan(signal, generation, options).finally(() => {
            clearTimeout(timeoutId);
            if (this.#scanning === done) {
                this.#scanning = undefined;
                if (this.#scanController === controller) this.#scanController = undefined;
            }
        });

        this.#scanning = done;
        return done;
    }

    async #scan(signal: AbortSignal, generation: number, options?: ListOptions): Promise<EndpointDescriptor[]> {
        const failures: Error[] = [];
        const scanning = Promise.all(
            this.#connections.map(async (connection) => {
                try {
                    return { connection, found: await connection.list({ ...options, signal }) };
                } catch (error) {
                    if (signal.aborted) return { connection, found: [] as EndpointDescriptor[] };
                    const failure = toError(error);
                    failures.push(failure);
                    this.#log.error(`Discovery failed for "${connection.kind}"`, { error: String(error) });
                    this.#emitter.emit("error", { error: failure });
                    return { connection, found: [] as EndpointDescriptor[] };
                }
            }),
        );
        const results = await raceWithAbort(scanning, signal);
        if (!results || signal.aborted || this.#disposed || generation !== this.#scanGeneration) return this.#endpoints;
        if (this.#connections.length > 0 && failures.length === this.#connections.length) {
            throw new HaritoraXError("CONNECTION_FAILED", "Discovery failed for every configured connection", {
                cause: new AggregateError(failures),
            });
        }

        const merged = new Map<string, EndpointDescriptor>();

        // allow previous endpoints to show in list if still open, else they can't be disconected with disconnect() and will never show up in discover() again
        const previousOwners = new Map(this.#endpointOwners);
        const previousHandlers = new Map(this.#handlers);
        this.#endpointOwners.clear();
        this.#handlers.clear();

        for (const endpointId of this.#open) {
            const previous = this.#endpoints.find((descriptor) => descriptor.id === endpointId);
            if (previous) merged.set(endpointId, previous);
        }

        for (const { connection, found } of results) {
            for (const descriptor of found) {
                merged.set(descriptor.id, descriptor);
                this.#endpointOwners.set(descriptor.id, connection);

                const handler =
                    descriptor.connection === "ble" ? this.#ble : descriptor.model === "wired" ? this.#wired : this.#dongle;

                this.#handlers.set(descriptor.id, handler);
            }
        }

        for (const endpointId of merged.keys()) {
            const owner = this.#endpointOwners.get(endpointId) ?? previousOwners.get(endpointId);
            const handler = this.#handlers.get(endpointId) ?? previousHandlers.get(endpointId);
            if (owner) this.#endpointOwners.set(endpointId, owner);
            if (handler) this.#handlers.set(endpointId, handler);
        }

        this.#endpoints = [...merged.values()];

        this.#log.info(`Discovered ${this.#endpoints.length} endpoint(s)`, {
            ids: this.#endpoints.map((descriptor) => descriptor.id).join(","),
        });

        return this.#endpoints;
    }

    stopDiscovery(): Promise<void> {
        this.#scanGeneration++;
        this.#scanController?.abort();
        this.#scanController = undefined;
        const scanning = this.#scanning;
        this.#scanning = undefined;
        return scanning?.then(() => undefined) ?? Promise.resolve();
    }

    getEndpoints(): EndpointDescriptor[] {
        return this.#endpoints.map((endpoint) => ({ ...endpoint }));
    }

    getDevices(): DeviceSnapshot[] {
        return this.#registry.listDevices().map(copyDeviceSnapshot);
    }

    getDevice(deviceId: string): DeviceSnapshot | undefined {
        const device = this.#registry.getDevice(deviceId);
        return device ? copyDeviceSnapshot(device) : undefined;
    }

    getTrackers(): TrackerSnapshot[] {
        return this.#registry.listTrackers().map(copyTrackerSnapshot);
    }

    getTracker(trackerId: string): TrackerSnapshot | undefined {
        const tracker = this.#registry.getTracker(trackerId);
        return tracker ? copyTrackerSnapshot(tracker) : undefined;
    }

    getBodyPart(trackerId: string): BodyPart | undefined {
        return this.#registry.getBodyPart(trackerId);
    }

    /*
     * device control
     */

    async setSettings(deviceId: string, settings: TrackerSettings): Promise<void> {
        const device = this.#registry.getDevice(deviceId);
        if (!device) throw new HaritoraXError("DEVICE_NOT_FOUND", `Unknown device "${deviceId}"`);
        if (!this.#open.has(device.endpointId))
            throw new HaritoraXError("NOT_CONNECTED", `${device.endpointId} is not connected`);

        if (device.connection === "ble") {
            await this.#ble.setSettings(device.endpointId, settings);
            return;
        }

        if (device.model === "wired") {
            await this.#wired.setSettings([device.endpointId], settings);
            return;
        }

        await this.#dongle.setSettings(device.endpointId, device.slot, settings);
    }

    /*
     * dongle control
     */

    getChannel(endpointId: string): number | undefined {
        return this.#dongle.getChannel(endpointId);
    }

    getLatency(endpointId: string): number | undefined {
        return this.#dongle.getLatency(endpointId);
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

    getDongleVersion(endpointId: string): string | undefined {
        return this.#dongle.getDongleVersion(endpointId);
    }

    async setBodyPart(deviceId: string, bodyPart: BodyPart): Promise<void> {
        const device = this.#registry.getDevice(deviceId);
        if (!device) throw new HaritoraXError("DEVICE_NOT_FOUND", `Unknown device "${deviceId}"`);
        if (device.model === "wired")
            throw new HaritoraXError("NOT_SUPPORTED", "Wired trackers get their body parts from the order of their sensors");
        if (!this.#open.has(device.endpointId))
            throw new HaritoraXError("NOT_CONNECTED", `${device.endpointId} is not connected`);

        if (bodyPartBaseLocked(device.model, device.version, device.deviceId) === true) {
            throw new HaritoraXError(
                "NOT_SUPPORTED",
                `${device.deviceId} is a base tracker and keeps its body part on firmware ${device.version}. Update the tracker firmware to ${baseLockRemovedIn(device.model)} or newer to reassign it`,
            );
        }

        if (device.connection === "ble") {
            await this.#ble.setBodyPart(device.endpointId, bodyPart);
            return;
        }

        await this.#dongle.setBodyPart(device.endpointId, device.slot, bodyPart);
    }

    async powerOff(deviceId: string): Promise<void> {
        const device = this.#registry.getDevice(deviceId);
        if (!device) throw new HaritoraXError("DEVICE_NOT_FOUND", `Unknown device "${deviceId}"`);
        if (device.model === "wired") throw new HaritoraXError("NOT_SUPPORTED", "Power-off is not supported for wired devices");
        if (!this.#open.has(device.endpointId))
            throw new HaritoraXError("NOT_CONNECTED", `${device.endpointId} is not connected`);

        if (device.connection === "ble") {
            await this.#ble.powerOff(device.endpointId);
        } else {
            await this.#dongle.powerOff(device.endpointId, device.slot);
        }

        this.#log.info(`Powering off ${deviceId}`);
    }

    async switchCommunication(deviceId: string, mode: "ble" | "serial"): Promise<void> {
        const device = this.#registry.getDevice(deviceId);
        if (!device) throw new HaritoraXError("DEVICE_NOT_FOUND", `Unknown device "${deviceId}"`);
        if (device.model === "wired")
            throw new HaritoraXError("NOT_SUPPORTED", "Switching communication is not supported for wired devices");
        if (!this.#open.has(device.endpointId))
            throw new HaritoraXError("NOT_CONNECTED", `${device.endpointId} is not connected`);

        if (device.connection === "ble") {
            if (mode === "ble") throw new HaritoraXError("NOT_SUPPORTED", "This tracker is already on BLE communication");
            await this.#ble.switchCommunication(device.endpointId);
        } else {
            if (mode === "serial") throw new HaritoraXError("NOT_SUPPORTED", "This tracker is already on serial communication");
            await this.#dongle.switchCommunication(device.endpointId, device.slot);
        }

        this.#log.info(`Switching ${deviceId} to ${mode}`);
    }

    async connect(endpointId: string): Promise<void> {
        return this.#withEndpointOperation(endpointId, async () => {
            if (this.#disposed) throw new HaritoraXError("NOT_CONNECTED", "HaritoraX has been disposed");
            const connection = this.#endpointOwners.get(endpointId);
            if (!connection) {
                throw new HaritoraXError("DEVICE_NOT_FOUND", `Unknown endpoint "${endpointId}", call discover() first`);
            }

            if (this.#open.has(endpointId)) return;

            await connection.open(endpointId);
            if (this.#disposed) {
                await connection.close(endpointId);
                return;
            }
            this.#open.add(endpointId);

            const descriptor = this.#endpoints.find((endpoint) => endpoint.id === endpointId);
            if (descriptor?.connection === "ble") {
                try {
                    await this.#ble.start(endpointId);
                } catch (error) {
                    await connection.close(endpointId).catch((closeError: unknown) => {
                        this.#log.warn(`Could not close ${endpointId} after BLE startup failed`, { error: String(closeError) });
                    });
                    if (this.#open.delete(endpointId)) this.#dropEndpoint(endpointId, "error");
                    throw error;
                }
            }

            this.#emitter.emit("endpoint:connected", {
                endpointId,
                connection: connection.kind,
                displayName: descriptor?.displayName ?? endpointId,
            });
            this.#log.info(`Connected ${endpointId}`);
        });
    }

    async disconnect(endpointId: string): Promise<void> {
        return this.#withEndpointOperation(endpointId, async () => {
            if (!this.#open.has(endpointId)) return;

            try {
                await this.#endpointOwners.get(endpointId)?.close(endpointId);
            } finally {
                if (this.#open.delete(endpointId)) this.#dropEndpoint(endpointId, "requested");
            }
            this.#log.info(`Disconnected ${endpointId}`);
        });
    }

    /*
     * listeners and disposal
     */

    async dispose(): Promise<void> {
        if (this.#disposed) return;
        this.#disposed = true;
        this.#scanGeneration++;
        this.#scanController?.abort();
        this.#scanController = undefined;
        const scanning = this.#scanning;
        this.#scanning = undefined;
        await Promise.all([
            ...(scanning ? [scanning.catch(() => this.#endpoints)] : []),
            ...[...this.#endpointOperations.values()].map((operation) => operation.catch(() => undefined)),
        ]);
        this.#dongle.dispose();
        this.#wired.dispose();
        this.#ble.dispose();

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
        this.#handlers.clear();
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
            if (frame.characteristic !== undefined) {
                if (this.#log.enabled("trace")) {
                    this.#log.trace(`Frame ${frame.characteristic} from ${frame.endpointId}`, {
                        bytes: frame.data.length,
                    });
                }

                const handler = this.#handlers.get(frame.endpointId) ?? this.#ble;
                handler.handleBinaryFrame?.(frame.endpointId, frame.characteristic, frame.data);
                return;
            }

            const line = parseLine(frame.data);
            identifier = line.identifier;
            const { payload, rawIdentifier } = line;

            if (this.#log.enabled("trace")) {
                this.#log.trace(`Frame ${identifier || "(none)"} from ${frame.endpointId}`, {
                    bytes: frame.data.length,
                    payload: payload.length > 120 ? `${payload.slice(0, 120)}…` : payload,
                });
            }

            const parsed = parseIdentifier(identifier);
            if (!parsed) return;

            const handler = this.#handlers.get(frame.endpointId) ?? this.#dongle;
            handler.handleFrame(frame.endpointId, parsed.name, parsed.slot, payload, rawIdentifier.replace(/\d+$/, ""));
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

    async #writeBleCommand(endpointId: string, characteristic: BleCharacteristic, data: Uint8Array): Promise<void> {
        const connection = this.#endpointOwners.get(endpointId);
        if (!connection) throw new HaritoraXError("DEVICE_NOT_FOUND", `Unknown endpoint "${endpointId}"`);

        return connection.write(endpointId, data, { characteristic });
    }

    #dropEndpoint(endpointId: string, reason: DisconnectReason): void {
        this.#registry.removeDevicesAtEndpoint(endpointId, reason);
        const handler = this.#handlers.get(endpointId) ?? this.#dongle;
        handler.forgetEndpoint(endpointId);
        this.#emitter.emit("endpoint:disconnected", { endpointId, reason });
    }

    #onLost(endpointId: string, reason: DisconnectReason): void {
        if (!this.#open.delete(endpointId)) return;
        this.#dropEndpoint(endpointId, reason);
    }

    #onBleRssi(endpointId: string, rssi: number): void {
        const device = this.#open.has(endpointId) ? this.#registry.deviceAt(endpointId, "0") : undefined;
        if (!device) return;

        for (const tracker of device.trackers) this.#registry.setRssi(tracker.trackerId, rssi, tracker.sensorRssi);

        this.#log.debug(`BLE RSSI update for ${device.deviceId}: ${rssi} dBm`);
    }

    #withEndpointOperation(endpointId: string, operation: () => Promise<void>): Promise<void> {
        const previous = this.#endpointOperations.get(endpointId) ?? Promise.resolve();
        const current = previous.catch(() => undefined).then(operation);
        const tracked = current.finally(() => {
            if (this.#endpointOperations.get(endpointId) === tracked) this.#endpointOperations.delete(endpointId);
        });
        this.#endpointOperations.set(endpointId, tracked);
        return tracked;
    }
}

export function createHaritoraX(options?: HaritoraXOptions): HaritoraX {
    return new HaritoraX(options);
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
    if (signal.aborted) return Promise.resolve(undefined);

    return new Promise((resolve, reject) => {
        const onAbort = (): void => {
            signal.removeEventListener("abort", onAbort);
            resolve(undefined);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        operation.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener("abort", onAbort);
                reject(error instanceof Error ? error : new Error(String(error)));
            },
        );
    });
}

/*
 * types
 */

export interface HaritoraXOptions {
    connections?: Connection[];
    logLevel?: LogLevel;
    onLog?: LogSink;
    logger?: Logger;
    // debounce time for button presses, default 100ms
    buttonDebounceMs?: number;
    // how long pairing waits for the dongle to report the slot as paired, default 30 s
    pairingTimeoutMs?: number;
}
