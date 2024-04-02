declare module "haritorax-interpreter" {
    export interface DeviceInfo {
        version: string;
        model: string;
        serial: string;
    }

    export interface BatteryInfo {
        batteryRemaining: number;
        batteryVoltage: number;
        chargeStatus: string;
    }

    export interface TrackerSettings {
        sensorMode: number;
        fpsMode: number;
        sensorAutoCorrection: string[];
        ankleMotionDetection: boolean;
    }

    export interface TrackerButtons {
        mainButton: boolean;
        subButton: boolean;
    }

    export type HaritoraXWirelessEvent = 'imu' | 'tracker' | 'button' | 'battery' | 'settings' | 'info' | 'connect' | 'disconnect';

    export class HaritoraXWireless {
        constructor(debugMode?: number);
        startConnection(connectionMode: string, portNames?: string[]): void;
        stopConnection(connectionMode: string): void;
        setTrackerSettings(trackerName: string, sensorMode: number, fpsMode: number, sensorAutoCorrection: string[], ankleMotionDetection: boolean): boolean;
        setAllTrackerSettings(sensorMode: number, fpsMode: number, sensorAutoCorrection: string[], ankleMotionDetection: boolean): boolean;
        getDeviceInfo(trackerName: string): Promise<DeviceInfo>;
        getBatteryInfo(trackerName: string): Promise<BatteryInfo>;
        getActiveTrackers(): string[];
        getTrackerSettings(trackerName: string): TrackerSettings;
        getTrackerSettingsRaw(trackerName: string): string;
        getTrackerBattery(trackerName: string): BatteryInfo;
        getTrackerButtons(trackerName: string): TrackerButtons;
        getConnectionModeActive(connectionMode: string): boolean;

        on(event: HaritoraXWirelessEvent, listener: Function): this;
        off(event: HaritoraXWirelessEvent, listener: Function): this;
        once(event: HaritoraXWirelessEvent, listener: Function): this;
    }
}
