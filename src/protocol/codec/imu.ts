import { toByteArray as decodeBase64 } from "base64-js";
import type { MagStatus, Quaternion, TrackerModel, Vector } from "../../types.js";

const ROTATION_SCALAR = 1 / 16384;
const GRAVITY_CONSTANT = 9.80665;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const ACCEL_SCALAR: Readonly<Record<TrackerModel, number>> = Object.freeze({
    x2: GRAVITY_CONSTANT / 2048,
    wireless: 1 / 256,
    wired: 1 / 256,
});

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

// range sensors (ankle motion detection) append mm distance to IMU frames
export function decodeRange(model: TrackerModel, raw: number | undefined): number | undefined {
    if (raw === undefined || raw === 0xffff) return undefined;

    if (model === "x2") return raw >> 5;

    const signed = raw > 0x7fff ? raw - 0x10000 : raw;
    return signed >= 0 ? signed : undefined;
}

export interface DecodedImu {
    rotation: Quaternion;
    acceleration: Vector;
    magStatus?: MagStatus;
    tap?: number;
}

export function decodeImu(base64: string, model: TrackerModel, statusWord?: number, imuIndex = 0): DecodedImu | undefined {
    return decodeImuFrame(decodeBase64(base64), model, statusWord, imuIndex, base64.charAt(base64.length - 5));
}

export function decodeImuBytes(
    bytes: Uint8Array,
    model: TrackerModel,
    statusWord?: number,
    imuIndex = 0,
): DecodedImu | undefined {
    const encodedLength = Math.ceil(bytes.length / 3) * 4;
    const legacyMagCharacterIndex = encodedLength - 5;
    const legacyMagByteIndex = Math.floor(legacyMagCharacterIndex / 4) * 3 + 2;
    const legacyMagByte = legacyMagCharacterIndex < 0 ? undefined : bytes[legacyMagByteIndex];
    const legacyMagCharacter = legacyMagByte === undefined ? "" : BASE64_ALPHABET.charAt(legacyMagByte & 0x3f);

    return decodeImuFrame(bytes, model, statusWord, imuIndex, legacyMagCharacter);
}

export function decodeImuBytesAt(
    bytes: Uint8Array,
    byteOffset: number,
    model: TrackerModel,
    statusWord?: number,
    imuIndex = 0,
): DecodedImu | undefined {
    if (!Number.isInteger(byteOffset) || byteOffset < 0 || byteOffset + 14 > bytes.length) return undefined;

    const legacyMagByte = bytes[byteOffset + 11];
    const legacyMagCharacter = legacyMagByte === undefined ? "" : BASE64_ALPHABET.charAt(legacyMagByte & 0x3f);
    return decodeImuFrame(bytes, model, statusWord, imuIndex, legacyMagCharacter, byteOffset);
}

function decodeImuFrame(
    bytes: Uint8Array,
    model: TrackerModel,
    statusWord: number | undefined,
    imuIndex: number,
    legacyMagCharacter: string,
    byteOffset = 0,
): DecodedImu | undefined {
    if (byteOffset < 0 || byteOffset + 14 > bytes.length) return undefined;

    const rotation: Quaternion = {
        x: readInt16LE(bytes, byteOffset) * ROTATION_SCALAR,
        y: readInt16LE(bytes, byteOffset + 2) * ROTATION_SCALAR,
        z: readInt16LE(bytes, byteOffset + 4) * ROTATION_SCALAR,
        w: readInt16LE(bytes, byteOffset + 6) * ROTATION_SCALAR,
    };

    const accelScalar = ACCEL_SCALAR[model];
    const gravityRawX = readInt16LE(bytes, byteOffset + 8) * accelScalar;
    const gravityRawY = readInt16LE(bytes, byteOffset + 10) * accelScalar;
    const gravityRawZ = readInt16LE(bytes, byteOffset + 12) * accelScalar;

    let magStatus: MagStatus | undefined;
    let tap: number | undefined;
    if (statusWord !== undefined) {
        const fields = decodeImuStatus(statusWord, imuIndex);
        magStatus = fields.mag;
        tap = fields.tap;
    } else if (model === "wireless") {
        magStatus = MAG_BY_CHAR[legacyMagCharacter] ?? "veryBad";
    }

    const gravityX = 2 * (rotation.x * rotation.z - rotation.w * rotation.y) * GRAVITY_CONSTANT;
    const gravityY = 2 * (rotation.y * rotation.z + rotation.w * rotation.x) * GRAVITY_CONSTANT;
    const gravityZ =
        (rotation.w * rotation.w + rotation.z * rotation.z - rotation.x * rotation.x - rotation.y * rotation.y) *
        GRAVITY_CONSTANT;

    const acceleration: Vector = {
        x: gravityRawX - gravityX,
        y: gravityRawY - gravityY,
        z: gravityRawZ - gravityZ,
    };

    if (model === "x2") {
        const rotationX = rotation.x;
        rotation.x = -rotation.y;
        rotation.y = rotationX;

        const accelerationX = acceleration.x;
        acceleration.x = -acceleration.y;
        acceleration.y = accelerationX;
    }

    return { rotation, acceleration, magStatus, tap };
}

function readInt16LE(bytes: Uint8Array, offset: number): number {
    const value = bytes[offset]! | (bytes[offset + 1]! << 8);
    return value > 0x7fff ? value - 0x10000 : value;
}
