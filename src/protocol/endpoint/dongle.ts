import { fromByteArray as encodeBase64, toByteArray as decodeBase64 } from "base64-js";
import { readImuStatusWord } from "../codec/imu.js";
import type { AccelAccuracy, BodyPart, ImuRole, TrackerSettings } from "../../types.js";

const TRACKER_PARTS: Readonly<Record<string, BodyPart>> = Object.freeze({
    "1": "chest",
    "2": "leftKnee",
    "3": "leftAnkle",
    "4": "rightKnee",
    "5": "rightAnkle",
    "6": "hip",
    "7": "leftElbow",
    "8": "rightElbow",
    "9": "leftWrist",
    a: "rightWrist",
    b: "head",
    c: "leftFoot",
    d: "rightFoot",
    e: "leftHand",
    f: "rightHand",
});

export function isDongleSlot(slot: string): slot is "0" | "1" {
    return slot === "0" || slot === "1";
}

// 1-10 are valid channels, 10 being "a" (hex)
// my dumbass in v3 let 0 be a real channel, but pretty sure that doesn't exist
export function isValidChannel(channel: number): boolean {
    return Number.isInteger(channel) && channel > 0 && channel <= 10;
}

// sending/receiving "o:3040"
// the third character in the data is the channel
export function parseChannel(payload: string): number | undefined {
    if (payload.length < 3) return undefined;

    const channel = Number.parseInt(payload.charAt(2), 16);
    return isValidChannel(channel) ? channel : undefined;
}

export interface DongleRegister {
    // the mode ordered with "o:", 3 is sensing
    mode: number;
    // bit n = slot n has been paired since the dongle booted
    paired: number;
    // bit n = slot n has no tracker stored
    unpaired: number;
}

// receiving "r:300", the dongle register: [mode][paired slots][unpaired slots]
export function parseDongleRegister(payload: string): DongleRegister | undefined {
    if (payload.length < 3) return undefined;

    const mode = Number.parseInt(payload.charAt(0), 16);
    const paired = Number.parseInt(payload.charAt(1), 16);
    const unpaired = Number.parseInt(payload.charAt(2), 16);
    if (Number.isNaN(mode) || Number.isNaN(paired) || Number.isNaN(unpaired)) return undefined;

    return { mode, paired, unpaired };
}

// the dongle stays in pairing mode until the host leaves it, and sets the slot's bit once a tracker has been bound to it
// ordering a pairing reset for the slot clears the bit first, so a set bit after that means a new pairing
export function isSlotPaired(register: DongleRegister, slot: "0" | "1"): boolean {
    return (register.paired & (1 << Number(slot))) !== 0;
}

// receiving "r0:110070200000"
// carries the tracker id in the 5th character
export function parseTrackerId(payload: string): string | undefined {
    const id = payload.charAt(4).toLowerCase();
    return id !== "" && id !== "0" ? id : undefined;
}

// dongle firmware from 1.0.29 ends `r(x):` frames with the accel accuracy (0-3) of the first and second IMU, 12 bytes become 14 (HX2 only)
export function parseDongleAccelAccuracy(payload: string): AccelAccuracy[] | undefined {
    if (payload.length < 14) return undefined;

    const accuracy: AccelAccuracy[] = [];
    for (const index of [12, 13]) {
        const value = Number.parseInt(payload.charAt(index), 16);
        if (Number.isNaN(value) || value > 3) return undefined;
        accuracy.push(value as AccelAccuracy);
    }

    return accuracy;
}

export interface DongleImuSlice {
    // base64 of the 14 bytes of quaternion + acceleration
    payload: string;
    role: ImuRole;
    index: number;
    status?: number;
    // raw range sensor value (see decodeRange), the sensor sits at the first IMU
    range?: number;
}

// decoded IMU packets from the dongle:
//  14 bytes: [IMU0 14]
//  16 bytes: [IMU0 14][status 2]
//  18 bytes: [IMU0 14][status 2][range 2]
//  30 bytes: [IMU0 14][status 2][IMU1 14]
//  32 bytes: [IMU0 14][status 2][range 2][IMU1 14]
export function splitDongleImu(payload: string, trackerCount: number): DongleImuSlice[] {
    const bytes = decodeBase64(payload);
    if (bytes.length < 14) return [];

    const status = readImuStatusWord(bytes);
    const hasRange = bytes.length === 18 || bytes.length === 32;
    const range = hasRange ? readUint16(bytes, 16) : undefined;

    const slices: DongleImuSlice[] = [
        {
            payload: encodeBase64(bytes.slice(0, 14)),
            role: "ankle",
            index: 0,
            ...(status === undefined ? {} : { status }),
            ...(range === undefined ? {} : { range }),
        },
    ];

    const secondOffset = hasRange ? 18 : 16;
    if (trackerCount >= 2 && bytes.length >= secondOffset + 14) {
        slices.push({
            payload: encodeBase64(bytes.slice(secondOffset, secondOffset + 14)),
            role: "knee",
            index: 1,
            ...(status === undefined ? {} : { status }),
        });
    }

    return slices;
}

function readUint16(bytes: Uint8Array, offset: number): number | undefined {
    const low = bytes[offset];
    const high = bytes[offset + 1];
    if (low === undefined || high === undefined) return undefined;

    return low | (high << 8);
}

export function bodyPartOfTracker(trackerId: string): BodyPart | undefined {
    return TRACKER_PARTS[trackerId];
}

// the id a tracker stores for a body part
export function trackerIdOfBodyPart(bodyPart: BodyPart): number | undefined {
    for (const [id, part] of Object.entries(TRACKER_PARTS)) {
        if (part === bodyPart) return Number.parseInt(id, 16);
    }

    return undefined;
}

// for HX2 with 2 IMUs, the first part is the "ankle" (leg), the second part is the "knee" (thigh)
// ..i think
export function bodyPartsFor(bodyPart: BodyPart, imuCount: number): BodyPart[] {
    const parts: BodyPart[] = Array.from({ length: imuCount }, () => "unassigned");
    parts[0] = bodyPart;

    if (imuCount > 1) {
        const isAnkle = bodyPart === "leftAnkle" || bodyPart === "rightAnkle";
        const knee = isAnkle ? (bodyPart === "leftAnkle" ? "leftKnee" : "rightKnee") : undefined;
        if (knee !== undefined) parts[1] = knee;
    }

    return parts;
}

export function setChannelCommand(channel: number): string {
    return `o:30${channel.toString(16)}0`;
}

// sending "o:1140" then "o:1040"
// start pairing to channel 4, slot 0
export function pairCommands(channel: number, slot: "0" | "1"): readonly string[] {
    if (slot === "0") return Object.freeze([`o:11${channel.toString(16)}0`, `o:10${channel.toString(16)}0`]);

    return Object.freeze([`o:22${channel.toString(16)}0`, `o:20${channel.toString(16)}0`]);
}

// sending "o:3041" then "o:3040"
// unpairing slot 0 on channel 4 (slot 1 uses "o:3042")
export function unpairCommands(channel: number, slot: "0" | "1"): readonly string[] {
    if (slot === "0") return Object.freeze([`o:30${channel.toString(16)}1`, setChannelCommand(channel)]);

    return Object.freeze([`o:30${channel.toString(16)}2`, setChannelCommand(channel)]);
}

// bits in dongle settings and what they're for according to firmware
// 0 - led
// 1 - calibrationReseting
// 2 - calibrationMode
// 3-4 - attachPoint
// 5 - speedMode
// 6 - imuMode
// 7 - sensorOrderMode
// 8 - gyroRate
// 9 - noMag
// 10 - dcal
// 11 - magSt
// 12 - modeChange
// 13 - rangeSensorEnable
const SETTINGS_DIGITS = 14;
const DEFAULT_SETTINGS = "00000000100000";

export function dongleSettingsCommand(
    slot: string,
    settings: TrackerSettings,
    command?: number,
    attachPoint?: number,
    echo?: string,
): string {
    const digits = (echo !== undefined && echo.length === SETTINGS_DIGITS ? echo : DEFAULT_SETTINGS).split("");

    let correction = 0;
    if (settings.sensorAutoCorrection.includes("accel")) correction |= 1;
    if (settings.sensorAutoCorrection.includes("gyro")) correction |= 2;
    if (settings.sensorAutoCorrection.includes("mag")) correction |= 4;

    digits[5] = settings.fpsMode === 100 ? "1" : "0";
    digits[6] = settings.sensorMode === 1 ? "1" : "0";
    digits[10] = correction.toString(16);
    digits[12] = String(command ?? 0);
    digits[13] = settings.ankleMotionDetection ? "1" : "0";

    if (attachPoint !== undefined) {
        const attach = attachPoint.toString(16).padStart(2, "0");
        digits[3] = attach.charAt(0);
        digits[4] = attach.charAt(1);
    }

    return `o${slot}:${digits.join("")}`;
}

// the tracker applies a body part sent through the dongle only after seeing 0x0A, 0x1F, <id>, 0x00 in the attach point digits.
// firmware without that requirement gets the id alone (the caller decides with bodyPartNeedsUnlock)
export function bodyPartCommands(
    slot: string,
    settings: TrackerSettings,
    trackerId: number,
    unlock: boolean,
    echo?: string,
): string[] {
    const steps = unlock ? [0x0a, 0x1f, trackerId, 0x00] : [trackerId];
    return steps.map((attachPoint) => dongleSettingsCommand(slot, settings, undefined, attachPoint, echo));
}

// e.g. `r0:110060800a00`
// bits 6 and 9 count main and sub button presses (from any event, 0-15)
// bits 7-8 and 10-11 hold the last event code (00 short, 02 medium, 04 held)
// TODO: expose that event code maybe, more bindings yay
export function parseDongleButtons(payload: string, previous: DongleButtonState | undefined): DongleButtonState {
    const main = counterDigit(payload, 6);
    const sub = counterDigit(payload, 9);
    const result: DongleButtonState = { main, sub };

    // ignore first frame (may have previous counts)
    if (!previous) return result;

    if (main !== previous.main) result.pressed = "main";
    else if (sub !== previous.sub) result.pressed = "sub";

    return result;
}

function counterDigit(payload: string, index: number): number {
    const digit = Number.parseInt(payload.charAt(index), 16);
    return Number.isNaN(digit) ? 0 : digit;
}

export function isButtonDebounced(
    key: string,
    button: "main" | "sub" | "sub2",
    lastPress: Map<string, number>,
    now: number,
    debounceMs: number,
): boolean {
    const tag = `${key}:${button}`;
    const last = lastPress.get(tag);
    if (last !== undefined && now - last < debounceMs) return true;

    lastPress.set(tag, now);
    return false;
}

export interface DongleButtonState {
    main: number;
    sub: number;
    pressed?: "main" | "sub";
}

export interface TrackerRssi {
    dongle: number;
    sensor?: number;
}

// the a: frame is six bytes of -dBm, collected per slot since the previous frame:
//   [dongle min][dongle max][sensor min][sensor max][dongle average][sensor average]
// "dongle" is how well the dongle hears the tracker, "sensor" is how well the tracker hears the dongle (sent in every IMU packet)
export function isRssiLost(payload: string): boolean {
    return payload.toLowerCase() === "7f7f7f7f7f7f";
}

// we only need the average i think
export function decodeTrackerRssi(payload: string): TrackerRssi | undefined {
    const dongle = rssiMagnitude(payload, 4);
    if (dongle === undefined) return undefined;

    const sensor = rssiMagnitude(payload, 5);
    return { dongle: -dongle, ...(sensor === undefined ? {} : { sensor: -sensor }) };
}

// 0 and 7f or above can't be a real signal strength (no samples or stale counters)
function rssiMagnitude(payload: string, byteIndex: number): number | undefined {
    if (payload.length < (byteIndex + 1) * 2) return undefined;

    const value = Number.parseInt(payload.slice(byteIndex * 2, byteIndex * 2 + 2), 16);
    return Number.isNaN(value) || value === 0 || value >= 0x7f ? undefined : value;
}
