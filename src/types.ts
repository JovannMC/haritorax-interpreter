export type TrackerModel = "wireless" | "x2" | "wired";

export type BodyPart =
    | "chest"
    | "hip"
    | "leftKnee"
    | "leftAnkle"
    | "rightKnee"
    | "rightAnkle"
    | "leftElbow"
    | "rightElbow"
    | "leftWrist"
    | "rightWrist"
    | "head"
    | "leftFoot"
    | "rightFoot"
    | "unassigned";

export type ImuRole = "ankle" | "knee";

export interface Vector {
    x: number;
    y: number;
    z: number;
}

export interface Quaternion {
    x: number;
    y: number;
    z: number;
    w: number;
}

export interface ImuSample {
    deviceId: string;
    bodyPart: BodyPart;
    role: ImuRole;
    rotation: Quaternion;
    acceleration: Vector;
    ankleAngle?: number;
    timestamp: number;
}

export type MagStatus = "great" | "okay" | "bad" | "veryBad" | "unknown";

export interface BatteryInfo {
    deviceId: string;
    level: number | null;
    voltage: number | null;
    chargeStatus: "discharging" | "charging" | "charged" | "unknown" | null;
    timestamp: number;
}

export interface DeviceInfo {
    deviceId: string;
    version: string;
    model: string;
    serialNumber: string;
    imuCount?: number;
    timestamp: number;
}

export type SensorMode = 1 | 2;
export type FpsMode = 50 | 100;
export type SensorAutoCorrection = "accel" | "gyro" | "mag";

export interface TrackerSettings {
    sensorMode: SensorMode;
    fpsMode: FpsMode;
    sensorAutoCorrection: SensorAutoCorrection[];
    ankleMotionDetection: boolean;
}

export type ConnectionKind = "bluetooth-le" | "serial";

export type DisconnectReason = "requested" | "timeout" | "remote" | "error";

// port or peripheral we can talk to
export interface EndpointDescriptor {
    id: string;
    connection: ConnectionKind;
    displayName: string;
    model?: TrackerModel;
    rssi?: number;
    dongle?: "GX6" | "GX2";
    channel?: number;
}

export interface DeviceSnapshot {
    deviceId: string;
    // one entry per IMU
    bodyParts: BodyPart[];
    imuCount: number;
    model: TrackerModel;
    connection: ConnectionKind;
    connected: boolean;
    // tracker id maps to the body part that it is assigned to (which isn't necessary for SlimeTora)
    trackerId?: string;
    battery?: BatteryInfo;
    mag?: MagStatus;
    settings?: TrackerSettings;
}

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug" | "trace";

export interface LogEntry {
    level: Exclude<LogLevel, "silent">;
    message: string;
    deviceId?: string;
    timestamp: number;
    data?: Record<string, unknown>;
}

/*
 * events
 */

export interface Events {
    error: { error: Error };
    log: LogEntry;
    devices: { devices: DeviceSnapshot[] };
    "device:connected": { deviceId: string };
    "device:disconnected": { deviceId: string; reason: DisconnectReason };
    imu: ImuSample;
    battery: BatteryInfo;
    mag: { deviceId: string; status: MagStatus };
    info: DeviceInfo;
    settings: { deviceId: string; settings: TrackerSettings };
    channel: { endpointId: string; channel: number };
    identified: { deviceId: string; trackerId: string; bodyPart: BodyPart };
    paired: { endpointId: string; slot: string; deviceId: string };
    unpaired: { endpointId: string; slot: string; deviceId: string };
    button: { deviceId: string; button: "main" | "sub" | "sub2" };
}

export type Unsubscribe = () => void;

export type EventHandler<E extends keyof Events> = (payload: Events[E]) => void;
