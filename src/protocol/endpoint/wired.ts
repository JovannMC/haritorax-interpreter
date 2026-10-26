import { fromByteArray as encodeBase64, toByteArray as decodeBase64 } from "base64-js";
import { magStatusFromByte } from "../codec/imu.js";
import type { BodyPart, MagStatus, TrackerSettings } from "../../types.js";

const WIRED_PARTS: readonly BodyPart[] = Object.freeze([
    "chest",
    "leftKnee",
    "leftAnkle",
    "rightKnee",
    "rightAnkle",
    "hip",
    "leftElbow",
    "rightElbow",
]);

const WIRED_MIN_IMUS = 5;
const WIRED_IMU_BYTES = 14;
const WIRED_RANGE_BYTES = 4;

export interface WiredState {
    imuCount: number;
    parts: readonly BodyPart[];
    magStatuses: (MagStatus | undefined)[];
}

export interface WiredImuSlice {
    payload: string;
    index: number;
    // raw range sensor value (see decodeRange)
    range?: number;
}

// `s:{"imu_mode":1, "imu_num":5, "magf_status":"33333", "speed_mode":2, "dcal_flags":"04", "detected":"04004C4C"}`
export function parseWiredState(payload: string): WiredState | undefined {
    try {
        const data = JSON.parse(payload) as Record<string, unknown>;
        const imuCount = typeof data["imu_num"] === "number" ? data["imu_num"] : undefined;
        if (imuCount === undefined || !Number.isInteger(imuCount)) return undefined;
        if (imuCount < WIRED_MIN_IMUS || imuCount > WIRED_PARTS.length) return undefined;

        const parts = WIRED_PARTS.slice(0, imuCount);
        const magField = typeof data["magf_status"] === "string" ? data["magf_status"] : "";
        const magStatuses = parts.map((_, index) => {
            const value = Number.parseInt(magField.charAt(index), 10);
            return Number.isNaN(value) ? undefined : magStatusFromByte(value);
        });

        return { imuCount, parts, magStatuses };
    } catch {
        return undefined;
    }
}

// frames are 14 bytes per IMU, followed by two 16-bit range values (left ankle, right ankle) when ankle motion detection is on
export function splitWiredImu(payload: string, partCount: number): WiredImuSlice[] {
    const bytes = decodeBase64(payload);
    if (partCount <= 0 || bytes.length < partCount * WIRED_IMU_BYTES) return [];

    const hasRange = bytes.length >= partCount * WIRED_IMU_BYTES + WIRED_RANGE_BYTES;
    const rangeOffset = partCount * WIRED_IMU_BYTES;
    const view = hasRange ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : undefined;

    const slices: WiredImuSlice[] = [];
    for (let index = 0; index < partCount; index++) {
        const part = WIRED_PARTS[index];
        let range: number | undefined;

        if (view && part === "leftAnkle") range = view.getUint16(rangeOffset, true);
        else if (view && part === "rightAnkle") range = view.getUint16(rangeOffset + 2, true);

        const start = index * WIRED_IMU_BYTES;
        slices.push({
            payload: encodeBase64(bytes.slice(start, start + WIRED_IMU_BYTES)),
            index,
            ...(range === undefined ? {} : { range }),
        });
    }

    return slices;
}

export function parseWiredButton(payload: string): "main" | "sub" | "sub2" | undefined {
    try {
        const data = JSON.parse(payload) as Record<string, unknown>;
        switch (data["id"]) {
            case "button1":
                return "main";
            case "button2":
                return "sub";
            case "button3":
                return "sub2";
            default:
                return undefined;
        }
    } catch {
        return undefined;
    }
}

export function wiredSettingsCommands(settings: TrackerSettings): readonly string[] {
    let correctionBits = 0;
    if (settings.sensorAutoCorrection.includes("accel")) correctionBits |= 1;
    if (settings.sensorAutoCorrection.includes("gyro")) correctionBits |= 2;
    if (settings.sensorAutoCorrection.includes("mag")) correctionBits |= 4;

    // according to firmware, wired trackers swap the sensor modes, so 1 is actually without mag and 2 is with mag?
    return [
        `sensor imu mode ${settings.sensorMode === 1 ? 2 : 1}\r\n`,
        settings.fpsMode === 50 ? "system speed mode 1\r\n" : "system speed mode 2\r\n",
        `sensor cal flags ${correctionBits}\r\nsensor restart\r\n`,
        settings.ankleMotionDetection
            ? "param sensor range\r\nparam save\r\nsensor restart\r\n"
            : "param sensor basic\r\nparam save\r\nsensor restart\r\n",
    ];
}
