import { fromByteArray as encodeBase64 } from "base64-js";
import { HaritoraXError } from "../../lib/errors.js";
import type { Emitter } from "../../lib/emitter.js";
import type { Logger } from "../../lib/logging.js";
import type { DeviceRegistry } from "../device-registry.js";
import type { ProtocolHandler } from "../protocol-handler.js";
import { bodyPartsFor, isButtonDebounced, trackerIdOfBodyPart } from "../../protocol/endpoint/dongle.js";
import { decodeImu, decodeRange } from "../../protocol/codec/imu.js";
import { bodyPartNotifies, hasSensor2 } from "../../protocol/firmware.js";
import { modelFromFirmware } from "../../protocol/codec/messages.js";
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
    splitBleSensor2,
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
    TrackerSettings,
    TrackerSnapshot,
} from "../../types.js";

const BLE_SLOT = "0";
const BODY_PART_TIMEOUT_MS = 2_000;
const MAX_BLE_BODY_PART_ID = 15;
const SENSOR2_FALLBACK_MS = 250;

export interface BleControllerOptions {
    emitter: Emitter;
    log: Logger;
    registry: DeviceRegistry;
    connectionKind: (endpointId: string) => ConnectionKind;
    write: (endpointId: string, characteristic: BleCharacteristic, data: Uint8Array) => Promise<void>;
    buttonDebounceMs?: number;
}

export class BleController implements ProtocolHandler {
    readonly #emitter: Emitter;
    readonly #log: Logger;
    readonly #registry: DeviceRegistry;
    readonly #connectionKind: (endpointId: string) => ConnectionKind;
    readonly #write: (endpointId: string, characteristic: BleCharacteristic, data: Uint8Array) => Promise<void>;
    readonly #states = new Map<string, BleState>();
    readonly #lastButtonPress = new Map<string, number>();
    readonly #bodyPartWaits = new Map<string, { bodyPart: BodyPart; resolve: () => void }>();
    readonly #buttonDebounceMs: number;

    constructor(options: BleControllerOptions) {
        this.#emitter = options.emitter;
        this.#log = options.log;
        this.#registry = options.registry;
        this.#connectionKind = options.connectionKind;
        this.#write = options.write;
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
                    state.device = undefined;
                }
                this.#ensureDevice(state);
                break;
            }
            case "software-revision":
                state.version = bleText(data);
                break;
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

                if (part && this.#bodyPartWaits.get(endpointId)?.bodyPart === part)
                    this.#bodyPartWaits.get(endpointId)?.resolve();
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
                    const expectsSensor2 = state.model && hasSensor2(state.model, state.version);
                    const preferredAt = state.sensor2LastSeen ?? (expectsSensor2 ? state.sensorStartedAt : undefined);
                    if (preferredAt === undefined || now - preferredAt >= SENSOR2_FALLBACK_MS) this.#onSensor(state, data);
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
                if (state.model !== "wired") this.#onButton(state, "main");
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

    async setSettings(endpointId: string, settings: TrackerSettings): Promise<void> {
        const state = this.#state(endpointId);
        const device = this.#ensureDevice(state);
        if (!device) throw new HaritoraXError("DEVICE_NOT_FOUND", `Unknown BLE tracker on "${endpointId}"`);

        const values = bleSettingValues(settings);
        await this.#write(endpointId, "sensor-mode", new Uint8Array([values.sensorMode]));
        await this.#write(endpointId, "fps", new Uint8Array([values.fpsMode]));

        if (device.model !== "wired") {
            await this.#write(endpointId, "auto-calibration", new Uint8Array([values.autoCorrection]));
        } else if (state.settings.correction !== undefined) {
            await this.#write(endpointId, "wired-auto-calibration", new Uint8Array([values.autoCorrection]));
        } else {
            this.#log.debug(`${endpointId} has no calibration characteristic, skipped`);
        }

        await this.#write(endpointId, "tof", new Uint8Array([values.tof]));

        state.settings = {
            sensorMode: settings.sensorMode,
            fpsMode: settings.fpsMode,
            correction: [...settings.sensorAutoCorrection],
            ankle: settings.ankleMotionDetection,
        };
        this.#registry.setSettings(device.deviceId, settings);
        this.#log.info(`Applied BLE settings to ${endpointId}`);
    }

    forgetEndpoint(endpointId: string): void {
        this.#states.delete(endpointId);
        this.#bodyPartWaits.delete(endpointId);
        for (const key of this.#lastButtonPress.keys()) {
            if (key.startsWith(endpointId)) this.#lastButtonPress.delete(key);
        }
    }

    async powerOff(endpointId: string): Promise<void> {
        const state = this.#state(endpointId);
        const device = this.#ensureDevice(state);
        if (!device) throw new HaritoraXError("DEVICE_NOT_FOUND", `Unknown BLE tracker on "${endpointId}"`);

        await this.#write(endpointId, "wireless-mode", new Uint8Array([2]));
        this.#log.info(`Powering off BLE ${endpointId}`);
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
        const confirmed = confirms
            ? new Promise<boolean>((resolve) => {
                  const timer = setTimeout(() => {
                      this.#bodyPartWaits.delete(endpointId);
                      resolve(false);
                  }, BODY_PART_TIMEOUT_MS);

                  this.#bodyPartWaits.set(endpointId, {
                      bodyPart,
                      resolve: () => {
                          clearTimeout(timer);
                          this.#bodyPartWaits.delete(endpointId);
                          resolve(true);
                      },
                  });
              })
            : undefined;

        try {
            await this.#write(endpointId, "body-part-write", new Uint8Array([id]));
        } catch (error) {
            this.#bodyPartWaits.delete(endpointId);
            throw error;
        }

        if (confirmed && !(await confirmed)) {
            throw new HaritoraXError(
                "TIMEOUT",
                `${device.deviceId} did not confirm the body part "${bodyPart}" in time. Its firmware may ignore the change, check its version`,
            );
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
        if (this.#states.get(endpointId)?.model !== "wired") return;

        await this.#write(endpointId, "sensor-data-control", new Uint8Array([1]));
        this.#log.info(`Started sensor data on BLE ${endpointId}`);
    }

    dispose(): void {
        this.#states.clear();
        this.#lastButtonPress.clear();
    }

    // IMU data, mag status, taps, ToF range
    #onSensor2(state: BleState, data: Uint8Array): void {
        const slices = splitBleSensor2(data);
        if (slices.length === 0) return;
        state.sensor2LastSeen = Date.now();

        const device = this.#ensureDevice(state, true);
        if (!device) return;

        this.#ensureImuCount(state, device, slices.length);

        for (const slice of slices) {
            const tracker = device.trackers[slice.index];
            if (!tracker || !this.#registry.trackerSeen(tracker.trackerId)) continue;

            this.#emitImu(device, tracker, slice.index, slice.role, slice.payload, slice.status, slice.range);
        }
    }

    // only IMU data and ToF range
    #onSensor(state: BleState, data: Uint8Array): void {
        const slices = splitBleImu(data);
        if (slices.length === 0) return;

        const device = this.#ensureDevice(state, true);
        if (!device) return;

        this.#ensureImuCount(state, device, slices.length);

        for (const slice of slices) {
            const tracker = device.trackers[slice.index];
            if (!tracker || !this.#registry.trackerSeen(tracker.trackerId)) continue;

            this.#emitImu(device, tracker, slice.index, slice.role, slice.payload, undefined, slice.range);
        }
    }

    #onWiredSensor(state: BleState, data: Uint8Array): void {
        const slices = splitWiredImuBytes(data, this.#parts(state).length, state.settings.ankle === true);
        if (slices.length === 0) return;

        const device = this.#ensureDevice(state, true);
        if (!device) return;

        for (const slice of slices) {
            const tracker = device.trackers[slice.index];
            if (!tracker || !this.#registry.trackerSeen(tracker.trackerId)) continue;

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
    ): void {
        const decoded = decodeImu(encodeBase64(payload), device.model, status, index);
        if (!decoded) return;

        if (decoded.magStatus) this.#registry.setMag(tracker.trackerId, decoded.magStatus);
        if (decoded.tap !== undefined) this.#registry.setTap(tracker.trackerId, decoded.tap);

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

        // if device exists (and serial matches), update trackers if parts changed, otherwise return existing device
        // usually when user (un)plugs tracker to device during a session like in wired trackers
        if (existing && existing.deviceId === state.serial) {
            const partsChanged =
                existing.trackers.length !== parts.length ||
                existing.trackers.some((tracker, index) => tracker.bodyPart !== parts[index]);

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

        if (device.endpointId !== state.endpointId) return undefined;
        state.device = device;

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
        try {
            return modelFromFirmware(firmware);
        } catch {
            return undefined;
        }
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

interface BleState {
    endpointId: string;
    sensorStartedAt?: number;
    sensor2LastSeen?: number;
    serial?: string;
    model?: TrackerModel;
    device?: DeviceSnapshot;
    firmwareModel?: string;
    version?: string;
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
