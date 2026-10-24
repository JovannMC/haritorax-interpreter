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

export type ImuRole = "ankle" | "knee" | "single";

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
    trackerId: string;
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

export type ConnectionKind = "ble" | "serial";

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

export interface TrackerSnapshot {
    // `serialNumber:imuIndex` (e.g. A00000:1)
    trackerId: string;
    deviceId: string;
    endpointId: string;
    bodyPart: BodyPart;
    connected: boolean;
    lastSeen?: number;
    // dongle RSSI (dongle hearing tracker) OR ble RSSI (dongle hearing peripheral, i think)
    rssi?: number;
    // sensor RSSI (tracker hearing dongle)
    sensorRssi?: number;
    mag?: MagStatus;
}

export interface DeviceSnapshot {
    // serial number, e.g. "A2E987"
    deviceId: string;
    endpointId: string;
    slot: string;
    imuCount: number;
    model: TrackerModel;
    connection: ConnectionKind;
    trackers: TrackerSnapshot[];
    battery?: BatteryInfo;
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

    // "endpoint" is the port/peripheral being talked to
    // for example, a single port from the GX dongle or single BLE peripheral
    "endpoint:connected": { endpointId: string; connection: ConnectionKind; displayName: string };
    "endpoint:disconnected": { endpointId: string; reason: DisconnectReason };

    // "device" is a physical device connected to an endpoint
    // it might have multiple IMUs like the HX2 leg/thigh combo (2 "tracker"s)
    "device:connected": {
        deviceId: string;
        endpointId: string;
        slot: string;
        connection: ConnectionKind;
        model: TrackerModel;
        imuCount: number;
    };
    "device:disconnected": { deviceId: string; endpointId: string; reason: DisconnectReason };

    // "tracker" is an individual IMU of a device
    "tracker:connected": { trackerId: string; deviceId: string; endpointId: string; bodyPart: BodyPart };
    "tracker:disconnected": { trackerId: string; deviceId: string; reason: DisconnectReason };

    imu: ImuSample;
    battery: BatteryInfo;
    mag: { trackerId: string; deviceId: string; status: MagStatus };
    rssi: {
        trackerId: string;
        deviceId: string;
        rssi: number;
        sensorRssi?: number;
    };
    info: DeviceInfo;
    settings: { deviceId: string; settings: TrackerSettings };
    channel: { endpointId: string; channel: number };
    identified: { trackerId: string; deviceId: string; bodyPart: BodyPart };
    paired: { endpointId: string; slot: string };
    unpaired: { endpointId: string; slot: string };
    button: { deviceId: string; trackerId?: string; button: "main" | "sub" | "sub2" };
}

export type Unsubscribe = () => void;

export type EventHandler<E extends keyof Events> = (payload: Events[E]) => void;
