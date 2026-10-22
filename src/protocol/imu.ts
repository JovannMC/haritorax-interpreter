import { toByteArray as decodeBase64 } from "base64-js";
import type { MagStatus, Quaternion, TrackerModel, Vector } from "../types.js";

const ROTATION_SCALAR = 0.01 / 180.0;
const GRAVITY_SCALAR = 1 / 256.0;
const GRAVITY_CONSTANT = 9.81;

// A-D is for HXW, rest for HX2
// need to actually find proper data for HX2, it is very inaccurate. HX2 has more mag information
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

export interface DecodedImu {
    rotation: Quaternion;
    acceleration: Vector;
    ankleAngle?: number;
    magStatus?: MagStatus;
}

export function decodeImu(base64: string, model: TrackerModel, magByte?: number): DecodedImu | undefined {
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
    const magStatus =
        magByte !== undefined
            ? (MAG_BY_BYTE[magByte] ?? "unknown")
            : (MAG_BY_CHAR[base64.charAt(base64.length - 5)] ?? "veryBad");

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

    return { rotation, acceleration, ankleAngle, magStatus };
}
