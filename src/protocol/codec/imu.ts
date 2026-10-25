import { toByteArray as decodeBase64 } from "base64-js";
import type { MagStatus, Quaternion, TrackerModel, Vector } from "../../types.js";

const ROTATION_SCALAR = 0.01 / 180.0;
const GRAVITY_SCALAR = 1 / 256.0;
const GRAVITY_CONSTANT = 9.81;

// legacy HXW fallback for frames without a status word, reads a 6-bit slice of the base64
// from v3
const MAG_BY_CHAR: Readonly<Record<string, MagStatus>> = Object.freeze({
    A: "veryBad",
    E: "veryBad",
    I: "veryBad",
    M: "veryBad",
    B: "bad",
    F: "bad",
    J: "bad",
    N: "bad",
    C: "okay",
    G: "okay",
    K: "okay",
    O: "okay",
    D: "great",
    H: "great",
    L: "great",
    P: "great",
});

const MAG_BY_BYTE: Readonly<Record<number, MagStatus>> = Object.freeze({
    0: "veryBad",
    1: "bad",
    2: "okay",
    3: "great",
});

export function magStatusFromByte(value: number): MagStatus {
    return MAG_BY_BYTE[value] ?? "unknown";
}

// bytes 14-15 of a 16-byte IMU frame are one little-endian u16 holding 2-bit fields for each IMU
// first IMU uses bits 0-7 (mag 0-1, tap 2-3, main press count 4-5, sub press count 6-7), second IMU uses bits 8-15 with the same pattern
export function readImuStatusWord(bytes: Uint8Array): number | undefined {
    const low = bytes[14];
    const high = bytes[15];
    if (bytes.length < 16 || low === undefined || high === undefined) return undefined;

    return low | (high << 8);
}

export interface ImuStatusFields {
    mag: MagStatus;
    tap: number;
}

export function decodeImuStatus(word: number, imuIndex: number): ImuStatusFields {
    const shift = imuIndex === 1 ? 8 : 0;

    return {
        mag: magStatusFromByte((word >> shift) & 3),
        tap: (word >> (shift + 2)) & 3,
    };
}

export interface DecodedImu {
    rotation: Quaternion;
    acceleration: Vector;
    ankleAngle?: number;
    magStatus?: MagStatus;
    tap?: number;
}

export function decodeImu(base64: string, model: TrackerModel, statusWord?: number, imuIndex = 0): DecodedImu | undefined {
    const bytes = decodeBase64(base64);
    if (bytes.length < 14) return undefined;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    const rotation: Quaternion = {
        x: view.getInt16(0, true) * ROTATION_SCALAR,
        y: view.getInt16(2, true) * ROTATION_SCALAR,
        z: view.getInt16(4, true) * -ROTATION_SCALAR,
        w: view.getInt16(6, true) * -ROTATION_SCALAR,
    };

    const gravityRawX = view.getInt16(8, true) * GRAVITY_SCALAR;
    const gravityRawY = view.getInt16(10, true) * GRAVITY_SCALAR;
    const gravityRawZ = view.getInt16(12, true) * GRAVITY_SCALAR;

    // TODO: proper ankle detection, i believe HX2 doesn't have proper ankle data rn vs HXW
    const ankleAngle = base64.slice(-2) === "==" ? undefined : view.getUint16(bytes.length - 2, true);
    let magStatus: MagStatus | undefined;
    let tap: number | undefined;
    if (statusWord !== undefined) {
        const fields = decodeImuStatus(statusWord, imuIndex);
        magStatus = fields.mag;
        tap = fields.tap;
    } else if (model === "wireless") {
        magStatus = MAG_BY_CHAR[base64.charAt(base64.length - 5)] ?? "veryBad";
    }

    const rc = [rotation.w, rotation.x, rotation.y, rotation.z] as const;
    const r = [rc[0], -rc[1], -rc[2], -rc[3]] as const;
    const p = [0.0, 0.0, 0.0, GRAVITY_CONSTANT] as const;

    const hrp = [
        r[0] * p[0] - r[1] * p[1] - r[2] * p[2] - r[3] * p[3],
        r[0] * p[1] + r[1] * p[0] + r[2] * p[3] - r[3] * p[2],
        r[0] * p[2] - r[1] * p[3] + r[2] * p[0] + r[3] * p[1],
        r[0] * p[3] + r[1] * p[2] - r[2] * p[1] + r[3] * p[0],
    ] as const;

    const hFinal = [
        hrp[0] * rc[0] - hrp[1] * rc[1] - hrp[2] * rc[2] - hrp[3] * rc[3],
        hrp[0] * rc[1] + hrp[1] * rc[0] + hrp[2] * rc[3] - hrp[3] * rc[2],
        hrp[0] * rc[2] - hrp[1] * rc[3] + hrp[2] * rc[0] + hrp[3] * rc[1],
        hrp[0] * rc[3] + hrp[1] * rc[2] - hrp[2] * rc[1] + hrp[3] * rc[0],
    ] as const;

    const gravityAdjustment = model === "x2" ? 1.0 : 1.2;

    const acceleration: Vector = {
        x: gravityRawX - hFinal[1] * -gravityAdjustment,
        y: gravityRawY - hFinal[2] * -gravityAdjustment,
        z: gravityRawZ - hFinal[3] * gravityAdjustment,
    };

    return { rotation, acceleration, ankleAngle, magStatus, tap };
}
