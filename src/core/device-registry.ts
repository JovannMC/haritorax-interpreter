import type { Emitter } from "../lib/emitter.js";
import type { Logger } from "../lib/logging.js";
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
} from "../types.js";

const TRACKER_TIMEOUT_MS = 10_000;

export interface DeviceRegistryOptions {
    emitter: Emitter;
    log: Logger;
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
}

export class DeviceRegistry {
    readonly #emitter: Emitter;
    readonly #log: Logger;

    // deviceId is the device serial number
    readonly #devices = new Map<string, DeviceSnapshot>();
    readonly #deviceByEndpointSlot = new Map<string, string>();
    readonly #trackers = new Map<string, TrackerState>();

    constructor(options: DeviceRegistryOptions) {
        this.#emitter = options.emitter;
        this.#log = options.log;
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
        const deviceId = this.#deviceByEndpointSlot.get(endpointSlotKey(endpointId, slot));
        return deviceId === undefined ? undefined : this.#devices.get(deviceId);
    }

    /*
     * device lifecycle
     */

    // create, refresh, move, or replace a device from an info packet
    register(input: DeviceRegistration): DeviceSnapshot {
        const { deviceId, endpointId, slot } = input;
        const imuCount = input.parts.length;
        const key = endpointSlotKey(endpointId, slot);
        const previousSerial = this.#deviceByEndpointSlot.get(key);

        // if a different serial is on this endpoint/slot, disconnect and replace it
        // e.g. different dongle, different device paired to same slot
        if (previousSerial !== undefined && previousSerial !== deviceId) {
            this.#log.warn(`Replacing device "${previousSerial}" on ${key} with "${deviceId}"`);

            const previous = this.#devices.get(previousSerial);
            if (previous) {
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

            // ..so update the endpoint/slot mapping if it changed
            if (oldKey !== key) {
                this.#deviceByEndpointSlot.delete(oldKey);
                this.#deviceByEndpointSlot.set(key, deviceId);
                existing.endpointId = endpointId;
                existing.slot = slot;
                existing.connection = input.connection;
                for (const tracker of existing.trackers) tracker.endpointId = endpointId;
            }

            existing.model = input.model;
            if (input.version) existing.version = input.version;
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
            ...(input.version ? { version: input.version } : {}),
            connection: input.connection,
            trackers: this.#createTrackers(deviceId, endpointId, input.parts),
        };

        this.#devices.set(deviceId, device);
        this.#deviceByEndpointSlot.set(key, deviceId);

        this.#emitter.emit("device:connected", {
            deviceId,
            endpointId,
            slot,
            connection: input.connection,
            model: input.model,
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
                const created = this.#createTracker(deviceId, device.endpointId, index, bodyPart);
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

        device.battery = battery;
        this.#emitter.emit("battery", battery);
    }

    setSettings(deviceId: string, settings: TrackerSettings): void {
        const device = this.#devices.get(deviceId);
        if (!device) return;
        if (device.settings && settingsEqual(device.settings, settings)) return;

        device.settings = settings;
        this.#emitter.emit("settings", { deviceId, settings });
        this.#emitDevices();
    }

    /*
     * tracker lifecycle
     */

    // updates lastSeen and reconnects the tracker if it timed out earlier
    trackerSeen(trackerId: string): TrackerSnapshot | undefined {
        const state = this.#trackers.get(trackerId);
        if (!state) return undefined;

        state.snapshot.lastSeen = Date.now();
        state.deadline = state.snapshot.lastSeen + TRACKER_TIMEOUT_MS;

        if (state.snapshot.connected) {
            if (!state.timer) this.#armTrackerTimeout(state);
        } else {
            this.#connectTracker(state.snapshot);
            this.#emitDevices();
        }

        return state.snapshot;
    }

    disconnectTracker(tracker: TrackerSnapshot, reason: DisconnectReason): void {
        const state = this.#trackers.get(tracker.trackerId);
        if (state) {
            clearTrackerTimeout(state);
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

    // magnetometer data is reported every IMU packet on most devices (all but wired trackers), just emit on change
    setMag(trackerId: string, status: MagStatus): void {
        const state = this.#trackers.get(trackerId);
        if (!state || state.snapshot.mag === status) return;

        state.snapshot.mag = status;
        this.#emitter.emit("mag", { trackerId, deviceId: state.snapshot.deviceId, status });
    }

    // taps are recorded and stay on the tracker for a second before resetting
    setTap(trackerId: string, count: number): void {
        const state = this.#trackers.get(trackerId);
        if (!state || state.snapshot.tap === count) return;

        state.snapshot.tap = count;
        this.#emitter.emit("tap", { trackerId, deviceId: state.snapshot.deviceId, count });
    }

    setAccelAccuracy(trackerId: string, accuracy: AccelAccuracy): void {
        const state = this.#trackers.get(trackerId);
        if (!state || state.snapshot.accelAccuracy === accuracy) return;

        state.snapshot.accelAccuracy = accuracy;
        this.#emitter.emit("accelAccuracy", { trackerId, deviceId: state.snapshot.deviceId, accuracy });
    }

    setRssi(trackerId: string, dongleRssi: number, sensorRssi?: number): void {
        const state = this.#trackers.get(trackerId);
        if (!state || state.snapshot.rssi === dongleRssi) return;

        state.snapshot.rssi = dongleRssi;
        state.snapshot.sensorRssi = sensorRssi;
        this.#emitter.emit("rssi", {
            trackerId,
            deviceId: state.snapshot.deviceId,
            rssi: dongleRssi,
            ...(sensorRssi === undefined ? {} : { sensorRssi }),
        });
    }

    markTrackerLost(trackerId: string, reason: DisconnectReason): void {
        const state = this.#trackers.get(trackerId);
        if (!state || !state.snapshot.connected) return;

        clearTrackerTimeout(state);
        state.snapshot.connected = false;
        state.snapshot.rssi = undefined;
        state.snapshot.sensorRssi = undefined;

        this.#emitter.emit("tracker:disconnected", {
            trackerId: state.snapshot.trackerId,
            deviceId: state.snapshot.deviceId,
            reason,
        });
        this.#emitDevices();
    }

    removeDevicesAtEndpoint(endpointId: string, reason: DisconnectReason): void {
        const devices = [...this.#devices.values()].filter((device) => device.endpointId === endpointId);
        if (devices.length === 0) return;

        for (const device of devices) {
            for (const tracker of device.trackers) this.disconnectTracker(tracker, reason);
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

    dispose(): void {
        for (const tracker of this.#trackers.values()) clearTrackerTimeout(tracker);
        this.#trackers.clear();
        this.#deviceByEndpointSlot.clear();
        this.#devices.clear();
    }

    /*
     * internals
     */

    #createTrackers(deviceId: string, endpointId: string, parts: readonly BodyPart[]): TrackerSnapshot[] {
        return parts.map((bodyPart, index) => this.#createTracker(deviceId, endpointId, index, bodyPart));
    }

    #createTracker(deviceId: string, endpointId: string, index: number, bodyPart: BodyPart): TrackerSnapshot {
        const tracker: TrackerSnapshot = {
            // stable tracker id used everywhere as "serialNumber:imuIndex" (e.g. A00000:1)
            // imuIndex identifies multiple IMUs (like HX2 leg/thigh combo)
            trackerId: `${deviceId}:${index}`,
            deviceId,
            endpointId,
            bodyPart,
            connected: false,
        };

        this.#trackers.set(tracker.trackerId, { snapshot: tracker, deadline: 0 });
        return tracker;
    }

    #connectTracker(tracker: TrackerSnapshot): void {
        const state = this.#trackers.get(tracker.trackerId);
        if (!state) return;

        tracker.connected = true;
        state.deadline = Date.now() + TRACKER_TIMEOUT_MS;
        this.#emitter.emit("tracker:connected", {
            trackerId: tracker.trackerId,
            deviceId: tracker.deviceId,
            endpointId: tracker.endpointId,
            bodyPart: tracker.bodyPart,
        });
        this.#armTrackerTimeout(state);
    }

    #armTrackerTimeout(state: TrackerState): void {
        clearTrackerTimeout(state);
        this.#scheduleTrackerTimeout(state, TRACKER_TIMEOUT_MS);
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
        this.#emitter.emit("devices", { devices: this.listDevices() });
    }
}

export function endpointSlotKey(endpointId: string, slot: string): string {
    return `${endpointId}:${slot}`;
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
}
