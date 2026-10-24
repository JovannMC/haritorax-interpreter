import { HaritoraXError } from "../../lib/errors.js";
import type { BatteryInfo, FpsMode, SensorAutoCorrection, SensorMode, TrackerModel, TrackerSettings } from "../../types.js";

export interface ParsedInfo {
    version: string;
    model: string;
    serialNumber: string;
    imuCount?: number;
}

export function parseInfo(payload: string): ParsedInfo | undefined {
    try {
        const data = JSON.parse(payload) as Record<string, unknown>;
        const version = typeof data["version"] === "string" ? data["version"] : "";
        const model = typeof data["model"] === "string" ? data["model"] : "";
        const serialNumber = typeof data["serial no"] === "string" ? data["serial no"] : "";
        const imuCount = typeof data["imu_num"] === "number" ? data["imu_num"] : undefined;

        if (!model) return undefined;
        return { version, model, serialNumber, imuCount };
    } catch {
        return undefined;
    }
}

export interface ParsedBattery {
    level: number | null;
    voltage: number | null;
    chargeStatus: BatteryInfo["chargeStatus"];
}

export function parseBattery(payload: string): ParsedBattery | undefined {
    try {
        const data = JSON.parse(payload) as Record<string, unknown>;
        const level = typeof data["battery remaining"] === "number" ? data["battery remaining"] : null;
        const voltage = typeof data["battery voltage"] === "number" ? data["battery voltage"] : null;
        const status = typeof data["charge status"] === "string" ? data["charge status"].toLowerCase() : "";

        const chargeStatus = status === "discharging" || status === "charging" || status === "charged" ? status : "unknown";

        return { level, voltage, chargeStatus };
    } catch {
        return undefined;
    }
}

export function decodeSettings(payload: string): TrackerSettings | undefined {
    if (payload.length < 14) return undefined;

    const fpsMode: FpsMode = payload.charAt(5) === "0" ? 50 : 100;
    const sensorMode: SensorMode = payload.charAt(6) === "0" ? 2 : 1;
    const correctionBits = Number.parseInt(payload.charAt(10), 10);
    const ankleMotionDetection = payload.charAt(13) !== "0";

    if (Number.isNaN(correctionBits)) return undefined;

    const sensorAutoCorrection: SensorAutoCorrection[] = (["accel", "gyro", "mag"] as const).filter(
        (_, i) => correctionBits & (1 << i),
    );

    return { sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection };
}

export function modelFromFirmware(model: string): TrackerModel {
    const firmware = model.toLowerCase();
    if (firmware === "mc1" || firmware === "mc2" || firmware === "mc2b") return "wired";
    else if (firmware === "mc3s") return "wireless";
    else if (firmware === "mc4b") return "x2";
    else throw new HaritoraXError("DECODE_FAILED", `Unknown firmware model "${model}"`);
}
