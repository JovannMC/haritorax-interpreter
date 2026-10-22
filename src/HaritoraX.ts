import { fromByteArray as encodeBase64, toByteArray as decodeBase64 } from "base64-js";
import { HaritoraXError } from "./lib/errors.js";
import { Logger, type LogSink } from "./lib/logging.js";
import { Emitter } from "./lib/emitter.js";
import { parseLine } from "./protocol/framing.js";
import { decodeImu } from "./protocol/imu.js";
import { decodeSettings, parseBattery, parseInfo } from "./protocol/messages.js";
import type { Connection, Frame, ListOptions } from "./connections/contract.js";
import type {
    EndpointDescriptor,
    DeviceInfo,
    DisconnectReason,
    EventHandler,
    Events,
    ImuRole,
    LogLevel,
    MagStatus,
    TrackerModel,
    DeviceSnapshot,
    Unsubscribe,
} from "./types.js";

export interface HaritoraXOptions {
    connections?: Connection[];
    logLevel?: LogLevel;
    onLog?: LogSink;
}

// what the "i(x):" (info) messages tell us about the device
interface DeviceIdentity {
    model: TrackerModel;
    imuCount: number;
}

export class HaritoraX {
    readonly #emitter = new Emitter();
    readonly #log: Logger;
    readonly #connections: Connection[];

    #endpoints: EndpointDescriptor[] = [];
    readonly #endpointOwners = new Map<string, Connection>();
    readonly #open = new Set<string>();
    readonly #devices = new Map<string, DeviceSnapshot>();
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
        return [...this.#devices.values()];
    }

    getDevice(deviceId: string): DeviceSnapshot | undefined {
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
        this.#dropDevices(endpointId);
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
        const { identifier, payload } = parseLine(frame.data);

        if (this.#log.enabled("debug")) {
            this.#log.debug(`Frame ${identifier || "(none)"} from ${frame.endpointId}`, {
                bytes: frame.data.length,
                payload: payload.length > 120 ? `${payload.slice(0, 120)}…` : payload,
            });
        }

        const match = /^([a-z]+)(\d+)$/.exec(identifier);
        const slot = match?.[2];
        if (!match || !slot) return;

        try {
            switch (match[1]) {
                case "i":
                    this.#onInfo(frame.endpointId, slot, payload);
                    break;
                case "v":
                    this.#onBattery(frame.endpointId, slot, payload);
                    break;
                case "o":
                    this.#onSettings(frame.endpointId, slot, payload);
                    break;
                case "x":
                    this.#onImu(frame.endpointId, slot, payload);
                    break;
            }
        } catch (error) {
            this.#log.warn(`Failed to decode "${identifier}" from ${frame.endpointId}`, { error: String(error) });
        }
    }

    #onInfo(endpointId: string, slot: string, payload: string): void {
        const parsed = parseInfo(payload);
        if (!parsed) return;

        if (parsed.serialNumber === PLACEHOLDER_SERIAL) return;

        const imuCount = parsed.imuCount ?? 1;
        const model = modelFromFirmware(parsed.model);

        const device = this.#getOrCreateDevice(endpointId, slot, { imuCount, model });

        const info: DeviceInfo = {
            deviceId: device.deviceId,
            version: parsed.version,
            model: parsed.model,
            serialNumber: parsed.serialNumber,
            imuCount: parsed.imuCount,
            timestamp: Date.now(),
        };

        this.#emitter.emit("info", info);
    }

    #onBattery(endpointId: string, slot: string, payload: string): void {
        const parsed = parseBattery(payload);
        if (!parsed) return;

        const device = this.#devices.get(deviceIdOf(endpointId, slot));
        if (!device) return;

        const battery = {
            deviceId: device.deviceId,
            level: parsed.level,
            voltage: parsed.voltage,
            chargeStatus: parsed.chargeStatus,
            timestamp: Date.now(),
        };

        this.#devices.set(device.deviceId, { ...device, battery });
        this.#emitter.emit("battery", battery);
        this.#emitDevices();
    }

    #onSettings(endpointId: string, slot: string, payload: string): void {
        const settings = decodeSettings(payload);
        if (!settings) return;

        const device = this.#devices.get(deviceIdOf(endpointId, slot));
        if (!device) return;

        this.#devices.set(device.deviceId, { ...device, settings });
        this.#emitter.emit("settings", { deviceId: device.deviceId, settings });
        this.#emitDevices();
    }

    // TODO: double check data if they are what they are meant to be lol, v3 is kinda hell
    #onImu(endpointId: string, slot: string, payload: string): void {
        const bytes = decodeBase64(payload);
        const device = this.#getOrCreateDevice(endpointId, slot);

        if (bytes.length >= 30) {
            const leg = decodeImu(encodeBase64(bytes.slice(0, 14)), device.model, bytes[14]);
            const thigh = decodeImu(encodeBase64(bytes.slice(16, 30)), device.model, bytes[15]);

            this.#emitSample(device, 0, "ankle", leg);
            this.#emitSample(device, 1, "knee", thigh);
            return;
        }

        this.#emitSample(device, 0, "ankle", decodeImu(payload, device.model));
    }

    #emitSample(device: DeviceSnapshot, imuIndex: number, role: ImuRole, decoded: ReturnType<typeof decodeImu>): void {
        if (!decoded) return;

        this.#emitter.emit("imu", {
            deviceId: device.deviceId,
            bodyPart: device.bodyParts[imuIndex] ?? "unassigned",
            role,
            rotation: decoded.rotation,
            acceleration: decoded.acceleration,
            ...(decoded.ankleAngle === undefined ? {} : { ankleAngle: decoded.ankleAngle }),
            timestamp: Date.now(),
        });

        if (decoded.magStatus) this.#setMag(device.deviceId, decoded.magStatus);
    }

    // magnetometer data is reported every IMU packet (on most devices), just emit on change
    #setMag(deviceId: string, status: MagStatus): void {
        const device = this.#devices.get(deviceId);
        if (!device || device.mag === status) return;

        this.#devices.set(deviceId, { ...device, mag: status });
        this.#emitter.emit("mag", { deviceId, status });
        this.#emitDevices();
    }

    // gets or creates a device snapshot, updating model and IMU count if info is provided
    #getOrCreateDevice(endpointId: string, slot: string, identity?: DeviceIdentity): DeviceSnapshot {
        const deviceId = deviceIdOf(endpointId, slot);
        const existing = this.#devices.get(deviceId);

        if (existing) {
            if (!identity) return existing;

            const updated: DeviceSnapshot = {
                ...existing,
                model: identity.model,
                imuCount: identity.imuCount,
                bodyParts:
                    identity.imuCount === existing.imuCount
                        ? existing.bodyParts
                        : Array.from({ length: identity.imuCount }, () => "unassigned" as const),
            };

            this.#devices.set(deviceId, updated);
            this.#emitDevices();
            return updated;
        }

        const imuCount = identity?.imuCount ?? 1;
        const device: DeviceSnapshot = {
            deviceId,
            bodyParts: Array.from({ length: imuCount }, () => "unassigned" as const),
            imuCount,
            model: identity?.model ?? "wireless",
            connection: this.#endpointOwners.get(endpointId)?.kind ?? "serial",
            connected: true,
        };

        this.#devices.set(deviceId, device);
        this.#emitDevices();
        return device;
    }

    #dropDevices(endpointId: string): void {
        const prefix = `${endpointId}:`;
        let changed = false;

        for (const deviceId of [...this.#devices.keys()]) {
            if (!deviceId.startsWith(prefix)) continue;

            this.#devices.delete(deviceId);
            changed = true;
        }

        if (changed) this.#emitDevices();
    }

    #emitDevices(): void {
        this.#emitter.emit("devices", { devices: this.getDevices() });
    }

    #onLost(endpointId: string, reason: DisconnectReason): void {
        if (!this.#open.delete(endpointId)) return;

        this.#dropDevices(endpointId);
        this.#emitter.emit("device:disconnected", { deviceId: endpointId, reason });
    }
}

export function createHaritoraX(options?: HaritoraXOptions): HaritoraX {
    return new HaritoraX(options);
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

function modelFromFirmware(model: string): TrackerModel {
    if (model === "mc2") return "wired";
    else if (model === "mc3s") return "wireless";
    else if (model === "mc4b") return "x2";
    else throw new HaritoraXError("DECODE_FAILED", `Unknown firmware model "${model}"`);
}

const PLACEHOLDER_SERIAL = "A00000";

function deviceIdOf(endpointId: string, slot: string): string {
    return `${endpointId}:${slot}`;
}
