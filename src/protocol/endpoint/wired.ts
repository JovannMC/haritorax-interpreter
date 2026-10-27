import { fromByteArray as encodeBase64, toByteArray as decodeBase64 } from "base64-js";
import { magStatusFromByte } from "../codec/imu.js";
import type { BodyPart, MagStatus, TrackerSettings } from "../../types.js";

const WIRED_BASE_PARTS: readonly BodyPart[] = Object.freeze(["chest", "leftKnee", "leftAnkle", "rightKnee", "rightAnkle"]);

const WIRED_IMU_BYTES = 14;
const WIRED_RANGE_BYTES = 4;

export function wiredPartsFor(imuCount: number): BodyPart[] {
    // allow any amount, lol
    const extra: BodyPart[] =
        imuCount === 6
            ? ["hip"]
            : imuCount === 7
              ? ["leftElbow", "rightElbow"]
              : imuCount === 8
                ? ["leftElbow", "rightElbow", "hip"]
                : [];
    const parts: BodyPart[] = [...WIRED_BASE_PARTS, ...extra];
    while (parts.length < imuCount) parts.push("unassigned");

    return parts.slice(0, imuCount);
}

export interface WiredState {
    imuCount: number;
    parts: readonly BodyPart[];
    magStatuses: (MagStatus | undefined)[];
    imuMode?: number;
    speedMode?: number;
    dcalFlags?: number;
    detected?: string;
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
        if (imuCount < 1) return undefined;

        const parts = wiredPartsFor(imuCount);
        const magField = typeof data["magf_status"] === "string" ? data["magf_status"] : "";
        const magStatuses = parts.map((_, index) => {
            const value = Number.parseInt(magField.charAt(index), 10);
            return Number.isNaN(value) ? undefined : magStatusFromByte(value);
        });

        const imuMode = typeof data["imu_mode"] === "number" ? data["imu_mode"] : undefined;
        const speedMode = typeof data["speed_mode"] === "number" ? data["speed_mode"] : undefined;
        const dcalField = typeof data["dcal_flags"] === "string" ? data["dcal_flags"] : undefined;
        const dcalFlags = dcalField === undefined ? undefined : Number.parseInt(dcalField, 16);
        const detected = typeof data["detected"] === "string" ? data["detected"] : undefined;

        return {
            imuCount,
            parts,
            magStatuses,
            imuMode,
            speedMode,
            dcalFlags,
            detected,
        };
    } catch {
        return undefined;
    }
}

export interface WiredImuBytes {
    payload: Uint8Array;
    index: number;
    // raw range sensor value (see decodeRange)
    range?: number;
}

// frames are 14 bytes per IMU, followed by two 16-bit range values (left ankle, right ankle) when ankle motion detection is on
export function splitWiredImuBytes(bytes: Uint8Array, partCount: number, hasRange?: boolean): WiredImuBytes[] {
    if (partCount <= 0 || bytes.length < partCount * WIRED_IMU_BYTES) return [];

    const rangeOffset = partCount * WIRED_IMU_BYTES;
    const withRange = (hasRange ?? true) && bytes.length >= rangeOffset + WIRED_RANGE_BYTES;
    const view = withRange ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : undefined;

    const parts = wiredPartsFor(partCount);
    const slices: WiredImuBytes[] = [];
    for (let index = 0; index < partCount; index++) {
        const part = parts[index];
        let range: number | undefined;

        if (view && part === "leftAnkle") range = view.getUint16(rangeOffset, true);
        else if (view && part === "rightAnkle") range = view.getUint16(rangeOffset + 2, true);

        const start = index * WIRED_IMU_BYTES;
        slices.push({
            payload: bytes.slice(start, start + WIRED_IMU_BYTES),
            index,
            ...(range === undefined ? {} : { range }),
        });
    }

    return slices;
}

export function splitWiredImu(payload: string, partCount: number): WiredImuSlice[] {
    return splitWiredImuBytes(decodeBase64(payload), partCount).map((slice) => ({
        ...slice,
        payload: encodeBase64(slice.payload),
    }));
}

// `x:` frames (report_type 1) carry 7 float32 per IMU, no range: quaternion i, j, k, real, then acceleration x, y, z
// this should never show up on real trackers unless someone else found the command and changed it themselves, for some reason
export function splitWiredFloatImu(payload: string, partCount: number): WiredImuSlice[] {
    const bytes = decodeBase64(payload);
    const size = 7 * 4;
    if (partCount <= 0 || bytes.length < partCount * size) return [];

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const toInt16 = (value: number) => Math.max(-32768, Math.min(32767, Math.round(value)));

    const slices: WiredImuSlice[] = [];
    for (let index = 0; index < partCount; index++) {
        const at = index * size;
        const out = new Uint8Array(WIRED_IMU_BYTES);
        const dv = new DataView(out.buffer);

        for (let i = 0; i < 4; i++) dv.setInt16(i * 2, toInt16(view.getFloat32(at + i * 4, true) * 16384), true);
        for (let i = 0; i < 3; i++) dv.setInt16(8 + i * 2, toInt16(view.getFloat32(at + (4 + i) * 4, true) * 256), true);

        slices.push({ payload: encodeBase64(out), index });
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
