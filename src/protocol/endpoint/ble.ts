import { bodyPartOfTracker } from "./dongle.js";
import { magStatusFromByte, readImuStatusWord } from "../codec/imu.js";
import type {
    AccelAccuracy,
    BodyPart,
    FpsMode,
    ImuRole,
    MagStatus,
    SensorAutoCorrection,
    SensorMode,
    TrackerModel,
    TrackerSettings,
} from "../../types.js";

export type BleCharacteristic =
    | "manufacturer"
    | "model-number"
    | "serial-number"
    | "hardware-revision"
    | "firmware-revision"
    | "software-revision"
    | "battery-level"
    | "battery-voltage"
    | "charge-status"
    | "sensor"
    | "sensor2"
    | "accel-accuracy"
    | "number-of-imu"
    | "magnetometer"
    | "main-button"
    | "secondary-button"
    | "tertiary-button"
    | "fps"
    | "tof"
    | "sensor-mode"
    | "wireless-mode"
    | "auto-calibration"
    | "body-part";

const BLE_CHARACTERISTICS: Readonly<Record<string, BleCharacteristic>> = Object.freeze({
    "2a29": "manufacturer",
    "2a24": "model-number",
    "2a25": "serial-number",
    "2a27": "hardware-revision",
    "2a26": "firmware-revision",
    "2a28": "software-revision",
    "2a19": "battery-level",
    ef843b5490a911eda1eb0242ac120002: "battery-voltage",
    ef843cb290a911eda1eb0242ac120002: "charge-status",
    "00dbf1c690aa11eda1eb0242ac120002": "sensor",
    "00dbc40090aa11eda1eb0242ac120002": "sensor2",
    "00dbc40190aa11eda1eb0242ac120002": "accel-accuracy",
    "00dbf07c90aa11eda1eb0242ac120002": "number-of-imu",
    "00dbf30690aa11eda1eb0242ac120002": "magnetometer",
    "00dbf45090aa11eda1eb0242ac120002": "main-button",
    "00dbf58690aa11eda1eb0242ac120002": "secondary-button",
    "00dbf6a890aa11eda1eb0242ac120002": "tertiary-button",
    ef84420290a911eda1eb0242ac120002: "fps",
    ef8443f690a911eda1eb0242ac120002: "tof",
    ef8445c290a911eda1eb0242ac120002: "sensor-mode",
    ef84c30090a911eda1eb0242ac120002: "wireless-mode",
    ef84c30590a911eda1eb0242ac120002: "auto-calibration",
    ef84c30190a911eda1eb0242ac120002: "body-part",
});

export function bleCharacteristicFromUuid(uuid: string): BleCharacteristic | undefined {
    return BLE_CHARACTERISTICS[uuid.toLowerCase().replace(/-/g, "")];
}

export interface BleDeviceName {
    model: TrackerModel;
    localName: string;
}

// TODO: haritorax wired as well, it has BLE as an option
const BLE_NAME_PREFIXES: ReadonlyArray<{ prefix: string; model: TrackerModel }> = Object.freeze([
    { prefix: "haritoraxw-", model: "wireless" },
    { prefix: "haritorax2-", model: "x2" },
]);

export function parseBleDeviceName(localName: string | undefined): BleDeviceName | undefined {
    if (!localName) return undefined;

    const lower = localName.toLowerCase();
    for (const { prefix, model } of BLE_NAME_PREFIXES) {
        if (!lower.startsWith(prefix)) continue;

        const serial = localName.slice(prefix.length).trim();
        return serial ? { model, localName } : undefined;
    }

    return undefined;
}

export interface BleImuSlice {
    payload: Uint8Array;
    index: number;
    role: ImuRole;
}

export function splitBleImu(data: Uint8Array): BleImuSlice[] {
    const base64Length = Math.ceil(data.length / 3) * 4;

    if (base64Length >= 40) {
        const thigh = base64Length === 40 ? data.slice(14, 29) : data.slice(18, 32);
        return [
            { payload: data.slice(0, 14), index: 0, role: "ankle" },
            { payload: thigh, index: 1, role: "knee" },
        ];
    }

    return [{ payload: data, index: 0, role: "ankle" }];
}

export function bleText(data: Uint8Array): string {
    let text = "";
    for (const byte of data) {
        if (byte === 0) break;
        text += String.fromCharCode(byte);
    }

    return text.trim();
}

export function bleUint8(data: Uint8Array): number | undefined {
    return data.length > 0 ? data[0] : undefined;
}

export function bleBatteryVoltage(data: Uint8Array): number | undefined {
    // int16LE
    const low = data[0];
    const high = data[1];
    if (low === undefined || high === undefined) return undefined;

    return low | (high << 8);
}

export function bleChargeStatus(data: Uint8Array): "discharging" | "charging" | "charged" | "unknown" {
    switch (bleUint8(data)) {
        case 0:
            return "discharging";
        case 1:
            return "charging";
        case 2:
            return "charged";
        default:
            return "unknown";
    }
}

export function bleMagStatus(data: Uint8Array): MagStatus | undefined {
    const value = bleUint8(data);
    return value === undefined ? undefined : magStatusFromByte(value);
}

// sensor2 frames carry the same status word as dongle frames at bytes 14-15, see readImuStatusWord
export function bleStatusWord(data: Uint8Array): number | undefined {
    return readImuStatusWord(data);
}

// one byte with 2 bits per IMU, first IMU in bits 0-1
export function bleAccelAccuracy(data: Uint8Array, imuIndex: number): AccelAccuracy | undefined {
    const value = bleUint8(data);
    return value === undefined ? undefined : (((value >> (imuIndex * 2)) & 3) as AccelAccuracy);
}

export interface BleSensor2Slice {
    payload: Uint8Array;
    status: number;
    index: number;
    role: ImuRole;
    range?: number;
}


// 16 bytes = single IMU, 18 bytes = single IMU + range, 30 bytes = dual IMU, 32 bytes = dual IMU + range
export function splitBleSensor2(data: Uint8Array): BleSensor2Slice[] {
    const status = readImuStatusWord(data);
    if (status === undefined) return [];

    const ankle = data.slice(0, 14);
    const range = bleUint16(data, 16);
    switch (data.length) {
        case 16:
            return [{ payload: ankle, status, index: 0, role: "ankle" }];
        case 18:
            return [{ payload: ankle, status, index: 0, role: "ankle", range }];
        case 30:
            return [
                { payload: ankle, status, index: 0, role: "ankle" },
                { payload: data.slice(16, 30), status, index: 1, role: "knee" },
            ];
        case 32:
            // 32 -= dual imu and range
            return [
                { payload: ankle, status, index: 0, role: "ankle", range },
                { payload: data.slice(16, 30), status, index: 1, role: "knee" },
            ];
        default:
            return [];
    }
}

// one byte per IMU on the magnetometer characteristic
export function bleMagStatusAt(data: Uint8Array, index: number): MagStatus | undefined {
    const value = data[index];
    return value === undefined ? undefined : magStatusFromByte(value);
}

export function bleUint16(data: Uint8Array, offset: number): number | undefined {
    const low = data[offset];
    const high = data[offset + 1];
    if (low === undefined || high === undefined) return undefined;

    return low | (high << 8);
}

export function bleBodyPart(data: Uint8Array): BodyPart | undefined {
    const value = bleUint8(data);
    if (value === undefined || value === 0) return undefined;

    return bodyPartOfTracker(value.toString(16));
}

export function bleSensorMode(data: Uint8Array): SensorMode | undefined {
    const value = bleUint8(data);
    if (value === 5) return 1;
    if (value === 8) return 2;
    return undefined;
}

export function bleFpsMode(data: Uint8Array): FpsMode | undefined {
    const value = bleUint8(data);
    if (value === 1) return 50;
    if (value === 2) return 100;
    return undefined;
}

export function bleAutoCorrection(value: number): SensorAutoCorrection[] {
    return (["accel", "gyro", "mag"] as const).filter((_, index) => value & (1 << index));
}

export interface BleSettingValues {
    sensorMode: number;
    fpsMode: number;
    autoCorrection: number;
    tof: number;
}

export function bleSettingValues(settings: TrackerSettings): BleSettingValues {
    let autoCorrection = 0;
    if (settings.sensorAutoCorrection.includes("accel")) autoCorrection |= 1;
    if (settings.sensorAutoCorrection.includes("gyro")) autoCorrection |= 2;
    if (settings.sensorAutoCorrection.includes("mag")) autoCorrection |= 4;

    return {
        sensorMode: settings.sensorMode === 1 ? 5 : 8,
        fpsMode: settings.fpsMode === 50 ? 1 : 2,
        autoCorrection,
        tof: settings.ankleMotionDetection ? 1 : 0,
    };
}
