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
    DisconnectReason,
    EventHandler,
    Events,
    ImuRole,
    LogLevel,
    MagStatus,
    TrackerModel,
    DeviceSnapshot,
    TrackerSnapshot,
    Unsubscribe,
} from "./types.js";

const PLACEHOLDER_SERIAL = "A00000";
const PAIRING_COMMAND_DELAY_MS = 1_000;
const PAIRING_TIMEOUT_MS = 10_000;
const TRACKER_TIMEOUT_MS = 10_000;

export class HaritoraX {
    readonly #emitter = new Emitter();
    readonly #log: Logger;
    readonly #connections: Connection[];

    #endpoints: EndpointDescriptor[] = [];
    readonly #endpointOwners = new Map<string, Connection>();
    readonly #open = new Set<string>();
    // deviceId is the device serial number
    readonly #devices = new Map<string, DeviceSnapshot>();
    readonly #deviceByEndpointSlot = new Map<string, string>();
    readonly #trackers = new Map<string, TrackerState>();
    // pending/current dongle identity, keyed by endpointId:slot
    readonly #identities = new Map<string, TrackerIdentity>();
    readonly #channels = new Map<string, number>();
    readonly #pairings = new Map<string, PendingPairing>();
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

    getTrackers(): TrackerSnapshot[] {
        return [...this.#trackers.values()].map((tracker) => tracker.snapshot);
    }

    getTracker(trackerId: string): TrackerSnapshot | undefined {
        return this.#trackers.get(trackerId)?.snapshot;
    }

    getBodyPart(trackerId: string): BodyPart | undefined {
        return this.#trackers.get(trackerId)?.snapshot.bodyPart;
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

        this.#emitter.emit("paired", { endpointId, slot: portId });
        this.#log.info(`Paired ${endpointId}:${portId}`);
    }

    async unpair(endpointId: string, slot: string | number): Promise<void> {
        const { portId, channel } = this.#pairingSlot(endpointId, slot);

        await this.#writeSequence(endpointId, unpairCommands(channel, portId));

        this.#forgetIdentity(endpointId, portId);
        this.#emitter.emit("unpaired", { endpointId, slot: portId });
        this.#log.info(`Unpaired ${endpointId}:${portId}`);
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
        this.#dropDevices(endpointId, "requested");
        this.#forgetEndpoint(endpointId);
        this.#emitter.emit("endpoint:disconnected", { endpointId, reason: "requested" });
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
        this.#deviceByEndpointSlot.clear();
        for (const tracker of this.#trackers.values()) clearTrackerTimer(tracker);
        this.#trackers.clear();
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

    // "r0:"/"r1:" replies identify the tracker currently paired to that slot
    #onIdentity(endpointId: string, slot: string, payload: string): void {
        const dongleId = parseTrackerId(payload);
        if (!dongleId) return;

        const bodyPart = bodyPartOfTracker(dongleId);
        if (!bodyPart) {
            this.#log.debug(`Unknown tracker id "${dongleId}" on ${endpointId}:${slot}`);
            return;
        }

        const key = endpointSlotKey(endpointId, slot);
        const previous = this.#identities.get(key);
        if (previous?.dongleId === dongleId && previous.bodyPart === bodyPart) return;

        this.#identities.set(key, { dongleId, bodyPart });
        this.#log.info(`Identified ${endpointId}:${slot} as ${bodyPart} (tracker ${dongleId})`);

        const device = this.#deviceAt(endpointId, slot);
        if (!device) return;

        // update bodyPart of trackers
        const parts = bodyPartsFor(bodyPart, device.imuCount);
        for (const [i, tracker] of device.trackers.entries()) {
            const next = parts[i] ?? "unassigned";
            if (tracker.bodyPart === next) continue;

            tracker.bodyPart = next;
            this.#emitter.emit("identified", { trackerId: tracker.trackerId, deviceId: device.deviceId, bodyPart: next });
        }

        this.#emitDevices();
    }

    #onInfo(endpointId: string, slot: string, payload: string): void {
        const parsed = parseInfo(payload);
        if (!parsed) return;

        const serial = parsed.serialNumber;
        if (serial === PLACEHOLDER_SERIAL) return;

        const imuCount = parsed.imuCount ?? 1;
        const model = modelFromFirmware(parsed.model);
        const key = endpointSlotKey(endpointId, slot);
        const previousSerial = this.#deviceByEndpointSlot.get(key);

        // if a different serial is on this endpoint/slot, disconnect and replace it
        // e.g. different dongle, different device paired to same slot
        if (previousSerial !== undefined && previousSerial !== serial) {
            this.#log.warn(`Replacing device "${previousSerial}" on ${key} with "${serial}"`);

            const previous = this.#devices.get(previousSerial);
            if (previous) {
                for (const tracker of previous.trackers) this.#disconnectTracker(tracker, "requested");
                this.#devices.delete(previousSerial);
                this.#emitter.emit("device:disconnected", {
                    deviceId: previous.deviceId,
                    endpointId: previous.endpointId,
                    reason: "requested",
                });
            }
        }

        const existing = this.#devices.get(serial);

        // we know the serial number but it might have moved to a different endpoint/slot (e.g. reused USB path)
        if (existing) {
            const oldKey = endpointSlotKey(existing.endpointId, existing.slot);

            // ..so update the endpoint/slot mapping if it changed
            if (oldKey !== key) {
                this.#deviceByEndpointSlot.delete(oldKey);
                this.#deviceByEndpointSlot.set(key, serial);
                existing.endpointId = endpointId;
                existing.slot = slot;
                for (const tracker of existing.trackers) tracker.endpointId = endpointId;
            }

            existing.model = model;
            this.#emitInfo(serial, parsed);
            this.#emitDevices();
            return;
        }

        const connection = this.#endpointOwners.get(endpointId)?.kind ?? "serial";

        const device: DeviceSnapshot = {
            deviceId: serial,
            endpointId,
            slot,
            imuCount,
            model,
            connection,
            trackers: this.#createTrackers(serial, endpointId, imuCount, this.#identities.get(key)),
        };

        this.#devices.set(serial, device);
        this.#deviceByEndpointSlot.set(key, serial);

        this.#emitter.emit("device:connected", { deviceId: serial, endpointId, slot, connection, model, imuCount });
        this.#emitInfo(serial, parsed);

        for (const tracker of device.trackers) this.#connectTracker(tracker);
        this.#emitDevices();
    }

    #emitInfo(deviceId: string, parsed: NonNullable<ReturnType<typeof parseInfo>>): void {
        this.#emitter.emit("info", {
            deviceId,
            version: parsed.version,
            model: parsed.model,
            serialNumber: parsed.serialNumber,
            imuCount: parsed.imuCount,
            timestamp: Date.now(),
        });
    }

    #createTrackers(
        deviceId: string,
        endpointId: string,
        imuCount: number,
        identity: TrackerIdentity | undefined,
    ): TrackerSnapshot[] {
        const parts = identity ? bodyPartsFor(identity.bodyPart, imuCount) : unassignedParts(imuCount);

        return parts.map((bodyPart, i) => {
            const tracker: TrackerSnapshot = {
                // stable tracker id used everywhere as "serialNumber:imuIndex" (e.g. A00000:1)
                // imuIndex identifies multiple IMUs (like HX2 leg/thigh combo)
                trackerId: `${deviceId}:${i}`,
                deviceId,
                endpointId,
                bodyPart,
                connected: false,
            };

            this.#trackers.set(tracker.trackerId, { snapshot: tracker });
            return tracker;
        });
    }

    #connectTracker(tracker: TrackerSnapshot): void {
        const state = this.#trackers.get(tracker.trackerId);
        if (!state) return;

        tracker.connected = true;
        this.#emitter.emit("tracker:connected", {
            trackerId: tracker.trackerId,
            deviceId: tracker.deviceId,
            endpointId: tracker.endpointId,
            bodyPart: tracker.bodyPart,
        });
        this.#startTrackerTimer(state);
    }

    #disconnectTracker(tracker: TrackerSnapshot, reason: DisconnectReason): void {
        const state = this.#trackers.get(tracker.trackerId);
        if (state) {
            clearTrackerTimer(state);
            this.#trackers.delete(tracker.trackerId);
        }

        if (!tracker.connected) return;

        tracker.connected = false;
        this.#emitter.emit("tracker:disconnected", {
            trackerId: tracker.trackerId,
            deviceId: tracker.deviceId,
            reason,
        });
    }

    #startTrackerTimer(state: TrackerState): void {
        clearTrackerTimer(state);
        const timer = setTimeout(() => {
            state.timer = undefined;
            if (!state.snapshot.connected) return;

            state.snapshot.connected = false;
            this.#emitter.emit("tracker:disconnected", {
                trackerId: state.snapshot.trackerId,
                deviceId: state.snapshot.deviceId,
                reason: "timeout",
            });
            this.#emitDevices();
        }, TRACKER_TIMEOUT_MS);

        // unref() so that the timer doesn't keep the process alive if nothing else is running
        if (typeof timer === "object" && "unref" in timer) timer.unref();
        state.timer = timer;
    }

    #onBattery(endpointId: string, slot: string, payload: string): void {
        const parsed = parseBattery(payload);
        if (!parsed) return;

        const device = this.#deviceAt(endpointId, slot);
        if (!device) return;

        const battery = {
            deviceId: device.deviceId,
            level: parsed.level,
            voltage: parsed.voltage,
            chargeStatus: parsed.chargeStatus,
            timestamp: Date.now(),
        };

        device.battery = battery;
        this.#emitter.emit("battery", battery);
        this.#emitDevices();
    }

    #onSettings(endpointId: string, slot: string, payload: string): void {
        const settings = decodeSettings(payload);
        if (!settings) return;

        const device = this.#deviceAt(endpointId, slot);
        if (!device) return;

        device.settings = settings;
        this.#emitter.emit("settings", { deviceId: device.deviceId, settings });
        this.#emitDevices();
    }

    // TODO: double check data if they are what they are meant to be lol, v3 is kinda hell
    #onImu(endpointId: string, slot: string, payload: string): void {
        const device = this.#deviceAt(endpointId, slot);
        if (!device) return; // drop packet if device is unidentified still

        const bytes = decodeBase64(payload);

        if (bytes.length >= 30 && device.trackers.length >= 2) {
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

        const tracker = device.trackers[imuIndex];
        if (!tracker) return;

        const state = this.#trackers.get(tracker.trackerId);
        if (!state) return;

        state.snapshot.lastSeen = Date.now();
        if (state.snapshot.connected) this.#startTrackerTimer(state);
        else {
            this.#connectTracker(state.snapshot);
            this.#emitDevices();
        }

        this.#emitter.emit("imu", {
            trackerId: tracker.trackerId,
            deviceId: device.deviceId,
            bodyPart: tracker.bodyPart,
            role,
            rotation: decoded.rotation,
            acceleration: decoded.acceleration,
            ...(decoded.ankleAngle === undefined ? {} : { ankleAngle: decoded.ankleAngle }),
            timestamp: Date.now(),
        });

        if (decoded.magStatus) this.#setMag(tracker, decoded.magStatus);
    }

    // magnetometer data is reported every IMU packet (on most devices), just emit on change
    #setMag(tracker: TrackerSnapshot, status: MagStatus): void {
        if (tracker.mag === status) return;

        tracker.mag = status;
        this.#emitter.emit("mag", { trackerId: tracker.trackerId, deviceId: tracker.deviceId, status });
        this.#emitDevices();
    }

    #updateChannel(endpointId: string, channel: number): void {
        if (this.#channels.get(endpointId) === channel) return;

        this.#channels.set(endpointId, channel);
        const descriptor = this.#endpoints.find((endpoint) => endpoint.id === endpointId);
        if (descriptor) descriptor.channel = channel;

        this.#log.info(`Channel of ${endpointId} is ${channel}`);
        this.#emitter.emit("channel", { endpointId, channel });
    }

    #deviceAt(endpointId: string, slot: string): DeviceSnapshot | undefined {
        const deviceId = this.#deviceByEndpointSlot.get(endpointSlotKey(endpointId, slot));
        return deviceId === undefined ? undefined : this.#devices.get(deviceId);
    }

    #forgetIdentity(endpointId: string, slot: string): void {
        this.#identities.delete(endpointSlotKey(endpointId, slot));

        const device = this.#deviceAt(endpointId, slot);
        if (!device) return;

        for (const tracker of device.trackers) {
            if (tracker.bodyPart === "unassigned") continue;

            tracker.bodyPart = "unassigned";
            this.#emitter.emit("identified", {
                trackerId: tracker.trackerId,
                deviceId: device.deviceId,
                bodyPart: "unassigned",
            });
        }

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
        for (const [i, command] of commands.entries()) {
            if (i > 0) await delay(PAIRING_COMMAND_DELAY_MS);
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

    #dropDevices(endpointId: string, reason: DisconnectReason): void {
        const devices = [...this.#devices.values()].filter((device) => device.endpointId === endpointId);
        if (devices.length === 0) return;

        for (const device of devices) {
            for (const tracker of device.trackers) this.#disconnectTracker(tracker, reason);
        }

        for (const device of devices) {
            this.#devices.delete(device.deviceId);
            this.#deviceByEndpointSlot.delete(endpointSlotKey(device.endpointId, device.slot));
            this.#emitter.emit("device:disconnected", {
                deviceId: device.deviceId,
                endpointId: device.endpointId,
                reason,
            });
        }

        this.#emitDevices();
    }

    #emitDevices(): void {
        this.#emitter.emit("devices", { devices: this.getDevices() });
    }

    #onLost(endpointId: string, reason: DisconnectReason): void {
        if (!this.#open.delete(endpointId)) return;

        this.#dropDevices(endpointId, reason);
        this.#forgetEndpoint(endpointId);
        this.#emitter.emit("endpoint:disconnected", { endpointId, reason });
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

function endpointSlotKey(endpointId: string, slot: string): string {
    return `${endpointId}:${slot}`;
}

function unassignedParts(count: number): BodyPart[] {
    return Array.from({ length: count }, () => "unassigned");
}

function clearTrackerTimer(tracker: TrackerState): void {
    if (tracker.timer === undefined) return;
    clearTimeout(tracker.timer);
    tracker.timer = undefined;
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

// what the per-slot "r(x):" messages tell us about the tracker
interface TrackerIdentity {
    dongleId: string;
    bodyPart: BodyPart;
}

interface TrackerState {
    snapshot: TrackerSnapshot;
    timer?: ReturnType<typeof setTimeout>;
}

type PairingResult = "paired" | "cancelled" | "timeout";

interface PendingPairing {
    resolve: (result: PairingResult) => void;
    timer: ReturnType<typeof setTimeout>;
}
