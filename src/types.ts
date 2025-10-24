export enum TrackerModel {
    Wireless = "wireless",
    Wired = "wired",
    X2 = "x2",
}

// For COM trackers (wired/wireless with GX dongle)
export enum Tracker {
    RightKnee = "rightKnee",
    RightAnkle = "rightAnkle",
    Hip = "hip",
    Chest = "chest",
    LeftKnee = "leftKnee",
    LeftAnkle = "leftAnkle",
    LeftElbow = "leftElbow",
    RightElbow = "rightElbow",
}

export enum SensorMode {
    MagEnabled = 1,
    MagDisabled = 2,
}

export enum FPSMode {
    Mode50 = 50,
    Mode100 = 100,
}

export type SensorAutoCorrection = "accel" | "gyro" | "mag";

export enum MagStatus {
    GREAT = "great",
    OKAY = "okay",
    BAD = "bad",
    VERY_BAD = "very bad",
    Unknown = "unknown",
}
