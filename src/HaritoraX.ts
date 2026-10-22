import { fromByteArray as encodeBase64, toByteArray as decodeBase64 } from "base64-js";
import { HaritoraXError } from "./lib/errors.js";
import { Logger, type LogSink } from "./lib/logging.js";
import { Emitter } from "./lib/emitter.js";
import { asciiEncode, parseLine } from "./protocol/framing.js";
import { decodeImu } from "./protocol/imu.js";
import {
    bodyPartOfTracker,
    bodyPartsFor,
    isDongleSlot,
    isValidChannel,
    pairCommands,
    parseChannel,
    parsePairingResult,
    parseTrackerId,
    setChannelCommand,
    unpairCommands,
} from "./protocol/dongle.js";
import { decodeSettings, parseBattery, parseInfo } from "./protocol/messages.js";
import type { Connection, Frame, ListOptions } from "./connections/contract.js";
import type {
    BodyPart,
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

const PLACEHOLDER_SERIAL = "A00000";
const PAIRING_COMMAND_DELAY_MS = 1_000;
const PAIRING_TIMEOUT_MS = 10_000;

export class HaritoraX {
    readonly #emitter = new Emitter();
    readonly #log: Logger;
    readonly #connections: Connection[];

    #endpoints: EndpointDescriptor[] = [];
    readonly #endpointOwners = new Map<string, Connection>();
    readonly #open = new Set<string>();
    readonly #devices = new Map<string, DeviceSnapshot>();
    readonly #identities = new Map<string, TrackerIdentity>();
    readonly #channels = new Map<string, number>();
    readonly #pairings = new Map<string, PendingPairing>();
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

    /*
     * dongle control
     */

    // TODO: should i just move these dongle commands into the dongle protocol file itself?

    getChannel(endpointId: string): number | undefined {
        return this.#channels.get(endpointId);
    }

    async setChannel(endpointId: string, channel: number): Promise<void> {
        if (!isValidChannel(channel)) {
            throw new HaritoraXError("NOT_SUPPORTED", `Channel must be an integer between 1 and 10, got ${channel}`);
        }

        if (!this.#open.has(endpointId)) {
            throw new HaritoraXError("NOT_CONNECTED", `${endpointId} is not connected`);
        }

        await this.#writeCommand(endpointId, setChannelCommand(channel));
        this.#updateChannel(endpointId, channel);
    }

    async pair(endpointId: string, slot: string | number): Promise<void> {
        const { portId, channel } = this.#pairingSlot(endpointId, slot);
        if (this.#pairings.has(endpointId)) {
            throw new HaritoraXError("BUSY", `Pairing is already in progress on ${endpointId}`);
        }

        const completion = this.#waitForPairing(endpointId);

        try {
            await this.#writeSequence(endpointId, pairCommands(channel, portId));
        } catch (error) {
            this.#clearPairing(endpointId);
            throw error;
        }

        const result = await completion;
        if (result === "timeout") {
            throw new HaritoraXError("TIMEOUT", `Pairing on ${endpointId} timed out`);
        }

        if (result !== "paired") {
            throw new HaritoraXError("CONNECTION_FAILED", `Pairing on ${endpointId} was cancelled`);
        }

        await this.#writeCommand(endpointId, setChannelCommand(channel));
        await this.#writeCommand(endpointId, `r${portId}:`);

        const deviceId = deviceIdOf(endpointId, portId);
        this.#emitter.emit("paired", { endpointId, slot: portId, deviceId });
        this.#log.info(`Paired ${deviceId}`);
    }

    async unpair(endpointId: string, slot: string | number): Promise<void> {
        const { portId, channel } = this.#pairingSlot(endpointId, slot);

        await this.#writeSequence(endpointId, unpairCommands(channel, portId));

        const deviceId = deviceIdOf(endpointId, portId);
        this.#forgetIdentity(deviceId);
        this.#emitter.emit("unpaired", { endpointId, slot: portId, deviceId });
        this.#log.info(`Unpaired ${deviceId}`);
    }

    #pairingSlot(endpointId: string, slot: string | number): { portId: "0" | "1"; channel: number } {
        const portId = String(slot);
        if (!isDongleSlot(portId)) {
            throw new HaritoraXError("NOT_SUPPORTED", `Dongle slot must be 0 or 1, got "${portId}"`);
        }

        if (!this.#open.has(endpointId)) {
            throw new HaritoraXError("NOT_CONNECTED", `${endpointId} is not connected`);
        }

        const channel = this.#channels.get(endpointId);
        if (channel === undefined) {
            throw new HaritoraXError("NOT_CONNECTED", `Channel for ${endpointId} is not known yet`);
        }

        return { portId, channel };
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
        this.#forgetEndpoint(endpointId);
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

        for (const pending of this.#pairings.values()) {
            clearTimeout(pending.timer);
            pending.resolve("cancelled");
        }
        this.#pairings.clear();

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
        this.#identities.clear();
        this.#channels.clear();
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

        const match = /^([a-z]+)(\d*)$/.exec(identifier);
        const name = match?.[1];
        const slot = match?.[2];
        if (!match || !name) return;

        if (!slot) {
            this.#onDongleFrame(frame.endpointId, name, payload);
            return;
        }

        try {
            switch (name) {
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
                case "r":
                    this.#onIdentity(frame.endpointId, slot, payload);
                    break;
            }
        } catch (error) {
            this.#log.warn(`Failed to decode "${identifier}" from ${frame.endpointId}`, { error: String(error) });
        }
    }

    #onDongleFrame(endpointId: string, identifier: string, payload: string): void {
        if (identifier === "o") {
            const channel = parseChannel(payload);
            if (channel !== undefined) this.#updateChannel(endpointId, channel);
            return;
        }

        if (identifier === "r" && parsePairingResult(payload) && this.#finishPairing(endpointId)) {
            this.#log.info(`Pairing completed on ${endpointId}`);
        }
    }

    // "r0:"/"r1:" replies identify the tracker currently paired to that slot.
    #onIdentity(endpointId: string, slot: string, payload: string): void {
        const trackerId = parseTrackerId(payload);
        if (!trackerId) return;

        const bodyPart = bodyPartOfTracker(trackerId);
        if (!bodyPart) {
            this.#log.debug(`Unknown tracker id "${trackerId}" on ${endpointId}:${slot}`);
            return;
        }

        const deviceId = deviceIdOf(endpointId, slot);
        const previous = this.#identities.get(deviceId);
        if (previous?.trackerId === trackerId && previous.bodyPart === bodyPart) return;

        this.#identities.set(deviceId, { trackerId, bodyPart });
        this.#log.info(`Identified ${deviceId} as ${bodyPart} (tracker ${trackerId})`);

        const device = this.#devices.get(deviceId);
        if (device) this.#applyIdentity(deviceId, device);

        this.#emitter.emit("identified", { deviceId, trackerId, bodyPart });
    }

    #applyIdentity(deviceId: string, device: DeviceSnapshot): void {
        const tracker = this.#identities.get(deviceId);
        if (!tracker) return;

        const bodyParts = bodyPartsFor(tracker.bodyPart, device.imuCount);
        const unchanged =
            device.trackerId === tracker.trackerId &&
            device.bodyParts.length === bodyParts.length &&
            device.bodyParts.every((part, index) => part === bodyParts[index]);

        if (unchanged) return;

        this.#devices.set(deviceId, { ...device, trackerId: tracker.trackerId, bodyParts });
        this.#emitDevices();
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
        const tracker = this.#identities.get(deviceId);

        if (existing) {
            if (!identity) return existing;

            const updated: DeviceSnapshot = {
                ...existing,
                model: identity.model,
                imuCount: identity.imuCount,
                bodyParts:
                    tracker !== undefined
                        ? bodyPartsFor(tracker.bodyPart, identity.imuCount)
                        : identity.imuCount === existing.imuCount
                          ? existing.bodyParts
                          : unassignedParts(identity.imuCount),
                ...(tracker ? { trackerId: tracker.trackerId } : {}),
            };

            this.#devices.set(deviceId, updated);
            this.#emitDevices();
            return updated;
        }

        const imuCount = identity?.imuCount ?? 1;
        const device: DeviceSnapshot = {
            deviceId,
            bodyParts: tracker !== undefined ? bodyPartsFor(tracker.bodyPart, imuCount) : unassignedParts(imuCount),
            imuCount,
            model: identity?.model ?? "wireless",
            connection: this.#endpointOwners.get(endpointId)?.kind ?? "serial",
            connected: true,
            ...(tracker ? { trackerId: tracker.trackerId } : {}),
        };

        this.#devices.set(deviceId, device);
        this.#emitDevices();
        return device;
    }

    #updateChannel(endpointId: string, channel: number): void {
        if (this.#channels.get(endpointId) === channel) return;

        this.#channels.set(endpointId, channel);
        const descriptor = this.#endpoints.find((endpoint) => endpoint.id === endpointId);
        if (descriptor) descriptor.channel = channel;

        this.#log.info(`Channel of ${endpointId} is ${channel}`);
        this.#emitter.emit("channel", { endpointId, channel });
    }

    #forgetIdentity(deviceId: string): void {
        this.#identities.delete(deviceId);

        const device = this.#devices.get(deviceId);
        if (!device) return;

        const updated: DeviceSnapshot = { ...device, bodyParts: unassignedParts(device.imuCount) };
        delete updated.trackerId;
        this.#devices.set(deviceId, updated);
        this.#emitDevices();
    }

    #writeCommand(endpointId: string, command: string): Promise<void> {
        const connection = this.#endpointOwners.get(endpointId);
        if (!connection) {
            return Promise.reject(new HaritoraXError("DEVICE_NOT_FOUND", `Unknown endpoint "${endpointId}"`));
        }

        return connection.write(endpointId, asciiEncode(command));
    }

    async #writeSequence(endpointId: string, commands: readonly string[]): Promise<void> {
        for (const [index, command] of commands.entries()) {
            if (index > 0) await delay(PAIRING_COMMAND_DELAY_MS);
            await this.#writeCommand(endpointId, command);
        }
    }

    #waitForPairing(endpointId: string): Promise<PairingResult> {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.#pairings.delete(endpointId);
                resolve("timeout");
            }, PAIRING_TIMEOUT_MS);

            this.#pairings.set(endpointId, { resolve, timer });
        });
    }

    #settlePairing(endpointId: string, result: PairingResult): boolean {
        const pending = this.#pairings.get(endpointId);
        if (!pending) return false;

        clearTimeout(pending.timer);
        this.#pairings.delete(endpointId);
        pending.resolve(result);
        return true;
    }

    #finishPairing(endpointId: string): boolean {
        return this.#settlePairing(endpointId, "paired");
    }

    #clearPairing(endpointId: string): void {
        this.#settlePairing(endpointId, "cancelled");
    }

    #forgetEndpoint(endpointId: string): void {
        this.#channels.delete(endpointId);
        this.#clearPairing(endpointId);

        const prefix = `${endpointId}:`;
        for (const deviceId of [...this.#identities.keys()]) {
            if (deviceId.startsWith(prefix)) this.#identities.delete(deviceId);
        }
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

        this.#forgetEndpoint(endpointId);
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

function deviceIdOf(endpointId: string, slot: string): string {
    return `${endpointId}:${slot}`;
}

function unassignedParts(count: number): BodyPart[] {
    return Array.from({ length: count }, () => "unassigned");
}

function delay(ms: number): Promise<void> {
    return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/*
 * types
 */

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

// what the per-slot "r(x):" messages tell us about the tracker
interface TrackerIdentity {
    trackerId: string;
    bodyPart: BodyPart;
}

type PairingResult = "paired" | "cancelled" | "timeout";

interface PendingPairing {
    resolve: (result: PairingResult) => void;
    timer: ReturnType<typeof setTimeout>;
}
