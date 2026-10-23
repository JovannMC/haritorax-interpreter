import { fromByteArray as encodeBase64, toByteArray as decodeBase64 } from "base64-js";
import type { BodyPart, ImuRole } from "../types.js";

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

// receiving "r:330"
// marks a completed pairing
// TODO: check if this is actually the case, for some reason i checked either the first and second chars
export function parsePairingResult(payload: string): boolean {
    return payload.charAt(0) === "3" || payload.charAt(1) === "3";
}

// receiving "r0:110070200000"
// carries the tracker id in the 5th character
export function parseTrackerId(payload: string): string | undefined {
    const id = payload.charAt(4).toLowerCase();
    return id !== "" && id !== "0" ? id : undefined;
}

export interface DongleImuSlice {
    payload: string;
    role: ImuRole;
    index: number;
    magByte?: number;
}

// one 14-byte IMU packet or a 30-byte packet carrying two IMUs (leg + thigh)
export function splitDongleImu(payload: string, trackerCount: number): DongleImuSlice[] {
    const bytes = decodeBase64(payload);

    if (bytes.length >= 30 && trackerCount >= 2) {
        return [
            { payload: encodeBase64(bytes.slice(0, 14)), role: "ankle", index: 0, magByte: bytes[14] },
            { payload: encodeBase64(bytes.slice(16, 30)), role: "knee", index: 1, magByte: bytes[15] },
        ];
    }

    return [{ payload, role: "ankle", index: 0 }];
}

export function bodyPartOfTracker(trackerId: string): BodyPart | undefined {
    return TRACKER_PARTS[trackerId];
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

// sending "o:1140"
// start pairing to channel 4, slot 0
export function pairCommands(channel: number, slot: "0" | "1"): readonly string[] {
    if (slot === "0") {
        return Object.freeze([`o:11${channel.toString(16)}0`, `o:10${channel.toString(16)}0`, setChannelCommand(channel)]);
    }

    return Object.freeze([`o:22${channel.toString(16)}0`, `o:20${channel.toString(16)}0`, setChannelCommand(channel)]);
}

// sending "o:3041" then "o:3040"
// unpairing slot 0 on channel 4 (slot 1 uses "o:3042")
export function unpairCommands(channel: number, slot: "0" | "1"): readonly string[] {
    if (slot === "0") return Object.freeze([`o:30${channel.toString(16)}1`, setChannelCommand(channel)]);

    return Object.freeze([`o:30${channel.toString(16)}2`, setChannelCommand(channel)]);
}
