import { fromByteArray as encodeBase64, toByteArray as decodeBase64 } from "base64-js";
import { magStatusFromByte } from "./imu.js";
import type { BodyPart, MagStatus, TrackerSettings } from "../types.js";

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
const WIRED_ANKLE_BYTES = 4;

export interface WiredState {
    imuCount: number;
    parts: readonly BodyPart[];
    magStatuses: (MagStatus | undefined)[];
}

export interface WiredImuSlice {
    payload: string;
    index: number;
    ankleAngle?: number;
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

// `r` and `h` are the ankle-motion variants, `h` is shared by 7 and 8 trackers
export function wiredAnkleEnabled(identifier: string): boolean {
    return identifier === "r" || identifier === "h";
}

export function splitWiredImu(payload: string, partCount: number, ankleEnabled: boolean): WiredImuSlice[] {
    const bytes = decodeBase64(payload);
    if (partCount <= 0 || bytes.length < partCount * WIRED_IMU_BYTES) return [];

    const ankleOffset = bytes.length - WIRED_ANKLE_BYTES;
    const hasAnkle = ankleEnabled && bytes.length >= partCount * WIRED_IMU_BYTES + WIRED_ANKLE_BYTES;
    const view = hasAnkle ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : undefined;

    const slices: WiredImuSlice[] = [];
    for (let index = 0; index < partCount; index++) {
        const part = WIRED_PARTS[index];
        let ankleAngle: number | undefined;

        if (view && part === "leftAnkle") ankleAngle = view.getInt8(ankleOffset);
        else if (view && part === "rightAnkle") ankleAngle = view.getInt8(ankleOffset + 2);

        const start = index * WIRED_IMU_BYTES;
        slices.push({
            payload: encodeBase64(bytes.slice(start, start + WIRED_IMU_BYTES)),
            index,
            ...(ankleAngle === undefined ? {} : { ankleAngle }),
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

    return [
        `sensor imu mode ${settings.sensorMode}\r\n`,
        settings.fpsMode === 50 ? "system speed mode 1\r\n" : "system speed mode 2\r\n",
        `sensor cal flags ${correctionBits}\r\nsensor restart\r\n`,
        settings.ankleMotionDetection
            ? "param sensor range\r\nparam save\r\nsensor restart\r\n"
            : "param sensor basic\r\nparam save\r\nsensor restart\r\n",
    ];
}
