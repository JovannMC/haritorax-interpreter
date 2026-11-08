import { HaritoraXError, SettingsWriteError } from "../../lib/errors.js";
import type { Emitter } from "../../lib/emitter.js";
import type { Logger } from "../../lib/logging.js";
import type { DeviceRegistry } from "../device-registry.js";
import type { ProtocolHandler } from "../protocol-handler.js";
import { bodyPartsFor, isButtonDebounced, trackerIdOfBodyPart } from "../../protocol/endpoint/dongle.js";
import { decodeImuBytes, decodeImuBytesAt, decodeRange } from "../../protocol/codec/imu.js";
import { bodyPartNotifies, hasSensor2 } from "../../protocol/firmware.js";
import { modelFromFirmware, wiredModelFromFirmware } from "../../protocol/codec/messages.js";
import {
    bleAccelAccuracy,
    bleAutoCorrection,
    bleBatteryVoltage,
    bleBodyPart,
    bleChargeStatus,
    bleFpsMode,
    bleMagStatusAt,
    bleSensorMode,
    bleSettingValues,
    bleText,
    bleUint8,
    bleWiredMagStatusAt,
    splitBleImu,
    splitBleSensor2Frames,
    type BleCharacteristic,
} from "../../protocol/endpoint/ble.js";
import { splitWiredImuBytes, wiredPartsFor } from "../../protocol/endpoint/wired.js";
import type {
    BatteryInfo,
    BodyPart,
    ConnectionKind,
    DeviceSnapshot,
    FpsMode,
    ImuRole,
    SensorAutoCorrection,
    SensorMode,
    TrackerModel,
    TrackerSetting,
    TrackerSettings,
    TrackerSnapshot,
    SettingsApplyResult,
    SettingsWriteFailure,
} from "../../types.js";

const BLE_SLOT = "0";
const BODY_PART_TIMEOUT_MS = 2_000;
const MAX_BLE_BODY_PART_ID = 15;
const SENSOR2_FALLBACK_MS = 250;
const SENSOR2_RECOVERY_FRAMES = 3;
const SENSOR2_MAX_FRAME_PERIODS = 4;
const BLE_LATENCY_INTERVAL_MS = 5_000;

export interface BleControllerOptions {
    emitter: Emitter;
    log: Logger;
    registry: DeviceRegistry;
    connectionKind: (endpointId: string) => ConnectionKind;
    write: (endpointId: string, characteristic: BleCharacteristic, data: Uint8Array) => Promise<void>;
    read: (endpointId: string, characteristic: BleCharacteristic) => Promise<Uint8Array | undefined>;
    buttonDebounceMs?: number;
}

export class BleController implements ProtocolHandler {
    readonly #emitter: Emitter;
    readonly #log: Logger;
    readonly #registry: DeviceRegistry;
    readonly #connectionKind: (endpointId: string) => ConnectionKind;
    readonly #write: (endpointId: string, characteristic: BleCharacteristic, data: Uint8Array) => Promise<void>;
    readonly #read: (endpointId: string, characteristic: BleCharacteristic) => Promise<Uint8Array | undefined>;
    readonly #states = new Map<string, BleState>();
    readonly #lastButtonPress = new Map<string, number>();
    readonly #bodyPartWaits = new Map<string, BodyPartWait>();
    readonly #latencies = new Map<string, number>();
    readonly #latencyTimers = new Map<string, ReturnType<typeof setInterval>>();
    readonly #latencyGenerations = new Map<string, number>();
    readonly #latencyReads = new Set<string>();
    #nextLatencyGeneration = 0;
    readonly #buttonDebounceMs: number;

    constructor(options: BleControllerOptions) {
        this.#emitter = options.emitter;
        this.#log = options.log;
        this.#registry = options.registry;
        this.#connectionKind = options.connectionKind;
        this.#write = options.write;
        this.#read = options.read;
        this.#buttonDebounceMs = options.buttonDebounceMs ?? 100;
    }

    handleFrame(): void {}

    handleBinaryFrame(endpointId: string, characteristic: string, data: Uint8Array): void {
        const state = this.#state(endpointId);

        switch (characteristic) {
            // for info packets if there is mismatching info, reset the device cache
            case "serial-number": {
                const serial = bleText(data);
                if (serial && serial !== state.serial) {
                    state.serial = serial;
                    state.device = undefined;
                }
                this.#ensureDevice(state);
                break;
            }
            case "model-number": {
                const firmware = bleText(data);
                if (firmware && firmware !== state.firmwareModel) {
                    state.firmwareModel = firmware;
                    state.model = this.#modelFromFirmware(firmware);
                    state.sensor2Supported = undefined;
                    this.#resetSensorSource(state);
                    state.device = undefined;
                }
                this.#ensureDevice(state);
                break;
            }
            case "software-revision": {
                const version = bleText(data);
                if (version && version !== state.version) {
                    state.version = version;
                    state.sensor2Supported = undefined;
                    this.#resetSensorSource(state);
                    state.device = undefined;
                    this.#ensureDevice(state);
                }
                break;
            }
            case "number-of-imu": {
                const count = bleUint8(data);
                if (count === undefined || count < 1 || count === state.imuCount) return;
                state.imuCount = count;
                state.device = undefined;
                this.#ensureDevice(state);
                break;
            }
            case "body-part": {
                const part = bleBodyPart(data);
                if (part && part !== state.bodyPart) {
                    state.bodyPart = part;
                    state.device = undefined;
                }
                this.#ensureDevice(state);

                const wait = this.#bodyPartWaits.get(endpointId);
                if (part && wait?.bodyPart === part) this.#finishBodyPartWait(endpointId, wait, true);
                break;
            }
            // take priority over "sensor" if available, includes mag status and tap count
            case "sensor2":
                this.#onSensor2(state, data);
                break;
            case "sensor":
                if (state.model === "wired") this.#onWiredSensor(state, data);
                else {
                    const now = Date.now();
                    state.sensorStartedAt ??= now;
                    const expectsSensor2 = state.model && (state.sensor2Supported ??= hasSensor2(state.model, state.version));
                    const preferredAt = state.sensor2LastSeen ?? (expectsSensor2 ? state.sensorStartedAt : undefined);
                    const sensor2Gap = state.sensor2LastSeen === undefined ? undefined : now - state.sensor2LastSeen;
                    const sensor2Unhealthy =
                        state.sensorSource === "sensor2" &&
                        sensor2Gap !== undefined &&
                        sensor2Gap > sensor2MaxGapMs(state.settings.fpsMode);
                    const sensor2TimedOut =
                        expectsSensor2 && preferredAt !== undefined && now - preferredAt >= SENSOR2_FALLBACK_MS;
                    if (state.sensorSource === "sensor" || sensor2Unhealthy || preferredAt === undefined || sensor2TimedOut) {
                        if (sensor2Unhealthy || sensor2TimedOut) state.sensor2FallbackActive = true;
                        this.#setSensorSource(state, "sensor");
                        this.#onSensor(state, data);
                    }
                }
                break;
            case "magnetometer": {
                const device = this.#ensureDevice(state);
                if (!device) return;
                for (const [index, tracker] of device.trackers.entries()) {
                    const status = state.model === "wired" ? bleWiredMagStatusAt(data, index) : bleMagStatusAt(data, index);
                    if (status) this.#registry.setMag(tracker.trackerId, status);
                }
                break;
            }
            case "accel-accuracy": {
                const device = this.#ensureDevice(state);
                if (!device) return;
                for (const index of [0, 1]) {
                    const tracker = device.trackers[index];
                    const accuracy = bleAccelAccuracy(data, index);
                    if (tracker && accuracy !== undefined) this.#registry.setAccelAccuracy(tracker.trackerId, accuracy);
                }
                break;
            }
            case "battery-level":
                state.battery.level = bleUint8(data);
                this.#maybeBattery(state);
                break;
            case "battery-voltage":
                state.battery.voltage = bleBatteryVoltage(data);
                this.#maybeBattery(state);
                break;
            case "charge-status":
                state.battery.chargeStatus = bleChargeStatus(data);
                this.#maybeBattery(state);
                break;
            case "main-button":
                if (state.model !== "wired" && !isLongPress(data)) this.#onButton(state, "main");
                break;
            case "secondary-button":
                if (!isNoWiredEvent(state, data)) this.#onButton(state, state.model === "wired" ? "main" : "sub");
                break;
            case "tertiary-button":
                if (!isNoWiredEvent(state, data)) this.#onButton(state, state.model === "wired" ? "sub" : "sub2");
                break;
            case "sensor-mode":
                state.settings.sensorMode = bleSensorMode(data);
                this.#maybeSettings(state);
                break;
            case "fps":
                state.settings.fpsMode = bleFpsMode(data);
                this.#maybeSettings(state);
                break;
            case "auto-calibration":
            case "wired-auto-calibration": {
                const value = bleUint8(data);
                if (value === undefined) return;
                state.settings.correction = bleAutoCorrection(value);
                this.#maybeSettings(state);
                break;
            }
            case "tof": {
                const value = bleUint8(data);
                if (value === undefined) return;
                state.settings.ankle = value !== 0;
                this.#maybeSettings(state);
                break;
            }
            default:
                return;
        }
    }

    async setSettings(endpointId: string, settings: TrackerSettings): Promise<SettingsApplyResult> {
        const state = this.#state(endpointId);
        const device = this.#ensureDevice(state);
        if (!device) throw new HaritoraXError("DEVICE_NOT_FOUND", `Unknown BLE tracker on "${endpointId}"`);

        const values = bleSettingValues(settings);
        const applied: TrackerSetting[] = [];
        const unsupported: TrackerSetting[] = [];
        const failures: SettingsWriteFailure[] = [];
        const apply = async (
            setting: TrackerSetting,
            characteristic: BleCharacteristic,
            value: number,
            optional = false,
        ): Promise<"applied" | "unsupported" | "failed"> => {
            try {
                await this.#write(endpointId, characteristic, new Uint8Array([value]));
                applied.push(setting);
                return "applied";
            } catch (error) {
                if (optional && error instanceof HaritoraXError && error.code === "NOT_SUPPORTED") {
                    unsupported.push(setting);
                    return "unsupported";
                }
                failures.push({
                    setting,
                    characteristic,
                    error: error instanceof Error ? error : new Error(String(error)),
                });

                return "failed";
            }
        };

        if ((await apply("sensorMode", "sensor-mode", values.sensorMode)) === "applied")
            state.settings.sensorMode = settings.sensorMode;
        if ((await apply("fpsMode", "fps", values.fpsMode)) === "applied") state.settings.fpsMode = settings.fpsMode;
        const calibrationCharacteristic = device.model === "wired" ? "wired-auto-calibration" : "auto-calibration";
        const calibrationResult = await apply(
            "sensorAutoCorrection",
            calibrationCharacteristic,
            values.autoCorrection,
            device.model === "wired",
        );

        if (calibrationResult === "applied") {
            state.settings.correction = [...settings.sensorAutoCorrection];
        }
        if ((await apply("ankleMotionDetection", "tof", values.tof)) === "applied")
            state.settings.ankle = settings.ankleMotionDetection;

        this.#maybeSettings(state);
        const result: SettingsApplyResult = { applied, unsupported };
        if (failures.length > 0) {
            throw new SettingsWriteError(result, failures);
        } else {
            this.#log.info(`Applied BLE settings to ${endpointId}`, {
                applied,
                unsupported,
            });
        }
        return result;
    }

    forgetEndpoint(endpointId: string): void {
        this.#stopLatencyPings(endpointId);
        this.#states.delete(endpointId);
        this.#cancelBodyPartWait(endpointId);
        this.#latencies.delete(endpointId);
        for (const key of this.#lastButtonPress.keys()) {
            if (key.startsWith(endpointId)) this.#lastButtonPress.delete(key);
        }
    }

    getLatency(endpointId: string): number | undefined {
        return this.#latencies.get(endpointId);
    }

    async refreshLatency(endpointId: string): Promise<number> {
        if (this.#latencyReads.has(endpointId))
            throw new HaritoraXError("BUSY", `A BLE latency read is already in progress for ${endpointId}`);

        this.#latencyReads.add(endpointId);
        const startedAt = performance.now();
        try {
            const response = await this.#read(endpointId, "battery-level");
            if (!response?.byteLength)
                throw new HaritoraXError("NOT_SUPPORTED", `Battery level is not readable on ${endpointId}`);

            const latency = performance.now() - startedAt;
            this.#latencies.set(endpointId, latency);

            return latency;
        } finally {
            this.#latencyReads.delete(endpointId);
        }
    }

    async refreshTracker(
        endpointId: string,
        readRssi: (() => Promise<number>) | undefined,
        onRssi: (rssi: number) => void,
    ): Promise<void> {
        const state = this.#state(endpointId);
        const characteristics: readonly BleCharacteristic[] = [
            "serial-number",
            "model-number",
            "software-revision",
            "number-of-imu",
            "body-part",
            "battery-level",
            "battery-voltage",
            "charge-status",
            "sensor-mode",
            "fps",
            "auto-calibration",
            "wired-auto-calibration",
            "magnetometer",
            "accel-accuracy",
        ];

        let completed = 0;
        const failures: Error[] = [];
        for (const characteristic of characteristics) {
            try {
                const data = await this.#read(endpointId, characteristic);
                if (data?.byteLength) {
                    this.handleBinaryFrame(endpointId, characteristic, data);
                    completed++;
                }
            } catch (error) {
                if (error instanceof HaritoraXError && error.code === "NOT_SUPPORTED") continue;
                failures.push(
                    new HaritoraXError("READ_FAILED", `BLE refresh read failed for ${endpointId}/${characteristic}`, {
                        cause: error,
                        connection: "ble",
                        endpointId,
                        operation: "refresh",
                        characteristic,
                    }),
                );
            }
        }

        if (readRssi) {
            try {
                onRssi(await readRssi());
                completed++;
            } catch (error) {
                if (!(error instanceof HaritoraXError && error.code === "NOT_SUPPORTED"))
                    failures.push(
                        new HaritoraXError("READ_FAILED", `BLE RSSI refresh failed for ${endpointId}`, {
                            cause: error,
                            connection: "ble",
                            endpointId,
                            operation: "rssi",
                        }),
                    );
            }
        }

        if (failures.length)
            throw new HaritoraXError("READ_FAILED", `Failed to refresh ${failures.length} tracker field(s) on ${endpointId}`, {
                cause: new AggregateError(failures),
                connection: "ble",
                endpointId,
                operation: "refresh",
            });
        if (completed === 0) throw new HaritoraXError("NOT_SUPPORTED", `No readable tracker information on ${endpointId}`);
        if (!this.#ensureDevice(state)) throw new HaritoraXError("DEVICE_NOT_FOUND", `Unknown BLE tracker on "${endpointId}"`);
    }

    async powerOff(endpointId: string): Promise<void> {
        const state = this.#state(endpointId);
        const device = this.#ensureDevice(state);
        if (!device) throw new HaritoraXError("DEVICE_NOT_FOUND", `Unknown BLE tracker on "${endpointId}"`);

        await this.#write(endpointId, "wireless-mode", new Uint8Array([2]));
        this.#log.info(`Sent BLE power-off command to ${endpointId}`);
    }

    // the tracker stores the body part itself and notifies it back, which also refreshes the trackers here
    async setBodyPart(endpointId: string, bodyPart: BodyPart): Promise<void> {
        const state = this.#state(endpointId);
        const device = this.#ensureDevice(state);
        if (!device) throw new HaritoraXError("DEVICE_NOT_FOUND", `Unknown BLE tracker on "${endpointId}"`);

        const id = trackerIdOfBodyPart(bodyPart);
        if (id === undefined || id > MAX_BLE_BODY_PART_ID) {
            throw new HaritoraXError("NOT_SUPPORTED", `"${bodyPart}" can't be assigned to a tracker over BLE`);
        }

        // older firmware doesn't notify, and no tracker notifies when it already has that body part
        const confirms = bodyPartNotifies(device.model, device.version) && state.bodyPart !== bodyPart;
        if (confirms && this.#bodyPartWaits.has(endpointId)) {
            throw new HaritoraXError("BUSY", `A body-part change is already in progress on ${endpointId}`);
        }
        const wait = confirms ? this.#createBodyPartWait(endpointId, bodyPart) : undefined;
        const needsReadback = !confirms && state.bodyPart !== bodyPart;

        try {
            await this.#write(endpointId, "body-part-write", new Uint8Array([id]));
        } catch (error) {
            if (wait) this.#finishBodyPartWait(endpointId, wait, undefined);
            throw error;
        }

        const confirmed = wait ? await wait.promise : true;
        if (confirmed === undefined) {
            throw new HaritoraXError("NOT_CONNECTED", `${endpointId} disconnected before confirming its body part`);
        }
        if (!confirmed) {
            throw new HaritoraXError(
                "TIMEOUT",
                `${device.deviceId} did not confirm the body part "${bodyPart}" in time. Its firmware may ignore the change, check its version`,
            );
        }

        if (needsReadback) {
            let readback: Uint8Array | undefined;
            try {
                readback = await this.#read(endpointId, "body-part");
            } catch (error) {
                throw new HaritoraXError("READ_FAILED", `Could not verify the body part of ${device.deviceId}`, { cause: error });
            }

            const actual = readback ? bleBodyPart(readback) : undefined;
            if (!readback || !actual) {
                throw new HaritoraXError("READ_FAILED", `Could not read back the body part of ${device.deviceId}`);
            }
            if (actual !== bodyPart) {
                throw new HaritoraXError(
                    "READ_FAILED",
                    `${device.deviceId} reports body part "${actual}" after requesting "${bodyPart}"`,
                );
            }

            this.handleBinaryFrame(endpointId, "body-part", readback);
        }

        this.#log.info(`Set body part of BLE ${endpointId} to ${bodyPart}`);
    }

    // swaps to GX dongle
    async switchCommunication(endpointId: string): Promise<void> {
        const state = this.#state(endpointId);
        const device = this.#ensureDevice(state);
        if (!device) throw new HaritoraXError("DEVICE_NOT_FOUND", `Unknown BLE tracker on "${endpointId}"`);

        await this.#write(endpointId, "wireless-mode", new Uint8Array([1]));
        this.#log.info(`Switching BLE ${endpointId} to serial`);
    }

    // wired trackers stay silent over BLE until sensor data control has 1 written to it
    async start(endpointId: string): Promise<void> {
        if (this.#states.get(endpointId)?.model === "wired") {
            await this.#write(endpointId, "sensor-data-control", new Uint8Array([1]));
            this.#log.info(`Started sensor data on BLE ${endpointId}`);
        }

        this.#startLatencyPings(endpointId);
    }

    dispose(): void {
        for (const endpointId of this.#latencyTimers.keys()) this.#stopLatencyPings(endpointId);
        for (const endpointId of this.#bodyPartWaits.keys()) this.#cancelBodyPartWait(endpointId);
        this.#states.clear();
        this.#latencies.clear();
        this.#lastButtonPress.clear();
    }

    #startLatencyPings(endpointId: string): void {
        if (this.#latencyTimers.has(endpointId)) return;

        const generation = ++this.#nextLatencyGeneration;
        this.#latencyGenerations.set(endpointId, generation);
        void this.#measureLatency(endpointId, generation);

        const timer = setInterval(() => void this.#measureLatency(endpointId, generation), BLE_LATENCY_INTERVAL_MS);
        if (typeof timer === "object" && "unref" in timer) timer.unref();
        this.#latencyTimers.set(endpointId, timer);
    }

    async #measureLatency(endpointId: string, generation: number): Promise<void> {
        if (this.#latencyReads.has(endpointId)) return;
        this.#latencyReads.add(endpointId);
        const startedAt = performance.now();

        try {
            const response = await this.#read(endpointId, "battery-level");
            if (this.#latencyGenerations.get(endpointId) !== generation) return;
            if (!response || response.byteLength === 0) {
                this.#log.debug(`BLE latency unavailable for ${endpointId}: battery-level is not readable`);
                this.#stopLatencyPings(endpointId);
                return;
            }

            this.#latencies.set(endpointId, performance.now() - startedAt);
        } catch (error) {
            if (this.#latencyGenerations.get(endpointId) !== generation) return;
            this.#emitter.emit("error", {
                error: error instanceof Error ? error : new Error(String(error)),
                connection: "ble",
                endpointId,
                operation: "latency-ping",
                characteristic: "battery-level",
            });
            this.#stopLatencyPings(endpointId);
        } finally {
            this.#latencyReads.delete(endpointId);
        }
    }

    #stopLatencyPings(endpointId: string): void {
        const timer = this.#latencyTimers.get(endpointId);
        if (timer !== undefined) clearInterval(timer);
        this.#latencyTimers.delete(endpointId);
        this.#latencyGenerations.delete(endpointId);
    }

    #createBodyPartWait(endpointId: string, bodyPart: BodyPart): BodyPartWait {
        let resolveWait!: (result: boolean | undefined) => void;
        const promise = new Promise<boolean | undefined>((resolve) => (resolveWait = resolve));
        const wait: BodyPartWait = {
            bodyPart,
            timer: setTimeout(() => {
                const current = this.#bodyPartWaits.get(endpointId);
                if (current) this.#finishBodyPartWait(endpointId, current, false);
            }, BODY_PART_TIMEOUT_MS),
            resolve: resolveWait,
            promise,
        };
        this.#bodyPartWaits.set(endpointId, wait);
        return wait;
    }

    #finishBodyPartWait(endpointId: string, wait: BodyPartWait, result: boolean | undefined): void {
        if (this.#bodyPartWaits.get(endpointId) !== wait) return;
        clearTimeout(wait.timer);
        this.#bodyPartWaits.delete(endpointId);
        wait.resolve(result);
    }

    #cancelBodyPartWait(endpointId: string): void {
        const wait = this.#bodyPartWaits.get(endpointId);
        if (wait) this.#finishBodyPartWait(endpointId, wait, undefined);
    }

    // IMU data, mag status, taps, ToF range
    #onSensor2(state: BleState, data: Uint8Array): void {
        const slices = splitBleSensor2Frames(data);
        if (slices.length === 0) throw new HaritoraXError("DECODE_FAILED", `Invalid BLE sensor frame on ${state.endpointId}`);
        const now = Date.now();
        const previousAt = state.sensor2LastSeen;
        state.sensor2LastSeen = now;

        if (state.sensor2FallbackActive) {
            const maxGap = sensor2MaxGapMs(state.settings.fpsMode);
            state.sensor2RecoveryFrames =
                previousAt !== undefined && now - previousAt <= maxGap ? (state.sensor2RecoveryFrames ?? 0) + 1 : 1;
            if (state.sensor2RecoveryFrames < SENSOR2_RECOVERY_FRAMES) return;
            state.sensor2FallbackActive = false;
        }

        this.#setSensorSource(state, "sensor2");

        const device = this.#ensureDevice(state, true);
        if (!device) return;

        this.#ensureImuCount(state, device, slices.length);

        for (const slice of slices) {
            const tracker = device.trackers[slice.index];
            if (!tracker) continue;

            this.#emitImu(device, tracker, slice.index, slice.role, data, slice.status, slice.range, slice.offset);
        }
    }

    // only IMU data and ToF range
    #onSensor(state: BleState, data: Uint8Array): void {
        const slices = splitBleImu(data);
        if (slices.length === 0) throw new HaritoraXError("DECODE_FAILED", `Invalid BLE sensor frame on ${state.endpointId}`);

        const device = this.#ensureDevice(state, true);
        if (!device) return;

        this.#ensureImuCount(state, device, slices.length);

        for (const slice of slices) {
            const tracker = device.trackers[slice.index];
            if (!tracker) continue;

            this.#emitImu(device, tracker, slice.index, slice.role, slice.payload, undefined, slice.range);
        }
    }

    #setSensorSource(state: BleState, source: "sensor" | "sensor2"): void {
        if (state.sensorSource === source) return;
        this.#log.debug(`Using BLE ${source} notifications for ${state.endpointId}`, {
            model: state.model,
            firmwareVersion: state.version,
        });
        state.sensorSource = source;
        state.sensor2RecoveryFrames = 0;
    }

    #resetSensorSource(state: BleState): void {
        state.sensorSource = undefined;
        state.sensor2LastSeen = undefined;
        state.sensor2RecoveryFrames = 0;
        state.sensor2FallbackActive = false;
    }

    #onWiredSensor(state: BleState, data: Uint8Array): void {
        const slices = splitWiredImuBytes(data, this.#parts(state).length, state.settings.ankle === true);
        if (slices.length === 0) throw new HaritoraXError("DECODE_FAILED", `Invalid BLE sensor frame on ${state.endpointId}`);

        const device = this.#ensureDevice(state, true);
        if (!device) return;

        for (const slice of slices) {
            const tracker = device.trackers[slice.index];
            if (!tracker) continue;

            this.#emitImu(device, tracker, slice.index, "single", slice.payload, undefined, slice.range);
        }
    }

    #ensureImuCount(state: BleState, device: DeviceSnapshot, count: number): void {
        if (count > 1 && device.trackers.length < count) {
            state.imuCount = count;
            this.#registry.setTrackers(device.deviceId, this.#parts(state));
        }
    }

    #emitImu(
        device: DeviceSnapshot,
        tracker: TrackerSnapshot,
        index: number,
        role: ImuRole,
        payload: Uint8Array,
        status: number | undefined,
        range: number | undefined,
        byteOffset = 0,
    ): void {
        const decoded =
            byteOffset === 0
                ? decodeImuBytes(payload, device.model, status, index)
                : decodeImuBytesAt(payload, byteOffset, device.model, status, index);
        if (!decoded) {
            this.#registry.trackerSeen(tracker.trackerId);
            return;
        }
        if (device.model === "wireless" && status === undefined) decoded.magStatus = undefined;
        if (!this.#registry.trackerSeenWithImuStatus(tracker.trackerId, decoded.magStatus, decoded.tap)) return;

        const distance = decodeRange(device.model, range);

        this.#emitter.emit("imu", {
            trackerId: tracker.trackerId,
            deviceId: device.deviceId,
            bodyPart: tracker.bodyPart,
            role,
            rotation: decoded.rotation,
            acceleration: decoded.acceleration,
            ...(distance === undefined ? {} : { range: distance }),
            timestamp: Date.now(),
        });
    }

    #onButton(state: BleState, button: "main" | "sub" | "sub2"): void {
        const device = this.#ensureDevice(state);
        if (!device) return;

        if (isButtonDebounced(state.endpointId, button, this.#lastButtonPress, Date.now(), this.#buttonDebounceMs)) return;

        this.#emitter.emit("button", { deviceId: device.deviceId, button });
    }

    #maybeBattery(state: BleState): void {
        const { level, voltage, chargeStatus } = state.battery;
        if (level === undefined || voltage === undefined) return;

        const device = this.#ensureDevice(state);
        if (!device) return;

        const battery: BatteryInfo = {
            deviceId: device.deviceId,
            level,
            voltage,
            chargeStatus: chargeStatus ?? "unknown",
            timestamp: Date.now(),
        };

        this.#registry.setBattery(device.deviceId, battery);
    }

    #maybeSettings(state: BleState): void {
        const { sensorMode, fpsMode, correction, ankle } = state.settings;
        if (sensorMode === undefined || fpsMode === undefined || correction === undefined || ankle === undefined) return;

        const device = this.#ensureDevice(state);
        if (!device) return;

        this.#registry.setSettings(device.deviceId, {
            sensorMode,
            fpsMode,
            sensorAutoCorrection: correction,
            ankleMotionDetection: ankle,
        });
    }

    #ensureDevice(state: BleState, activate = false): DeviceSnapshot | undefined {
        if (state.device?.endpointId === state.endpointId && this.#registry.getDevice(state.device.deviceId) === state.device)
            return state.device;
        state.device = undefined;
        if (!state.serial || !state.model) return undefined;

        const parts = this.#parts(state);
        const existing = this.#registry.deviceAt(state.endpointId, BLE_SLOT);

        // refresh the registry when late BLE identity fields arrive for the same tracker
        if (existing && existing.deviceId === state.serial) {
            const partsChanged =
                existing.trackers.length !== parts.length ||
                existing.trackers.some((tracker, index) => tracker.bodyPart !== parts[index]);
            const metadataChanged =
                existing.model !== state.model ||
                (state.model === "wired" && existing.wiredModel !== wiredModelFromFirmware(state.firmwareModel ?? "")) ||
                (state.version !== undefined && state.version !== "" && existing.version !== state.version);
            if (!metadataChanged) {
                if (partsChanged) this.#registry.setTrackers(state.serial, parts);
                state.device = existing;
                return existing;
            }

            const device = this.#registry.register(
                {
                    deviceId: state.serial,
                    endpointId: state.endpointId,
                    slot: BLE_SLOT,
                    model: state.model,
                    firmwareModel: state.firmwareModel ?? "",
                    version: state.version ?? "",
                    reportedImuCount: state.imuCount,
                    connection: this.#connectionKind(state.endpointId),
                    parts,
                },
                activate,
            );
            state.device = device.endpointId === state.endpointId ? device : undefined;
            return state.device;
        }

        const device = this.#registry.register(
            {
                deviceId: state.serial,
                endpointId: state.endpointId,
                slot: BLE_SLOT,
                model: state.model,
                firmwareModel: state.firmwareModel ?? "",
                version: state.version ?? "",
                reportedImuCount: state.imuCount,
                connection: this.#connectionKind(state.endpointId),
                parts,
            },
            activate,
        );

        if (device.endpointId !== state.endpointId) return undefined;
        state.device = device;
        this.#log.debug(`Identified BLE tracker ${device.deviceId}`, {
            endpointId: state.endpointId,
            model: state.model,
            firmwareModel: state.firmwareModel,
            version: state.version,
            imuCount: device.imuCount,
            bodyParts: parts,
        });

        if (activate) {
            this.#maybeBattery(state);
            this.#maybeSettings(state);
        }

        return device;
    }

    #parts(state: BleState): BodyPart[] {
        const count = state.imuCount ?? 1;
        if (state.model === "wired") return wiredPartsFor(count);
        if (!state.bodyPart) return Array.from({ length: count }, () => "unassigned");

        return bodyPartsFor(state.bodyPart, count);
    }

    #modelFromFirmware(firmware: string): TrackerModel | undefined {
        return modelFromFirmware(firmware);
    }

    #state(endpointId: string): BleState {
        let state = this.#states.get(endpointId);
        if (!state) {
            state = {
                endpointId,
                settings: {},
                battery: {},
            };
            this.#states.set(endpointId, state);
        }

        return state;
    }
}

// the button characteristics of a wired tracker hold `ff` as the event type until the first press
function isNoWiredEvent(state: BleState, data: Uint8Array): boolean {
    return state.model === "wired" && data[4] === 0xff;
}

// long press is power off for the main button, don't report as a pressz
function isLongPress(data: Uint8Array): boolean {
    return data[4] === 0x04;
}

function sensor2MaxGapMs(fpsMode: FpsMode | undefined): number {
    return SENSOR2_MAX_FRAME_PERIODS * (1_000 / (fpsMode ?? 50));
}

interface BleState {
    endpointId: string;
    sensorStartedAt?: number;
    sensor2LastSeen?: number;
    sensor2RecoveryFrames?: number;
    sensor2FallbackActive?: boolean;
    sensorSource?: "sensor" | "sensor2";
    serial?: string;
    model?: TrackerModel;
    device?: DeviceSnapshot;
    firmwareModel?: string;
    version?: string;
    sensor2Supported?: boolean;
    imuCount?: number;
    bodyPart?: BodyPart;
    settings: {
        sensorMode?: SensorMode;
        fpsMode?: FpsMode;
        correction?: SensorAutoCorrection[];
        ankle?: boolean;
    };
    battery: {
        level?: number;
        voltage?: number;
        chargeStatus?: "discharging" | "charging" | "charged" | "unknown";
    };
}

interface BodyPartWait {
    bodyPart: BodyPart;
    timer: ReturnType<typeof setTimeout>;
    resolve: (result: boolean | undefined) => void;
    promise: Promise<boolean | undefined>;
}
