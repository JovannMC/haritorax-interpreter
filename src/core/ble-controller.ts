import { fromByteArray as encodeBase64 } from "base64-js";
import { HaritoraXError } from "../lib/errors.js";
import type { Emitter } from "../lib/emitter.js";
import type { Logger } from "../lib/logging.js";
import type { DeviceRegistry } from "./device-registry.js";
import type { ProtocolHandler } from "./protocol-handler.js";
import { bodyPartsFor, isButtonDebounced } from "../protocol/dongle.js";
import { decodeImu } from "../protocol/imu.js";
import { modelFromFirmware } from "../protocol/messages.js";
import {
    bleAutoCorrection,
    bleBatteryVoltage,
    bleBodyPart,
    bleChargeStatus,
    bleFpsMode,
    bleMagStatus,
    bleSensorMode,
    bleSettingValues,
    bleText,
    bleUint8,
    splitBleImu,
    type BleCharacteristic,
} from "../protocol/ble.js";
import type {
    BatteryInfo,
    BodyPart,
    ConnectionKind,
    DeviceSnapshot,
    FpsMode,
    SensorAutoCorrection,
    SensorMode,
    TrackerModel,
    TrackerSettings,
} from "../types.js";

const BLE_SLOT = "0";

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
    readonly #buttonDebounceMs: number;

    constructor(options: BleControllerOptions) {
        this.#emitter = options.emitter;
        this.#log = options.log;
        this.#registry = options.registry;
        this.#connectionKind = options.connectionKind;
        this.#write = options.write;
        this.#buttonDebounceMs = options.buttonDebounceMs ?? 200;
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
                break;
            }
            case "sensor":
                this.#onImu(state, data);
                break;
            case "magnetometer": {
                const device = this.#ensureDevice(state);
                const status = bleMagStatus(data);
                if (!device || !status) return;
                this.#registry.setMag(`${device.deviceId}:0`, status);
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
                this.#onButton(state, "main");
                break;
            case "secondary-button":
                this.#onButton(state, "sub");
                break;
            case "tertiary-button":
                this.#onButton(state, "sub2");
                break;
            case "sensor-mode":
                state.settings.sensorMode = bleSensorMode(data);
                this.#maybeSettings(state);
                break;
            case "fps":
                state.settings.fpsMode = bleFpsMode(data);
                this.#maybeSettings(state);
                break;
            case "auto-calibration": {
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
        await this.#write(endpointId, "auto-calibration", new Uint8Array([values.autoCorrection]));
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

    // swaps to GX dongle
    async switchCommunication(endpointId: string): Promise<void> {
        const state = this.#state(endpointId);
        const device = this.#ensureDevice(state);
        if (!device) throw new HaritoraXError("DEVICE_NOT_FOUND", `Unknown BLE tracker on "${endpointId}"`);

        await this.#write(endpointId, "wireless-mode", new Uint8Array([1]));
        this.#log.info(`Switching BLE ${endpointId} to serial`);
    }

    dispose(): void {
        this.#states.clear();
        this.#lastButtonPress.clear();
    }

    #onImu(state: BleState, data: Uint8Array): void {
        const device = this.#ensureDevice(state);
        if (!device) return;

        const slices = splitBleImu(data);

        if (slices.length > 1 && device.trackers.length < slices.length) {
            state.imuCount = slices.length;
            this.#registry.setTrackers(device.deviceId, this.#parts(state));
        }

        for (const slice of slices) {
            if (slice.payload.length < 14) continue;

            const tracker = device.trackers[slice.index];
            if (!tracker || !this.#registry.trackerSeen(tracker.trackerId)) continue;

            const decoded = decodeImu(encodeBase64(slice.payload), device.model);
            if (!decoded) continue;

            this.#emitter.emit("imu", {
                trackerId: tracker.trackerId,
                deviceId: device.deviceId,
                bodyPart: tracker.bodyPart,
                role: slice.role,
                rotation: decoded.rotation,
                acceleration: decoded.acceleration,
                ...(decoded.ankleAngle === undefined ? {} : { ankleAngle: decoded.ankleAngle }),
                timestamp: Date.now(),
            });
        }
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

    #ensureDevice(state: BleState): DeviceSnapshot | undefined {
        // we can cache the device snapshot to return it instead of looking it up in the registry every time
        if (state.device) return state.device;
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

        const device = this.#registry.register({
            deviceId: state.serial,
            endpointId: state.endpointId,
            slot: BLE_SLOT,
            model: state.model,
            firmwareModel: state.firmwareModel ?? "",
            version: state.version ?? "",
            reportedImuCount: state.imuCount,
            connection: this.#connectionKind(state.endpointId),
            parts,
        });

        state.device = device;
        return device;
    }

    #parts(state: BleState): BodyPart[] {
        const count = state.imuCount ?? 1;
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

interface BleState {
    endpointId: string;
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
