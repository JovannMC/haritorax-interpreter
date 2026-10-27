import type { TrackerModel } from "../types.js";

// cutoffs of firmware versions that have this behaviour, per tracker model
type PerModel = Partial<Record<TrackerModel, string>>;

export interface FirmwareVersion {
    major: number;
    minor: number;
    patch: number;
}

export function parseFirmwareVersion(text: string | undefined): FirmwareVersion | undefined {
    const match = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
    if (!match) return undefined;

    return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareFirmwareVersions(left: FirmwareVersion, right: FirmwareVersion): number {
    return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

export function firmwareAtLeast(version: string | undefined, minimum: string): boolean | undefined {
    const current = parseFirmwareVersion(version);
    const required = parseFirmwareVersion(minimum);
    if (!current || !required) return undefined;

    return compareFirmwareVersions(current, required) >= 0;
}

/*
 * dongle/serial stuff
 */

// from this dongle version, the dongle carries HX2 two-IMU frames (30/32 bytes). 1.0.19 can't
const DONGLE_TWO_IMU = "1.0.26";
// from this dongle version, `r(x):` grows to 14 bits where bits 12-13 carry the accel accuracy of the IMUs' accelerometers
const DONGLE_ACCEL_ACCURACY = "1.0.29";
// from this dongle version, the dongle clears a pending command (modeChange) itself after 0.5 s
const DONGLE_SELF_CLEARS = "1.0.29";
// from this dongle version, the dongle keeps re-sending a pending command. older ones send it once
const DONGLE_REPEATS_COMMANDS = "1.1.1";
// from this tracker version, a command only takes effect after 4 consecutive settings packets
const TRACKER_CONFIRMS_COMMANDS = "1.1.1";
// from this tracker version, setting the body part requires a 0A 1F <id> 00 sequence. earlier builds accept the id directly
const BODY_PART_UNLOCK: PerModel = Object.freeze({ x2: "1.0.14", wireless: "1.0.27" });

// how long to hold a power-off / switch-to-BLE command before clearing
const COMMAND_HOLD_MS = 150;
const CONFIRMED_COMMAND_HOLD_MS = 600;

export function dongleReportsAccelAccuracy(dongleVersion: string | undefined): boolean | undefined {
    return firmwareAtLeast(dongleVersion, DONGLE_ACCEL_ACCURACY);
}

export function dongleCarriesTwoImus(dongleVersion: string | undefined): boolean | undefined {
    return firmwareAtLeast(dongleVersion, DONGLE_TWO_IMU);
}

export function dongleSelfClearsCommands(dongleVersion: string | undefined): boolean | undefined {
    return firmwareAtLeast(dongleVersion, DONGLE_SELF_CLEARS);
}

export function dongleMayDropCommands(trackerVersion: string | undefined, dongleVersion: string | undefined): boolean {
    return (
        firmwareAtLeast(trackerVersion, TRACKER_CONFIRMS_COMMANDS) === true &&
        firmwareAtLeast(dongleVersion, DONGLE_REPEATS_COMMANDS) === false
    );
}

export function commandHoldMs(trackerVersion: string | undefined): number {
    return firmwareAtLeast(trackerVersion, TRACKER_CONFIRMS_COMMANDS) === false ? COMMAND_HOLD_MS : CONFIRMED_COMMAND_HOLD_MS;
}

export function bodyPartNeedsUnlock(model: TrackerModel, trackerVersion: string | undefined): boolean | undefined {
    const since = BODY_PART_UNLOCK[model];
    if (since === undefined) return true;

    return firmwareAtLeast(trackerVersion, since);
}

/*
 * BLE stuff
 */

// BLE `sensor2` (00dbc400) carries the status word
const SENSOR2: PerModel = Object.freeze({ wireless: "1.0.26" });
// the tracker notifies the attach point over BLE after a write.
const BODY_PART_NOTIFY: PerModel = Object.freeze({ wireless: "1.0.27" });

// only true once the version proves the tracker sends sensor2, an unknown version has to be detected from the traffic
export function hasSensor2(model: TrackerModel, trackerVersion: string | undefined): boolean {
    if (model === "x2") return true;

    const since = SENSOR2[model];
    return since !== undefined && firmwareAtLeast(trackerVersion, since) === true;
}

// unknown versions assume the notification, which current firmware sends
export function bodyPartNotifies(model: TrackerModel, trackerVersion: string | undefined): boolean {
    const since = BODY_PART_NOTIFY[model];
    return since === undefined || firmwareAtLeast(trackerVersion, since) !== false;
}

/*
 * general
 */

const BASE_LOCK: Partial<Record<TrackerModel, { first: string; removed: string }>> = Object.freeze({
    x2: Object.freeze({ first: "1.0.0", removed: "1.0.24" }),
    wireless: Object.freeze({ first: "1.0.0", removed: "1.0.28" }),
});

// serial symbols are base 34 (no I or O), the last one is the factory attach point
const SERIAL_ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";

// the factory body part is the serial's last symbol
export function factoryAttachPoint(serial: string | undefined): number | undefined {
    const last = serial?.trim().slice(-1).toUpperCase();
    if (!last) return undefined;

    const index = SERIAL_ALPHABET.indexOf(last);
    return index < 0 ? undefined : index & 0x1f;
}

// on firmwares that have the base lock, a tracker whose serial ends in a non-zero symbol keeps its factory body part and refuses changes
export function bodyPartBaseLocked(
    model: TrackerModel,
    trackerVersion: string | undefined,
    serial: string | undefined,
): boolean | undefined {
    const factory = factoryAttachPoint(serial);
    if (factory === undefined) return undefined;
    // extras (serial ends in 0) have no factory part to keep
    if (factory === 0) return false;

    const lock = BASE_LOCK[model];
    if (!lock) return false;

    if (firmwareAtLeast(trackerVersion, lock.first) !== true) return undefined;

    const removed = firmwareAtLeast(trackerVersion, lock.removed);
    return removed === undefined ? undefined : !removed;
}

export function baseLockRemovedIn(model: TrackerModel): string | undefined {
    return BASE_LOCK[model]?.removed;
}
