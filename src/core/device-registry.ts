import type { Emitter } from "../lib/emitter.js";
import type { Logger } from "../lib/logging.js";
import { wiredModelFromFirmware } from "../protocol/codec/messages.js";
import type {
    AccelAccuracy,
    BatteryInfo,
    BodyPart,
    ConnectionKind,
    DeviceSnapshot,
    DisconnectReason,
    MagStatus,
    TrackerModel,
    TrackerSettings,
    TrackerSnapshot,
    WiredComm,
} from "../types.js";

const TRACKER_TIMEOUT_MS = 10_000;
const DEFAULT_BLE_TRACKER_TIMEOUT_MS = 3_000;

export interface DeviceRegistryOptions {
    emitter: Emitter;
    log: Logger;
    bleTrackerTimeoutMs?: number;
}

export interface DeviceRegistration {
    deviceId: string;
    endpointId: string;
    slot: string;
    model: TrackerModel;
    firmwareModel: string;
    version: string;
    reportedImuCount: number | undefined;
    connection: ConnectionKind;
    parts: readonly BodyPart[];
    comm?: WiredComm;
    commNext?: WiredComm;
}

export class DeviceRegistry {
    readonly #emitter: Emitter;
    readonly #log: Logger;
    readonly #bleTrackerTimeoutMs: number;

    // deviceId is the device serial number
    readonly #devices = new Map<string, DeviceSnapshot>();
    readonly #registrations = new Map<string, DeviceRegistration>();
    readonly #trackers = new Map<string, TrackerState>();

    constructor(options: DeviceRegistryOptions) {
        this.#emitter = options.emitter;
        this.#log = options.log;
        this.#bleTrackerTimeoutMs = options.bleTrackerTimeoutMs ?? DEFAULT_BLE_TRACKER_TIMEOUT_MS;
        if (!Number.isFinite(this.#bleTrackerTimeoutMs) || this.#bleTrackerTimeoutMs <= 0) {
            throw new RangeError("bleTrackerTimeoutMs must be a positive finite number");
        }
    }

    /*
     * queries
     */

    listDevices(): DeviceSnapshot[] {
        return [...this.#devices.values()];
    }

    getDevice(deviceId: string): DeviceSnapshot | undefined {
        return this.#devices.get(deviceId);
    }

    listTrackers(): TrackerSnapshot[] {
        return [...this.#trackers.values()].map((tracker) => tracker.snapshot);
    }

    getTracker(trackerId: string): TrackerSnapshot | undefined {
        return this.#trackers.get(trackerId)?.snapshot;
    }

    getBodyPart(trackerId: string): BodyPart | undefined {
        return this.#trackers.get(trackerId)?.snapshot.bodyPart;
    }

    deviceAt(endpointId: string, slot: string): DeviceSnapshot | undefined {
        const registration = this.registrationAt(endpointId, slot);
        const device = registration && this.#devices.get(registration.deviceId);
        return device?.endpointId === endpointId && device.slot === slot ? device : undefined;
    }

    registrationAt(endpointId: string, slot: string): DeviceRegistration | undefined {
        return this.#registrations.get(endpointSlotKey(endpointId, slot));
    }

    /*
     * device lifecycle
     */

    // create, refresh, move, or replace a device from an info packet (of the same endpoint/slot) or a new registration (of the same deviceId)
    register(input: DeviceRegistration, activate = true): DeviceSnapshot {
        const { deviceId, endpointId, slot } = input;
        const imuCount = input.parts.length;
        const key = endpointSlotKey(endpointId, slot);
        const previousSerial = this.#registrations.get(key)?.deviceId;
        this.#registrations.set(key, input);

        // if a different serial is on this endpoint/slot, disconnect and replace it
        // e.g. different dongle, different device paired to same slot
        if (previousSerial !== undefined && previousSerial !== deviceId) {
            this.#log.warn(`Replacing device "${previousSerial}" on ${key} with "${deviceId}"`);

            const previous = this.#devices.get(previousSerial);
            if (previous?.endpointId === endpointId && previous.slot === slot) {
                this.#log.info(`Disconnecting previous device ${previousSerial} on ${key}`);
                for (const tracker of previous.trackers) this.disconnectTracker(tracker, "requested");
                this.#devices.delete(previousSerial);
                this.#emitter.emit("device:disconnected", {
                    deviceId: previous.deviceId,
                    endpointId: previous.endpointId,
                    reason: "requested",
                });
            }
        }

        const existing = this.#devices.get(deviceId);

        // we know the serial number but it might have moved to a different endpoint/slot (e.g. reused USB path)
        if (existing) {
            const oldKey = endpointSlotKey(existing.endpointId, existing.slot);

            if (oldKey !== key) {
                if (!activate) return existing;
                this.#log.info(`Moved ${deviceId} from ${oldKey} (${existing.connection}) to ${key} (${input.connection})`);

                existing.endpointId = endpointId;
                existing.slot = slot;
                existing.connection = input.connection;
                this.#updateTrackerTimeouts(existing, input.connection);

                for (const tracker of existing.trackers) {
                    tracker.endpointId = endpointId;
                    tracker.rssi = undefined;
                    tracker.sensorRssi = undefined;
                }
            }

            if (
                existing.trackers.length !== input.parts.length ||
                existing.trackers.some((tracker, index) => tracker.bodyPart !== input.parts[index])
            ) {
                this.setTrackers(deviceId, input.parts);
            }

            existing.model = input.model;
            const wiredModel = input.model === "wired" ? wiredModelFromFirmware(input.firmwareModel) : undefined;
            if (wiredModel === undefined) delete existing.wiredModel;
            else existing.wiredModel = wiredModel;
            if (input.version) existing.version = input.version;
            if (input.comm === undefined) delete existing.comm;
            else existing.comm = input.comm;
            if (input.commNext === undefined) delete existing.commNext;
            else existing.commNext = input.commNext;
            this.#emitInfo(input);
            this.#emitDevices();
            return existing;
        }

        const device: DeviceSnapshot = {
            deviceId,
            endpointId,
            slot,
            imuCount,
            model: input.model,
            ...(input.model === "wired" && wiredModelFromFirmware(input.firmwareModel)
                ? { wiredModel: wiredModelFromFirmware(input.firmwareModel) }
                : {}),
            ...(input.version ? { version: input.version } : {}),
            ...(input.comm === undefined ? {} : { comm: input.comm }),
            ...(input.commNext === undefined ? {} : { commNext: input.commNext }),
            connection: input.connection,
            trackers: this.#createTrackers(deviceId, endpointId, input.parts, input.connection),
        };

        this.#devices.set(deviceId, device);

        this.#emitter.emit("device:connected", {
            deviceId,
            endpointId,
            slot,
            connection: input.connection,
            model: input.model,
            ...(input.model === "wired" && wiredModelFromFirmware(input.firmwareModel)
                ? { wiredModel: wiredModelFromFirmware(input.firmwareModel) }
                : {}),
            imuCount,
        });
        this.#emitInfo(input);

        for (const tracker of device.trackers) this.#connectTracker(tracker);
        this.#emitDevices();
        return device;
    }

    // replace the tracker layout without recreating the device
    // for example if tracker identity changes (like different number of IMUs) and (soon) for wired trackers, if they add/remove trackers during a session
    setTrackers(deviceId: string, parts: readonly BodyPart[]): void {
        const device = this.#devices.get(deviceId);
        if (!device) return;

        for (const [index, bodyPart] of parts.entries()) {
            const tracker = device.trackers[index];

            if (!tracker) {
                const created = this.#createTracker(deviceId, device.endpointId, index, bodyPart, device.connection);
                device.trackers.push(created);
                this.#connectTracker(created);
                continue;
            }

            if (tracker.bodyPart === bodyPart) continue;

            tracker.bodyPart = bodyPart;
            this.#emitter.emit("identified", { trackerId: tracker.trackerId, deviceId, bodyPart });
        }

        for (const tracker of device.trackers.slice(parts.length)) this.disconnectTracker(tracker, "requested");

        device.trackers.length = parts.length;
        device.imuCount = parts.length;
        this.#emitDevices();
    }

    setBattery(deviceId: string, battery: BatteryInfo): void {
        const device = this.#devices.get(deviceId);
        if (!device) return;

        device.battery = { ...battery };
        this.#emitter.emit("battery", { ...battery });
    }

    setSettings(deviceId: string, settings: TrackerSettings): void {
        const device = this.#devices.get(deviceId);
        if (!device) return;
        if (device.settings && settingsEqual(device.settings, settings)) return;

        device.settings = { ...settings, sensorAutoCorrection: [...settings.sensorAutoCorrection] };
        this.#emitter.emit("settings", {
            deviceId,
            settings: { ...device.settings, sensorAutoCorrection: [...device.settings.sensorAutoCorrection] },
        });
        this.#emitDevices();
    }

    /*
     * tracker lifecycle
     */

    // updates lastSeen and reconnects the tracker if it timed out earlier
    trackerSeen(trackerId: string): TrackerSnapshot | undefined {
        const state = this.#trackers.get(trackerId);
        if (!state) return undefined;

        this.#markTrackerSeen(state);
        return state.snapshot;
    }

    // updates activity and status using one tracker lookup for an IMU sample
    trackerSeenWithImuStatus(trackerId: string, magStatus?: MagStatus, tap?: number): TrackerSnapshot | undefined {
        const state = this.#trackers.get(trackerId);
        if (!state) return undefined;

        const wasConnected = state.snapshot.connected;
        this.#markTrackerSeen(state);
        if (!wasConnected) {
            if (this.#trackers.get(trackerId) !== state) return undefined;
            if (magStatus !== undefined) this.setMag(trackerId, magStatus);
            if (tap !== undefined) this.setTap(trackerId, tap);
            return this.#trackers.get(trackerId) === state ? state.snapshot : undefined;
        }

        if (magStatus !== undefined && this.#setMagState(state, magStatus) && this.#trackers.get(trackerId) !== state)
            return undefined;
        if (tap !== undefined && this.#setTapState(state, tap) && this.#trackers.get(trackerId) !== state) return undefined;

        return state.snapshot;
    }

    #markTrackerSeen(state: TrackerState): void {
        state.snapshot.lastSeen = Date.now();
        state.deadline = state.snapshot.lastSeen + state.timeoutMs;

        if (state.snapshot.connected) {
            if (!state.timer) this.#armTrackerTimeout(state);
        } else {
            this.#log.debug(`Tracker data resumed for ${state.snapshot.trackerId}`, {
                deviceId: state.snapshot.deviceId,
                endpointId: state.snapshot.endpointId,
                lastSeen: state.snapshot.lastSeen,
            });
            this.#connectTracker(state.snapshot);
            this.#emitDevices();
        }
    }

    disconnectTracker(tracker: TrackerSnapshot, reason: DisconnectReason): void {
        const state = this.#trackers.get(tracker.trackerId);
        if (state) {
            clearTrackerTimeout(state);
            this.#trackers.delete(tracker.trackerId);
        }

        if (!tracker.connected) return;

        this.#log.debug(`Tracker disconnected: ${tracker.trackerId}`, {
            deviceId: tracker.deviceId,
            endpointId: tracker.endpointId,
            reason,
        });
        tracker.connected = false;
        this.#emitter.emit("tracker:disconnected", {
            trackerId: tracker.trackerId,
            deviceId: tracker.deviceId,
            reason,
        });
    }

    // magnetometer data is reported every IMU packet on most devices (all but wired trackers), just emit on change
    setMag(trackerId: string, status: MagStatus): void {
        const state = this.#trackers.get(trackerId);
        if (!state) return;

        this.#setMagState(state, status);
    }

    #setMagState(state: TrackerState, status: MagStatus): boolean {
        if (state.snapshot.mag === status) return false;

        state.snapshot.mag = status;
        this.#emitter.emit("mag", { trackerId: state.snapshot.trackerId, deviceId: state.snapshot.deviceId, status });
        return true;
    }

    // taps are recorded and stay on the tracker for a second before resetting
    setTap(trackerId: string, count: number): void {
        const state = this.#trackers.get(trackerId);
        if (!state) return;

        this.#setTapState(state, count);
    }

    #setTapState(state: TrackerState, count: number): boolean {
        if (state.snapshot.tap === count) return false;

        state.snapshot.tap = count;
        this.#emitter.emit("tap", { trackerId: state.snapshot.trackerId, deviceId: state.snapshot.deviceId, count });
        return true;
    }

    setAccelAccuracy(trackerId: string, accuracy: AccelAccuracy): void {
        const state = this.#trackers.get(trackerId);
        if (!state || state.snapshot.accelAccuracy === accuracy) return;

        state.snapshot.accelAccuracy = accuracy;
        this.#emitter.emit("accelAccuracy", { trackerId, deviceId: state.snapshot.deviceId, accuracy });
    }

    setRssi(trackerId: string, dongleRssi: number, sensorRssi?: number): void {
        const state = this.#trackers.get(trackerId);
        if (!state || (state.snapshot.rssi === dongleRssi && state.snapshot.sensorRssi === sensorRssi)) return;

        state.snapshot.rssi = dongleRssi;
        state.snapshot.sensorRssi = sensorRssi;
        this.#emitter.emit("rssi", {
            trackerId,
            deviceId: state.snapshot.deviceId,
            rssi: dongleRssi,
            ...(sensorRssi === undefined ? {} : { sensorRssi }),
        });
    }

    markTrackerLost(trackerId: string, reason: DisconnectReason): boolean {
        const state = this.#trackers.get(trackerId);
        if (!state || !state.snapshot.connected) return false;

        clearTrackerTimeout(state);
        state.snapshot.connected = false;
        state.snapshot.rssi = undefined;
        state.snapshot.sensorRssi = undefined;
        this.#log.debug(`Tracker marked lost: ${trackerId}`, {
            deviceId: state.snapshot.deviceId,
            endpointId: state.snapshot.endpointId,
            reason,
            lastSeen: state.snapshot.lastSeen,
        });

        this.#emitter.emit("tracker:disconnected", {
            trackerId: state.snapshot.trackerId,
            deviceId: state.snapshot.deviceId,
            reason,
        });
        this.#emitDevices();
        return true;
    }

    removeDevicesAtEndpoint(endpointId: string, reason: DisconnectReason): void {
        for (const [key, input] of this.#registrations) {
            if (input.endpointId === endpointId) this.#registrations.delete(key);
        }

        const devices = [...this.#devices.values()].filter((device) => device.endpointId === endpointId);
        if (devices.length === 0) return;

        for (const device of devices) {
            for (const tracker of device.trackers) this.disconnectTracker(tracker, reason);
        }

        for (const device of devices) {
            this.#devices.delete(device.deviceId);
            this.#emitter.emit("device:disconnected", {
                deviceId: device.deviceId,
                endpointId: device.endpointId,
                reason,
            });
        }

        this.#emitDevices();
    }

    dispose(): void {
        for (const tracker of this.#trackers.values()) clearTrackerTimeout(tracker);
        this.#trackers.clear();
        this.#registrations.clear();
        this.#devices.clear();
    }

    /*
     * internals
     */

    #createTrackers(
        deviceId: string,
        endpointId: string,
        parts: readonly BodyPart[],
        connection: ConnectionKind,
    ): TrackerSnapshot[] {
        return parts.map((bodyPart, index) => this.#createTracker(deviceId, endpointId, index, bodyPart, connection));
    }

    #createTracker(
        deviceId: string,
        endpointId: string,
        index: number,
        bodyPart: BodyPart,
        connection: ConnectionKind,
    ): TrackerSnapshot {
        const tracker: TrackerSnapshot = {
            // stable tracker id used everywhere as "serialNumber:imuIndex" (e.g. A00000:1)
            // imuIndex identifies multiple IMUs (like HX2 leg/thigh combo)
            trackerId: `${deviceId}:${index}`,
            deviceId,
            endpointId,
            bodyPart,
            connected: false,
        };

        this.#trackers.set(tracker.trackerId, {
            snapshot: tracker,
            deadline: 0,
            timeoutMs: connection === "ble" ? this.#bleTrackerTimeoutMs : TRACKER_TIMEOUT_MS,
        });
        return tracker;
    }

    #connectTracker(tracker: TrackerSnapshot): void {
        const state = this.#trackers.get(tracker.trackerId);
        if (!state) return;

        tracker.connected = true;
        state.deadline = Date.now() + state.timeoutMs;
        this.#log.debug(`Tracker connected: ${tracker.trackerId}`, {
            deviceId: tracker.deviceId,
            endpointId: tracker.endpointId,
            bodyPart: tracker.bodyPart,
            timeoutMs: state.timeoutMs,
        });
        this.#emitter.emit("tracker:connected", {
            trackerId: tracker.trackerId,
            deviceId: tracker.deviceId,
            endpointId: tracker.endpointId,
            bodyPart: tracker.bodyPart,
        });
        this.#armTrackerTimeout(state);
    }

    #updateTrackerTimeouts(device: DeviceSnapshot, connection: ConnectionKind): void {
        const timeoutMs = connection === "ble" ? this.#bleTrackerTimeoutMs : TRACKER_TIMEOUT_MS;
        for (const tracker of device.trackers) {
            const state = this.#trackers.get(tracker.trackerId);
            if (!state) continue;
            state.timeoutMs = timeoutMs;
            if (!tracker.connected) continue;

            state.deadline = (tracker.lastSeen ?? Date.now()) + timeoutMs;
            this.#scheduleTrackerTimeout(state, Math.max(0, state.deadline - Date.now()));
        }
    }

    #armTrackerTimeout(state: TrackerState): void {
        clearTrackerTimeout(state);
        this.#scheduleTrackerTimeout(state, state.timeoutMs);
    }

    #scheduleTrackerTimeout(state: TrackerState, delayMs: number): void {
        const timer = setTimeout(() => {
            const remaining = state.deadline - Date.now();
            if (remaining > 0) {
                this.#scheduleTrackerTimeout(state, remaining);
                return;
            }

            state.timer = undefined;
            if (!state.snapshot.connected) return;

            state.snapshot.connected = false;
            this.#log.debug(`Tracker timed out: ${state.snapshot.trackerId}`, {
                deviceId: state.snapshot.deviceId,
                endpointId: state.snapshot.endpointId,
                timeoutMs: state.timeoutMs,
                lastSeen: state.snapshot.lastSeen,
            });
            this.#emitter.emit("tracker:disconnected", {
                trackerId: state.snapshot.trackerId,
                deviceId: state.snapshot.deviceId,
                reason: "timeout",
            });
            this.#emitDevices();
        }, delayMs);

        // unref() so that the timer doesn't keep the process alive if nothing else is running
        if (typeof timer === "object" && "unref" in timer) timer.unref();
        state.timer = timer;
    }

    #emitInfo(input: DeviceRegistration): void {
        this.#emitter.emit("info", {
            deviceId: input.deviceId,
            version: input.version,
            model: input.firmwareModel,
            imuCount: input.reportedImuCount,
            timestamp: Date.now(),
        });
    }

    #emitDevices(): void {
        this.#emitter.emit("devices", { devices: this.listDevices().map(copyDeviceSnapshot) });
    }
}

export function endpointSlotKey(endpointId: string, slot: string): string {
    return `${endpointId}:${slot}`;
}

export function copyDeviceSnapshot(device: DeviceSnapshot): DeviceSnapshot {
    return {
        ...device,
        trackers: device.trackers.map((tracker) => ({ ...tracker })),
        ...(device.battery ? { battery: { ...device.battery } } : {}),
        ...(device.settings
            ? { settings: { ...device.settings, sensorAutoCorrection: [...device.settings.sensorAutoCorrection] } }
            : {}),
    };
}

export function copyTrackerSnapshot(tracker: TrackerSnapshot): TrackerSnapshot {
    return { ...tracker };
}

function settingsEqual(a: TrackerSettings, b: TrackerSettings): boolean {
    return (
        a.sensorMode === b.sensorMode &&
        a.fpsMode === b.fpsMode &&
        a.ankleMotionDetection === b.ankleMotionDetection &&
        correctionBits(a) === correctionBits(b)
    );
}

function correctionBits(settings: TrackerSettings): number {
    let bits = 0;
    if (settings.sensorAutoCorrection.includes("accel")) bits |= 1;
    if (settings.sensorAutoCorrection.includes("gyro")) bits |= 2;
    if (settings.sensorAutoCorrection.includes("mag")) bits |= 4;
    return bits;
}

function clearTrackerTimeout(state: TrackerState): void {
    if (state.timer === undefined) return;
    clearTimeout(state.timer);
    state.timer = undefined;
}

interface TrackerState {
    snapshot: TrackerSnapshot;
    timer?: ReturnType<typeof setTimeout>;
    deadline: number;
    timeoutMs: number;
}
