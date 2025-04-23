"use strict";

import { Buffer } from "buffer";
import { EventEmitter } from "events";
import BluetoothLinux from "./mode/bluetooth-linux.js";
import { FPSMode, MagStatus, SensorAutoCorrection, SensorMode, TrackerModel } from "./types.js";

let debug = false;
let printIMU = false;
let printRaw = false;
let printWrites = false;

let bluetooth: BluetoothLinux | null = null;
let bluetoothEnabled = false;
let main: HaritoraX;
let canSendButtonData = false;
let canProcessBluetoothData = false;

/*
 * Constants
 */

const GREAT = 3;
const OKAY = 2;
const BAD = 1;
const VERY_BAD = 0;

const SENSOR_MODE_1 = 1;
const SENSOR_MODE_2 = 0;
const FPS_MODE_100 = 1;
const FPS_MODE_50 = 0;

const SENSOR_CORRECTION_BITS: Record<SensorAutoCorrection, number> = {
    accel: 1,
    gyro: 2,
    mag: 4,
};

// Bluetooth
const SERVICE_UUID = "180a";
const VERSION_UUID = "2a28";
const MODEL_UUID = "2a24";
const SERIAL_UUID = "2a25";

// buttons
const MAIN_BUTTON_INDEX = 0;
const SUB_BUTTON_INDEX = 1;
const SUB2_BUTTON_INDEX = 2;

/*
 * Maps
 */

const trackerButtons: Map<string, [number, number, number?]> = new Map([
    // trackerName, [mainButton, subButton, sub2Button]
    ["rightKnee", [0, 0, 0]],
    ["rightAnkle", [0, 0, 0]],
    ["hip", [0, 0, 0]],
    ["chest", [0, 0, 0]],
    ["leftKnee", [0, 0, 0]],
    ["leftAnkle", [0, 0, 0]],
    ["leftElbow", [0, 0, 0]],
    ["rightElbow", [0, 0, 0]],
]);

const trackerSettings: Map<string, [number, number, string[], boolean]> = new Map([
    // trackerName, [sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection]
    ["rightKnee", [2, 50, [], false]],
    ["rightAnkle", [2, 50, [], false]],
    ["hip", [2, 50, [], false]],
    ["chest", [2, 50, [], false]],
    ["leftKnee", [2, 50, [], false]],
    ["leftAnkle", [2, 50, [], false]],
    ["leftElbow", [2, 50, [], false]],
    ["rightElbow", [2, 50, [], false]],
]);

const trackerBattery: Map<string, [number, number, string]> = new Map([
    // trackerName, [batteryRemaining, batteryVoltage, chargeStatus]
    ["rightKnee", [0, 0, ""]],
    ["rightAnkle", [0, 0, ""]],
    ["hip", [0, 0, ""]],
    ["chest", [0, 0, ""]],
    ["leftKnee", [0, 0, ""]],
    ["leftAnkle", [0, 0, ""]],
    ["leftElbow", [0, 0, ""]],
    ["rightElbow", [0, 0, ""]],
]);

const trackerMag: Map<string, string> = new Map([
    // trackerName, magStatus
    ["rightKnee", ""],
    ["rightAnkle", ""],
    ["hip", ""],
    ["chest", ""],
    ["leftKnee", ""],
    ["leftAnkle", ""],
    ["leftElbow", ""],
    ["rightElbow", ""],
]);

const deviceInformation: Map<string, string[]> = new Map([
    // example for wired: {"model":"MC2B", "version":"1.7.10", "serial no":"0000000", "comm":"BLT", "comm_next":"BTSPP"}
    // deviceName, [version, model, serial, comm, comm_next]
    ["HaritoraXWired", ["", "", "", "", ""]],
    ["rightKnee", ["", "", "", "", ""]],
    ["rightAnkle", ["", "", "", "", ""]],
    ["hip", ["", "", "", "", ""]],
    ["chest", ["", "", "", "", ""]],
    ["leftKnee", ["", "", "", "", ""]],
    ["leftAnkle", ["", "", "", "", ""]],
    ["leftElbow", ["", "", "", "", ""]],
    ["rightElbow", ["", "", "", "", ""]],
]);

let trackerService: string;
let settingsService: string;
let batteryService: string;
let magnetometerCharacteristic: string;
let batteryLevelCharacteristic: string;
let batteryVoltageCharacteristic: string;
let chargeStatusCharacteristic: string;
let sensorModeCharacteristic: string;
let fpsModeCharacteristic: string;
let correctionCharacteristic: string;
let ankleCharacteristic: string;

let activeDevices: string[] = [];
let trackerModelEnabled: TrackerModel;

// JSDoc comments for events

/**
 * The "imu" event which provides info about the tracker's IMU data.
 * Supported trackers: wireless, wired
 * Supported connections: COM, Bluetooth
 *
 * @event this#imu
 * @type {object}
 * @property {string} trackerName - The name of the tracker.
 * @property {object} rotation - The rotation data of the tracker.
 * @property {number} rotation.x - The x component of the rotation.
 * @property {number} rotation.y - The y component of the rotation.
 * @property {number} rotation.z - The z component of the rotation.
 * @property {number} rotation.w - The w component of the rotation.
 * @property {object} acceleration - The acceleration data of the tracker.
 * @property {number} acceleration.x - The x component of the gravity.
 * @property {number} acceleration.y - The y component of the gravity.
 * @property {number} acceleration.z - The z component of the gravity.
 * @property {number|undefined} ankle - The ankle motion data of the tracker if enabled. Undefined if disabled.
 **/

/**
 * The "tracker" event which provides info about the tracker's other data.
 * Supported trackers: wireless
 * Supported connections: COM, Bluetooth
 *
 * @event this#tracker
 * @type {object}
 * @property {string} trackerName - The name of the tracker.
 * @property {string} data - The data received from the tracker.
 **/

/**
 * The "mag" event which provides the tracker's magnetometer status
 * Supported trackers: wireless, wired
 * Supported connections: COM, Bluetooth
 *
 * @event this#mag
 * @type {object}
 * @property {string} trackerName - The name of the tracker.
 * @property {string} magStatus - The magnetometer status of the tracker. (green, yellow, red)
 **/

/**
 * The "button" event which provides info about the tracker's button data.
 * Supported trackers: wireless, wired
 * Supported connections: COM, Bluetooth
 *
 * @event this#button
 * @type {object}
 * @property {string} trackerName - The name of the tracker.
 * @property {number} buttonPressed - Which button was pressed (main, sub).
 * @property {boolean} isOn - Whether the tracker is turning on/is on (true) or turning off/is off (false).
 * @property {number} mainButton - Amount of times the main button was pressed.
 * @property {number} subButton - Amount of times the sub button was pressed.
 * @property {number} sub2Button - Amount of times the sub2 button was pressed. (wired only)
 **/

/**
 * The "battery" event which provides info about the tracker's battery data.
 * Supported trackers: wireless, wired
 * Supported connections: COM, Bluetooth
 *
 * @event this#battery
 * @type {object}
 * @property {string} trackerName - The name of the tracker.
 * @property {number} batteryRemaining - The remaining battery percentage of the tracker.
 * @property {number} batteryVoltage - The voltage (in mV) of the tracker's battery. (GX only)
 * @property {string} chargeStatus - The charge status of the tracker. (GX only)
 **/

/**
 * The "info" event which provides info about the tracker or dongle.
 * Supported trackers: wireless, wired
 * Supported connections: COM, Bluetooth
 *
 * @event this#info
 * @type {object}
 * @property {string} name - The name of the device.
 * @property {string} version - The version of the device.
 * @property {string} model - The model of the device.
 * @property {string} serial - The serial number of the device.
 * @property {string} comm - The communication method of the device. (wired only)
 * @property {string} comm_next - The extra info about the communication method(?). (wired only)
 **/

/**
 * The "connect" event which provides the name of the tracker that has connected.
 * Supported trackers: wireless, wired
 * Supported connections: COM, Bluetooth
 *
 * @event this#connect
 * @type {string}
 * @property {string} trackerName - The name of the tracker.
 * @property {string} connectionMode - The connection mode the tracker is using - useful if multiple connection modes are used.
 * @property {string} port - The COM port used the tracker is using (COM only)
 * @property {string} portId - The COM port ID the tracker is using (COM only)
 **/

/**
 * The "disconnect" event which provides the name of the tracker that has disconnected.
 * Supported trackers: wireless, wired
 * Supported connections: COM, Bluetooth
 *
 * @event this#disconnect
 * @type {string}
 * @property {string} trackerName - The name of the tracker.
 **/

/**
 * The HaritoraX class.
 * This class provides methods and events to connect to the HaritoraX trackers, interpret the data, and interact with the trackers.
 *
 * @param {boolean} debugMode - Enable logging of debug messages. (true or false)
 * @param {boolean} printTrackerIMUProcessing - Print the tracker IMU processing data (processIMUData()). (true or false)
 * @param {boolean} printRawData - Print the raw data received from the trackers. (true or false)
 * @param {boolean} printDataWrites - Print the data writes to the trackers. (true or false)
 *
 * @example
 * let device = new HaritoraX("wireless", true, false, false, true);
 **/
export default class HaritoraX extends EventEmitter {
    constructor(
        trackerModel: TrackerModel,
        debugMode: boolean = false,
        printIMUData: boolean = false,
        printRawData: boolean = false,
        printDataWrites: boolean = false
    ) {
        super();

        trackerModelEnabled = trackerModel;
        debug = debugMode;
        printIMU = printIMUData;
        printRaw = printRawData;
        printWrites = printDataWrites;
        main = this;

        log(`Set debug mode: ${debug}`, true);
        log(`Print tracker IMU processing: ${printIMU}`, true);
        log(`Print raw data: ${printRaw}`, true);
    }

    /**
     * Starts the connection to the trackers with the specified mode.
     *
     * @param {string} connectionMode - Connect to the trackers with the specified mode (COM or bluetooth).
     * @param {string[]} portNames - The port names to connect to. (COM only)
     * @param {number} heartbeatInterval - The interval to send the heartbeat signal to the trackers. (COM only)
     *
     * @example
     * device.startConnection("COM");
     **/
    async startConnection(connectionMode: string, portNames?: string[], heartbeatInterval: number = 10000) {
        if (!isConnectionModeSupported(connectionMode))
            error(`${connectionMode} connection not supported for ${trackerModelEnabled}`, true);

        if (connectionMode === "com") {
            error("COM removed for this patch", true)
        } else if (connectionMode === "bluetooth") {
            bluetooth = new BluetoothLinux();

            bluetooth.startConnection();
            bluetoothEnabled = true;

            if (setupBluetoothServices()) {
                canProcessBluetoothData = true;
            } else {
                error("Error setting up Bluetooth services", true);
            }
        }

        if (bluetooth) {
            setTimeout(() => {
                canSendButtonData = true;
            }, 2000);
        }

        listenToDeviceEvents();
    }

    /**
     * Stops the connection to the trackers with the specified mode.
     *
     * @param {string} connectionMode - Disconnect from the trackers with the specified mode (COM or bluetooth).
     *
     * @example
     * device.stopConnection("com");
     **/
    stopConnection(connectionMode: string) {
        let removedDevices: string[] = [];
        if (connectionMode === "com") {
            error("COM removed for this patch", true)
        } else if (connectionMode === "bluetooth" && bluetoothEnabled) {
            canProcessBluetoothData = false;
            removedDevices = removeActiveDevices("bluetooth");

            bluetooth.stopConnection();
            bluetoothEnabled = false;
        }

        removedDevices.forEach((device) => removeDataTimeout(device));

        log(`Stopped ${connectionMode} connection, removed devices: ${removedDevices.join(", ")}`, true);
        canSendButtonData = false;
    }

    /**
     * Sets the tracker settings for a specific tracker.
     * Supported trackers: wireless
     * Supported connections: COM, Bluetooth
     *
     * @param {string} trackerName - The name of the tracker to apply settings to (rightKnee, rightAnkle, hip, chest, leftKnee, leftAnkle, leftElbow, rightElbow).
     * @param {number} sensorMode - The sensor mode, which controls whether magnetometer is used (1 or 2).
     * @param {number} fpsMode - The posture data transfer rate/FPS (50 or 100).
     * @param {string[]} sensorAutoCorrection - The sensor auto correction mode, multiple or none can be used (accel, gyro, mag).
     * @param {boolean} ankleMotionDetection - Whether ankle motion detection is enabled. (true or false)
     * @fires this#settings
     *
     * @example
     * trackers.setTrackerSettings("rightAnkle", 1, 100, ['accel', 'gyro'], true);
     **/
    async setTrackerSettings(
        trackerName: string,
        sensorMode: SensorMode,
        fpsMode: FPSMode,
        sensorAutoCorrection: SensorAutoCorrection[],
        ankleMotionDetection: boolean
    ) {
        const sensorAutoCorrectionBit = sensorAutoCorrection.reduce((acc, curr) => acc | SENSOR_CORRECTION_BITS[curr], 0);
        const settings = {
            "Sensor mode": sensorMode,
            "FPS mode": fpsMode,
            "Sensor auto correction": sensorAutoCorrection,
            "Ankle motion detection": ankleMotionDetection,
        };

        if (trackerName.startsWith("HaritoraXW-") || trackerName.startsWith("HaritoraX2-")) {
            try {
                await writeToBluetooth(trackerName, sensorModeCharacteristic, sensorMode === 1 ? 5 : 8);
                await writeToBluetooth(trackerName, fpsModeCharacteristic, fpsMode === 50 ? 1 : 2);
                await writeToBluetooth(trackerName, correctionCharacteristic, sensorAutoCorrectionBit);
                await writeToBluetooth(trackerName, ankleCharacteristic, ankleMotionDetection ? 1 : 0);
            } catch (err) {
                error(`Error sending tracker settings: ${err}`);
            }
        }

        logSettings(trackerName, settings);
        log(
            `Tracker "${trackerName}" settings applied: ${JSON.stringify([
                sensorMode,
                fpsMode,
                sensorAutoCorrection,
                ankleMotionDetection,
            ])}`,
            true
        );
        trackerSettings.set(trackerName, [sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection]);
        return;
    }

    /**
     * Sets the tracker settings for all connected trackers
     * Supported trackers: wireless, wired
     * Supported connections: COM, Bluetooth
     *
     * @param {number} sensorMode - The sensor mode, which controls whether magnetometer is used (1 or 2).
     * @param {number} fpsMode - The posture data transfer rate/FPS (50 or 100).
     * @param {string[]} sensorAutoCorrection - The sensor auto correction mode, multiple or none can be used (accel, gyro, mag).
     * @param {boolean} ankleMotionDetection - Whether ankle motion detection is enabled. (true or false)
     * @fires this#settings
     *
     * @example
     * trackers.setAllTrackerSettings(2, 50, ['mag'], false);
     **/

    async setAllTrackerSettings(
        sensorMode: SensorMode,
        fpsMode: FPSMode,
        sensorAutoCorrection: SensorAutoCorrection[],
        ankleMotionDetection: boolean
    ) {
        try {
            if (trackerModelEnabled === "wireless") {
                handleWirelessSettings(sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection);
            }
            updateTrackerSettings(sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection);
        } catch (err) {
            error(`Error sending tracker settings: ${err}`);
        }
        return;
    }

    /**
     * Get the active trackers.
     * Supported trackers: wireless, wired
     * Supported connections: COM, Bluetooth
     *
     * @function getActiveTrackers
     * @returns {array} The active trackers.
     **/

    getActiveTrackers(): string[] {
        if (!bluetoothEnabled) return null;
        const bluetoothTrackers = bluetooth.getActiveTrackers();
        return bluetoothTrackers;
    }

    /**
     * Get the tracker's settings.
     * Supported trackers: wireless, wired
     * Supported connections: COM, Bluetooth
     *
     * @function getTrackerSettings
     * @param {string} trackerName - The name of the tracker.
     * @param {boolean} forceBluetoothRead - force reading settings data from BLE device
     * @returns {object} The tracker settings (sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection).
     **/
    async getTrackerSettings(trackerName: string, forceBluetoothRead?: boolean): Promise<object> {
        const logSettings = (name: string, sensorMode: SensorMode, fpsMode: FPSMode, correction: string[], ankle: boolean) => {
            log(`Tracker ${name} settings:`, true);
            log(`Sensor mode: ${sensorMode}`, true);
            log(`FPS mode: ${fpsMode}`, true);
            log(`Sensor auto correction: ${correction}`, true);
            log(`Ankle motion detection: ${ankle}`, true);
        };

        let sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection;

        if (trackerModelEnabled === "wired" && trackerName === "HaritoraXWired") {
            ({ sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection } = getTrackerSettingsFromMap(trackerName));
        } else if (isWirelessBTTracker(trackerName)) {
            if (forceBluetoothRead || !trackerSettings.has(trackerName)) {
                try {
                    const sensorModeValue = await readFromBluetooth(trackerName, sensorModeCharacteristic);
                    const fpsModeValue = await readFromBluetooth(trackerName, fpsModeCharacteristic);
                    const correctionValue = await readFromBluetooth(trackerName, correctionCharacteristic);
                    const ankleValue = await readFromBluetooth(trackerName, ankleCharacteristic);

                    sensorMode = sensorModeValue === 5 ? 1 : 2;
                    fpsMode = fpsModeValue === 1 ? 50 : 100;
                    sensorAutoCorrection = ["accel", "gyro", "mag"].filter((_, i) => correctionValue & (1 << i));
                    ankleMotionDetection = ankleValue === 1;
                } catch (err) {
                    error(`Error reading characteristic: ${err}`);
                }
            }
        } else {
            error(`Cannot get tracker settings for "${trackerName}".`);
            return null;
        }

        logSettings(trackerName, sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection);
        return { sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection };
    }

    /**
     * Get the tracker's buttons.
     * Supported trackers: wireless, wired
     * Supported connections: COM, Bluetooth
     *
     * @function getTrackerButtons
     * @param {string} trackerName - The name of the tracker.
     * @returns {object} The tracker buttons (mainButton, subButton, sub2Button).
     **/
    getTrackerButtons(trackerName: string): Object {
        const buttons = trackerButtons.get(trackerName);
        if (buttons) {
            const [mainButton, subButton, sub2Button] = buttons;
            log(
                `Tracker "${trackerName}" main button: ${mainButton}, sub button: ${subButton}, sub2 button: ${sub2Button}`,
                true
            );
            return { mainButton, subButton, sub2Button };
        }
        log(`Tracker "${trackerName}" buttons not found`);
        return null;
    }

    /**
     * Check whether the connection mode is active or not.
     * Supported trackers: wireless, wired
     * Supported connections: COM, Bluetooth
     *
     * @function getConnectionModeActive
     * @param {string} connectionMode - The connection mode to check.
     * @returns {boolean} Whether the connection mode is active or not.
     **/
    getConnectionModeActive(connectionMode: string): boolean {
        switch (connectionMode) {
            case "bluetooth":
                return bluetoothEnabled;
            default:
                return null;
        }
    }

    getActiveTrackerModel() {
        return trackerModelEnabled;
    }

    /**
     * Fires the "info" event to get the tracker info.
     * Supported trackers: wireless, wired
     * Supported connections: COM, Bluetooth
     *
     * @function fireDeviceInfo
     * @param trackerName - The name of the tracker.
     * @fires this#info
     **/

    async fireDeviceInfo(trackerName: string) {
        let normalizedName = trackerName.replace(/-ext/g, "");

        // Global
        let serial, model, version, comm, comm_next;

        if (isWirelessBTTracker(normalizedName)) {
            const trackerObject = bluetooth.getActiveDevices().find((device) => device[0] === normalizedName);
            if (!trackerObject) {
                error(`Tracker "${normalizedName}" not found`);
                return null;
            }

            const decoder = new TextDecoder("utf-8");

            const readCharacteristic = async (uuid: string) => {
                const buffer = await bluetooth.read(normalizedName, SERVICE_UUID, uuid);
                return buffer ? decoder.decode(buffer) : undefined;
            };

            [version, model, serial] = await Promise.all([
                readCharacteristic(VERSION_UUID),
                readCharacteristic(MODEL_UUID),
                readCharacteristic(SERIAL_UUID),
            ]);
        } else {
            error(`Tracker "${normalizedName}" not found or unsupported model enabled`);
            return null;
        }

        log(`Tracker "${trackerName}" info: ${version}, ${model}, ${serial}, ${comm}, ${comm_next}`, true);
        main.emit("info", trackerName, version, model, serial, comm, comm_next);
        return true;
    }

    /**
     * Fires the "battery" event to get the battery info of the trackers.
     * Supported trackers: wireless, wired
     * Supported connections: COM, Bluetooth
     *
     * @function fireTrackerBattery
     * @fires this#battery
     **/

    async fireTrackerBattery(trackerName: string) {
        let batteryRemaining, batteryVoltage, chargeStatus;

        // Check if battery info is already available
        if (trackerBattery.has(trackerName) && !isWirelessBTTracker(trackerName)) {
            [batteryRemaining, batteryVoltage, chargeStatus] = trackerBattery.get(trackerName);
        } else if (isWirelessBTTracker(trackerName)) {
            // Attempt to read battery info for wireless BT trackers
            log(`Reading battery info for ${trackerName}...`);
            try {
                const batteryLevelBuffer = await bluetooth.read(trackerName, batteryService, batteryLevelCharacteristic);
                if (!batteryLevelBuffer) error(`Tracker "${trackerName}" battery level not found`);
                batteryRemaining = new DataView(batteryLevelBuffer).getUint8(0);

                const batteryVoltageBuffer = await bluetooth.read(trackerName, settingsService, batteryVoltageCharacteristic);
                if (!batteryVoltageBuffer) error(`Tracker "${trackerName}" battery voltage not found`);
                batteryVoltage = new DataView(batteryVoltageBuffer).getInt16(0, true);

                const chargeStatusBuffer = await bluetooth.read(trackerName, settingsService, chargeStatusCharacteristic);
                const chargeStatusHex = Buffer.from(chargeStatusBuffer).toString("hex");
                if (!chargeStatusBuffer) error(`Tracker "${trackerName}" charge status not found`);
                switch (chargeStatusHex) {
                    case "00":
                        chargeStatus = "discharging";
                        break;
                    case "01":
                        chargeStatus = "charging";
                        break;
                    case "02":
                        chargeStatus = "charged";
                        break;
                    default:
                        chargeStatus = "unknown";
                        break;
                }

                trackerBattery.set(trackerName, [batteryRemaining, batteryVoltage, chargeStatus]);
            } catch (err) {
                error(`Error getting battery info for ${trackerName}: ${err}`);
                return null;
            }
        } else {
            error(`Tracker "${trackerName}" battery info not found`);
            return null;
        }

        log(`Tracker "${trackerName}" battery remaining: ${batteryRemaining}%`, true);
        log(`Tracker "${trackerName}" battery voltage: ${batteryVoltage}`, true);
        log(`Tracker "${trackerName}" charge status: ${chargeStatus}`, true);
        main.emit("battery", trackerName, batteryRemaining, batteryVoltage, chargeStatus);
        return true;
    }

    /**
     * Fires the "mag" event to get the magnetometer status of the trackers.
     * Supported trackers: wireless, wired
     * Supported connections: COM, Bluetooth
     *
     * @function fireTrackerMag
     * @param {string} trackerName - The name of the tracker.
     * @fires this#mag
     */
    async fireTrackerMag(trackerName: string) {
        let normalizedName = trackerName.replace(/-ext/g, "");
        if (trackerMag.has(normalizedName)) {
            let magStatus = trackerMag.get(normalizedName);
            log(`Tracker "${normalizedName}" magnetometer status: ${magStatus}`, true);
            main.emit("mag", normalizedName, magStatus);
        } else {
            // Read from BLE device
            if (!trackerName.startsWith("HaritoraXW") || !trackerName.startsWith("HaritoraX2-")) {
                error(`Tracker "${trackerName}" magnetometer status not found`);
                return;
            }

            try {
                const magStatusBuffer = await bluetooth.read(trackerName, trackerService, magnetometerCharacteristic);
                if (!magStatusBuffer) error(`Tracker "${trackerName}" magnetometer status not found`);
                const magData = Buffer.from(magStatusBuffer).readUInt8(0);
                const magStatus = getMagStatus(magData);
                trackerMag.set(trackerName, magStatus);
                log(`Tracker "${trackerName}" magnetometer status: ${magStatus}`, true);
                main.emit("mag", trackerName, magStatus);
            } catch (err) {
                error(`Error reading mag status: ${err}`);
                return;
            }
        }
    }

    /**
     * Returns the Bluetooth instance so you can use its methods with the instance this class is using.
     * @function getBluetoothInstance
     * @returns {Bluetooth} The Bluetooth instance.
     */
    getBluetoothInstance() {
        return bluetooth;
    }
}

const removeDataTimeout = (trackerName: string) => {
    if (dataTimeouts.has(trackerName)) {
        clearTimeout(dataTimeouts.get(trackerName));
        dataTimeouts.delete(trackerName);
    }
};

const dataTimeouts: Map<string, NodeJS.Timeout> = new Map();
function listenToDeviceEvents() {
    const resetDataTimeout = (trackerName: string, connection: BluetoothLinux) => {
        if (!trackerName || trackerName === "DONGLE") return;
        if (dataTimeouts.has(trackerName)) {
            clearTimeout(dataTimeouts.get(trackerName));
        }
        const timeout = setTimeout(() => {
            log(`No data received within 10 seconds for ${trackerName}, emitting disconnect event.`);
            connection.emit("disconnect", trackerName);
            dataTimeouts.delete(trackerName);
            activeDevices.find((device) => device[0] === trackerName) &&
                activeDevices.splice(
                    activeDevices.findIndex((device) => device[0] === trackerName),
                    1
                );
        }, 10000);
        dataTimeouts.set(trackerName, timeout);
    };

    /*
     * BLE events
     */

    if (bluetooth) {
        bluetooth.on("data", (localName: string, service: string, characteristic: string, data: string) => {
            if (!canProcessBluetoothData || service === "Device Information") return;

            resetDataTimeout(localName, bluetooth);
            const buffer = Buffer.from(data, "base64");

            switch (characteristic) {
                case "Sensor":
                    const dataLength = buffer.toString("base64").length;

                    if (dataLength >= 40) {
                        // HaritoraX 2 legs data
                        const trackerNameThigh = `${localName}-ext`;

                        // emit bluetooth's "connect" event
                        if (!activeDevices.includes(trackerNameThigh)) {
                            bluetooth.emit("connect", trackerNameThigh);
                        }

                        const legData = buffer.slice(0, 14);
                        let thighData;

                        if (dataLength === 40) {
                            thighData = buffer.slice(14, 29);
                        } else if (dataLength === 44) {
                            thighData = buffer.slice(18, 32);
                            // const extraBytes = buffer.slice(16, 18);
                            // log(`Extra bytes: ${extraBytes.toString("base64")}`);
                        }

                        // console.log(`Processing HaritoraX2 legs data for ${localName}`);
                        // console.log(`IMU data (leg): ${legData.toString("base64")}`);
                        // console.log(`IMU data (thigh): ${thighData.toString("base64")}`);

                        // Process leg tracker data
                        processIMUData(legData, localName);

                        // Process thigh tracker data
                        processIMUData(thighData, trackerNameThigh);
                    } else {
                        // Regular HaritoraX 2 / Wireless data
                        processIMUData(buffer, localName);
                    }
                    break;
                case "MainButton":
                case "SecondaryButton":
                    processButtonData(data, localName, characteristic);
                    break;
                case "BatteryLevel":
                case "BatteryVoltage":
                case "ChargeStatus":
                    processBatteryData(data, localName, characteristic);
                    break;
                case "SensorModeSetting":
                case "FpsSetting":
                case "AutoCalibrationSetting":
                case "TofSetting":
                    processSettingsData(data, localName, characteristic);
                    break;
                case "Magnetometer":
                    processMagData(data, localName);
                    break;
                default:
                    log(`Unknown data from ${localName}: ${data} - ${characteristic} - ${service}`);
                    log(`Data in utf-8: ${buffer.toString("utf-8")}`);
                    log(`Data in hex: ${buffer.toString("hex")}`);
                    log(`Data in base64: ${buffer.toString("base64")}`);
            }
        });

        bluetooth.on("connect", (trackerName) => {
            if (trackerName && !activeDevices.includes(trackerName)) {
                activeDevices.push(trackerName);
                main.emit("connect", trackerName, "bluetooth");
            }
        });

        bluetooth.on("disconnect", (trackerName) => {
            main.emit("disconnect", trackerName);
            removeDataTimeout(trackerName);

            // Check for "-ext" tracker and disconnect it as well
            const extensionTrackerName = `${trackerName}-ext`;
            if (activeDevices.includes(extensionTrackerName)) {
                main.emit("disconnect", extensionTrackerName);
                removeDataTimeout(extensionTrackerName);
            }
        });

        bluetooth.on("log", (message: string) => {
            log(message);
        });

        bluetooth.on("logError", ({ message, exceptional }) => {
            error(message, exceptional);
        });

        bluetooth.on("dataRaw", (localName, service, characteristic, data) => {
            if (!printRaw) return;
            log(
                `${localName} - Raw data: - ${data} - ${data.toString("hex")} -  ${data.toString(
                    "base64"
                )} - ${characteristic} - ${service}`,
                true
            );
        });
    }
}

const wiredTrackerAssignments: Map<[number, boolean], string> = new Map([
    // [trackerCount, ankleEnabled], identifier
    [[5, false], "x"],
    [[5, true], "x"],
    [[6, false], "p"],
    [[6, true], "r"],
    [[7, false], "e"],
    [[7, true], "h"],
    [[8, false], "g"],
    [[8, true], "h"],
]);

function processWiredData(identifier: string, data: string) {
    // Default 5 (base) trackers
    let trackerNames = ["chest", "leftKnee", "leftAnkle", "rightKnee", "rightAnkle"];
    const buffer = Buffer.from(data, "base64");

    let ankleEnabled = false;

    for (let [key, value] of wiredTrackerAssignments) {
        if (value === identifier) {
            [, ankleEnabled] = key;
            break;
        }
    }

    let trackerArray = trackerSettings.get("HaritoraXWired");
    if (trackerArray && trackerArray.length > 0 && trackerArray[trackerArray.length - 1] !== ankleEnabled) {
        trackerArray[trackerArray.length - 1] = ankleEnabled;
        trackerSettings.set("HaritoraXWired", trackerArray);
    }

    const dataLength = data.split("A").length - 1;

    switch (identifier) {
        case "p":
        case "r":
            trackerNames.push("hip");
            break;
        case "e":
        case "h":
            if (dataLength >= 18) trackerNames.push("leftElbow", "rightElbow");
            break;
        case "g":
        case "h":
            if (dataLength < 18) trackerNames.push("hip", "leftElbow", "rightElbow");
            break;
    }

    const ankleBuffer = buffer.slice(buffer.length - 4);

    trackerNames.forEach((trackerName, index) => {
        const start = index * 14; // 14 bytes per tracker
        const trackerBuffer = buffer.slice(start, start + 14);

        let ankleValue = undefined;
        if (ankleEnabled) {
            if (trackerName === "leftAnkle") {
                ankleValue = ankleBuffer.readInt8(0);
            } else if (trackerName === "rightAnkle") {
                ankleValue = ankleBuffer.readInt8(2);
            }
        }
        processIMUData(trackerBuffer, trackerName, ankleValue);
    });
}

/**
 * Processes the IMU data received from the tracker by the dongle.
 * The data contains the information about the rotation, gravity, and ankle motion (if enabled) of the tracker.
 * Supported trackers: wireless, wired
 * Supported connections: COM, Bluetooth
 *
 * @function processIMUData
 *
 * @param {string} data - The data to process.
 * @param {string} trackerName - The name of the tracker.
 * @param {number} [ankleValue] - The ankle value (processed before running, for wired).
 * @fires haritora#imu
 * @fires haritora#connect
 * @fires haritora#mag
 **/
function processIMUData(data: Buffer, trackerName: string, ankleValue?: number) {
    if (!trackerName || !data) return;

    // console.log(`Processing for tracker: ${trackerName}`)

    // If tracker isn't in activeDevices, add it and emit "connect" event
    if (!activeDevices.includes(trackerName) && (bluetoothEnabled)) {
        let isExtension = false;
        log(`Tracker "${trackerName}" isn't in active devices, adding and emitting connect event`, true);
        const isWireless = trackerName.startsWith("HaritoraXW") || trackerName.startsWith("HaritoraX2-");

        if (trackerName.endsWith("-ext")) {
            trackerName = trackerName.slice(0, -4);
            isExtension = true;
        }
        
        const mode = isWireless ? "bluetooth" : "com";

        const finalName = isExtension ? `${trackerName}-ext` : trackerName;
        activeDevices.push(finalName);
        main.emit("connect", finalName, mode);
    }

    // Decode and log the data
    try {
        const { rotation, acceleration, ankle, magStatus } = decodeIMUPacket(data, trackerName);

        if (printIMU) {
            const { x: rX, y: rY, z: rZ, w: rW } = rotation;
            const { x: aX, y: aY, z: aZ } = acceleration;
            log(`Tracker "${trackerName}" rotation: (${rX.toFixed(5)}, ${rY.toFixed(5)}, ${rZ.toFixed(5)}, ${rW.toFixed(5)} )`);
            log(`Tracker "${trackerName}" acceleration: (${aX.toFixed(5)}, ${aY.toFixed(5)}, ${aZ.toFixed(5)})`);
            if (ankle) log(`Tracker "${trackerName}" ankle: ${ankle}`);
            if (ankleValue) log(`Tracker "${trackerName}" (wired/manual) ankle: ${ankleValue}`);
            if (magStatus) log(`Tracker "${trackerName}" magnetometer status: ${magStatus}`);
        }

        main.emit("imu", trackerName, rotation, acceleration, ankle ?? ankleValue);
        if (!trackerName.startsWith("HaritoraXW") && !trackerName.startsWith("HaritoraX2-"))
            main.emit("mag", trackerName, magStatus);
    } catch (err) {
        error(`Error decoding tracker "${trackerName}" IMU packet data: ${err}`, false);
    }
}

/**
 * The logic to decode the IMU packet received by the dongle.
 * Thanks to sim1222 and BracketProto's project for helping with the math and acceleration/gravity code respectively :p
 * @see {@link https://github.com/sim1222/haritorax-slimevr-bridge/}
 * @see {@link https://github.com/OCSYT/SlimeTora/}
 **/

const ROTATION_SCALAR = 0.01 / 180.0;
const GRAVITY_SCALAR = 1 / 256.0;
const GRAVITY_CONSTANT = 9.81;
const GRAVITY_ADJUSTMENT = 1.2;

function decodeIMUPacket(data: Buffer, trackerName: string) {
    if (!trackerName || data.length < 14) {
        error(`Invalid data for IMU packet: ${!trackerName ? "no tracker name" : `insufficient data length (${data.length})`}`, false);
        return null;
    }

    try {
        const rotationX = data.readInt16LE(0) * ROTATION_SCALAR;
        const rotationY = data.readInt16LE(2) * ROTATION_SCALAR;
        const rotationZ = data.readInt16LE(4) * -ROTATION_SCALAR;
        const rotationW = data.readInt16LE(6) * -ROTATION_SCALAR;

        const gravityRawX = data.readInt16LE(8) * GRAVITY_SCALAR;
        const gravityRawY = data.readInt16LE(10) * GRAVITY_SCALAR;
        const gravityRawZ = data.readInt16LE(12) * GRAVITY_SCALAR;

        let ankle, magStatus;

        // TODO: check imu data for hx2, then compare to wireless
        // either: move mag (and ankle) data to specified place in line 1274 OR simply add HX2 as a different support option in haritorax-interpreter

        if (trackerModelEnabled === "wireless") {
            const bufferData = data.toString("base64");
            ankle = bufferData.slice(-2) !== "==" ? data.readUint16LE(data.length - 2) : undefined;

            if (!trackerName.startsWith("HaritoraXW") && !trackerName.startsWith("HaritoraX2-")) {
                const magnetometerData = bufferData.charAt(bufferData.length - 5);
                magStatus =
                    {
                        A: MagStatus.VERY_BAD,
                        B: MagStatus.BAD,
                        C: MagStatus.OKAY,
                        D: MagStatus.GREAT,
                    }[magnetometerData] || MagStatus.Unknown;
                trackerMag.set(trackerName, magStatus);
            }
        }

        const rotation = { x: rotationX, y: rotationY, z: rotationZ, w: rotationW };

        const rc = [rotation.w, rotation.x, rotation.y, rotation.z];
        const r = [rc[0], -rc[1], -rc[2], -rc[3]];
        const p = [0.0, 0.0, 0.0, GRAVITY_CONSTANT];

        const hrp = [
            r[0] * p[0] - r[1] * p[1] - r[2] * p[2] - r[3] * p[3],
            r[0] * p[1] + r[1] * p[0] + r[2] * p[3] - r[3] * p[2],
            r[0] * p[2] - r[1] * p[3] + r[2] * p[0] + r[3] * p[1],
            r[0] * p[3] + r[1] * p[2] - r[2] * p[1] + r[3] * p[0],
        ];

        const hFinal = [
            hrp[0] * rc[0] - hrp[1] * rc[1] - hrp[2] * rc[2] - hrp[3] * rc[3],
            hrp[0] * rc[1] + hrp[1] * rc[0] + hrp[2] * rc[3] - hrp[3] * rc[2],
            hrp[0] * rc[2] - hrp[1] * rc[3] + hrp[2] * rc[0] + hrp[3] * rc[1],
            hrp[0] * rc[3] + hrp[1] * rc[2] - hrp[2] * rc[1] + hrp[3] * rc[0],
        ];

        const acceleration = {
            x: gravityRawX - hFinal[1] * -GRAVITY_ADJUSTMENT,
            y: gravityRawY - hFinal[2] * -GRAVITY_ADJUSTMENT,
            z: gravityRawZ - hFinal[3] * GRAVITY_ADJUSTMENT,
        };

        return { rotation, acceleration, ankle, magStatus };
    } catch (err) {
        error(`Error decoding IMU packet: ${err}`, false);
        return null;
    }
}

/**
 * Processes other tracker data received from the tracker by the dongle.
 * Read function comments for more information.
 * Supported trackers: wireless
 * Supported connections: COM
 *
 * @function processTrackerData
 * @param {string} data - The data to process.
 * @param {string} trackerName - The name of the tracker.
 * @fires haritora#tracker
 **/

function processTrackerData(data: string, trackerName: string) {
    /*
     * Currently unsure what other data a0/a1 could represent other than trying to find the trackers, I see other values for it too reporting every second.
     * This could also be used to report calibration data when running the calibration through the software, or a "heartbeat" packet.
     *
     * This is most likely related to signal info about the dongle, such as signal strength/RSSI.
     */

    if (!data || !trackerName) return;

    if (data === "7f7f7f7f7f7f") {
        if (!activeDevices.includes(trackerName)) return;
        activeDevices.splice(activeDevices.indexOf(trackerName), 1);
        removeDataTimeout(trackerName);
        main.emit("disconnect", trackerName);
        log(`Searching for tracker ${trackerName}...`);
    }

    // TODO: find out what "other data" represents, then add to emitted event.
    main.emit("tracker", trackerName, data);
}

/**
 * Processes the magnetometer data received from the Bluetooth tracker.
 * GX(6/2) mag status for wireless is processed by decodeIMUPacket()
 * Supported trackers: wireless, wired
 * Supported connections: COM, Bluetooth
 *
 * @function processMagData
 * @param {string} data - The data to process.
 * @param {string} trackerName - The name of the tracker.
 * @fires haritora#mag
 **/

function processMagData(data: string, trackerName: string) {
    if (!data) return null;

    let magStatus: string;
    let magData;

    if (trackerModelEnabled === "wireless") {
        try {
            const buffer = Buffer.from(data, "base64");
            magData = buffer.readUInt8(0);

            if (magData === null) return null;

            magStatus = getMagStatus(magData);
            log(`Tracker "${trackerName}" mag status: ${magStatus}`);
            trackerMag.set(trackerName, magStatus);
            main.emit("mag", trackerName, magStatus);
            return magStatus;
        } catch (err) {
            error(`Error processing mag data for ${trackerName}: ${err}`);
            return null;
        }
    } else if (trackerModelEnabled === "wired") {
        try {
            let trackerNames = ["chest", "leftKnee", "leftAnkle", "rightKnee", "rightAnkle", "hip", "leftElbow", "rightElbow"];
            const jsonData = JSON.parse(data);
            const magStatusData = jsonData.magf_status;
            trackerNames.forEach((tracker) => {
                let trackerIndex = trackerNames.indexOf(tracker);
                if (trackerIndex === -1 || Number.isNaN(trackerIndex)) return;

                let magData = parseInt(magStatusData[trackerIndex]);
                if (magData === undefined || Number.isNaN(magData)) return;

                let magStatus = getMagStatus(magData);
                log(`Tracker ${tracker} mag status: ${magStatus}`);
                trackerMag.set(tracker, magStatus);
                main.emit("mag", tracker, magStatus);
            });
        } catch (err) {
            error(`Error processing mag data: ${err}`);
            return null;
        }
    }
}

function getMagStatus(magData: number) {
    switch (magData) {
        case GREAT:
            return MagStatus.GREAT;
        case OKAY:
            return MagStatus.OKAY;
        case BAD:
            return MagStatus.BAD;
        case VERY_BAD:
            return MagStatus.VERY_BAD;
        default:
            return MagStatus.Unknown;
    }
}

/**
 * Processes the settings data received from the trackers.
 * Supported trackers: wireless, wired
 * Supported connections: COM
 *
 * @function processSettingsData
 * @param {string} data - The data to process.
 * @param {string} trackerName - The name of the tracker.
 * @fires haritora#settings
 **/

function processSettingsData(data: string, trackerName: string, characteristic?: string) {
    // example: s:{"imu_mode":1, "imu_num":6, "magf_status":"020200", "speed_mode":2, "dcal_flags":"04", "detected":"04004C6C"}
    if (!trackerName || !data) return;

    try {
        if (
            trackerModelEnabled === "wireless" &&
            !trackerName.startsWith("HaritoraXW") &&
            !trackerName.startsWith("HaritoraX2-")
        ) {
            const sensorMode = parseInt(data[6]);
            const fpsMode = parseInt(data[5]);
            const sensorAutoCorrection = parseInt(data[10]);
            const ankleMotionDetection = parseInt(data[13]);

            const sensorModeText = sensorMode === 0 ? 2 : 1;
            const fpsModeText = fpsMode === 0 ? 50 : 100;
            const ankleMotionDetectionText = ankleMotionDetection !== 0;
            const sensorAutoCorrectionComponents = ["accel", "gyro", "mag"].filter((_, i) => sensorAutoCorrection & (1 << i));

            const settings = {
                "Sensor mode": sensorModeText,
                "FPS mode": fpsModeText,
                "Sensor auto correction": sensorAutoCorrectionComponents,
                "Ankle motion detection": ankleMotionDetectionText,
            };

            logSettings(trackerName, settings, data);

            trackerSettings.set(trackerName, [
                sensorModeText,
                fpsModeText,
                sensorAutoCorrectionComponents,
                ankleMotionDetectionText,
            ]);
            main.emit(
                "settings",
                trackerName,
                sensorModeText,
                fpsModeText,
                sensorAutoCorrectionComponents,
                ankleMotionDetectionText
            );
        } else if (isWirelessBTTracker(trackerName) && characteristic) {
            switch (characteristic) {
                case "SensorModeSetting":
                    const sensorMode = parseBluetoothData(data);
                    const sensorModeText = sensorMode === 1 ? 5 : 8;
                    main.emit("settings", trackerName, sensorModeText);
                    break;
                case "FpsSetting":
                    const fpsMode = parseBluetoothData(data);
                    const fpsModeText = fpsMode === 50 ? 1 : 2;
                    main.emit("settings", trackerName, undefined, fpsModeText);
                    break;
                case "AutoCalibrationSetting":
                    const sensorAutoCorrection = parseBluetoothData(data);
                    const sensorAutoCorrectionComponents = ["accel", "gyro", "mag"].filter(
                        (_, i) => sensorAutoCorrection & (1 << i)
                    );
                    main.emit("settings", trackerName, undefined, undefined, sensorAutoCorrectionComponents);
                    break;
                case "TofSetting":
                    const ankleMotionDetection = parseBluetoothData(data);
                    const ankleMotionDetectionText = ankleMotionDetection !== 0;
                    main.emit("settings", trackerName, undefined, undefined, undefined, ankleMotionDetectionText);
                    break;
                default:
                    log(`Unknown settings data from ${trackerName}: ${data}`);
            }
        }
    } catch (err) {
        error(`Error processing tracker settings for ${trackerName}: ${err}`);
    }
}

/**
 * Processes the info data received from the trackers.
 * Supported trackers: wired
 * Supported connections: COM
 *
 * @function processInfoData
 * @param {string} data - The data to process.
 * @param {string} trackerName - The name of the tracker.
 * @fires haritora#info
 **/

function processInfoData(data: string, trackerName: string) {
    // example: {"model":"MC2B", "version":"1.7.10", "serial no":"0000000", "comm":"BLT", "comm_next":"BTSPP"}
    try {
        const { version, model, "serial no": serial, comm, comm_next } = JSON.parse(data);
        main.emit("info", trackerName, version, model, serial, comm, comm_next);
        deviceInformation.set(trackerName, [version, model, serial, comm, comm_next]);
    } catch (err) {
        log(`Error processing info data for tracker ${trackerName}: ${err}`);
    }
}

/**
 * Processes the button data received from the tracker by the dongle.
 * The data contains the information about the main and sub buttons on the tracker along with which one was pressed/updated.
 * Supported trackers: wireless, wired
 * Supported connections: COM, Bluetooth
 *
 * @function processButtonData
 * @param {string} data - The data to process.
 * @param {string} trackerName - The name of the tracker.
 * @param {string} characteristic - The characteristic of the data, if trackers connected via BLE. (MainButton, SecondaryButton)
 * @fires haritora#button
 **/

function processButtonData(data: string, trackerName: string, characteristic?: string) {
    if (!canSendButtonData || !trackerName || trackerName === "DONGLE") return;

    try {
        const currentButtons = trackerButtons.get(trackerName) || [0, 0, 0];
        let result: { buttonPressed: string; isOn: boolean } = { buttonPressed: undefined, isOn: true };

        if (trackerName.startsWith("HaritoraXW") || trackerName.startsWith("HaritoraX2-")) {
            result.buttonPressed = processWirelessBTTrackerData(characteristic, currentButtons);
        }
        if (result.buttonPressed) {
            log(`Button ${result.buttonPressed} pressed on tracker ${trackerName}. Current state: ${currentButtons}`);
        }

        trackerButtons.set(trackerName, currentButtons);
        main.emit("button", trackerName, result.buttonPressed, result.isOn, ...currentButtons);
    } catch (err) {
        error(`Error processing button data for ${trackerName}: ${err}`);
    }
}

function processWirelessTrackerData(data: string, trackerName: string, currentButtons: number[]) {
    let newMainButtonState = parseInt(data[6], 16);
    let newSubButtonState = parseInt(data[9], 16);
    let buttonPressed = undefined;
    let isOn = undefined;

    if (currentButtons[MAIN_BUTTON_INDEX] !== newMainButtonState) {
        currentButtons[MAIN_BUTTON_INDEX] = newMainButtonState;
        if (newMainButtonState !== 0) {
            buttonPressed = "main";
        }
    }

    if (currentButtons[SUB_BUTTON_INDEX] !== newSubButtonState) {
        currentButtons[SUB_BUTTON_INDEX] = newSubButtonState;
        if (newSubButtonState !== 0) {
            buttonPressed = "sub";
        }
    }

    if (data[0] === "0" || data[7] === "f" || data[8] === "f" || data[10] === "f" || data[11] === "f") {
        log(`Tracker "${trackerName}" is off/turning off...`);
        log(`Raw data: ${data}`);
        isOn = false;
    } else {
        log(`Tracker "${trackerName}" is on/turning on...`);
        log(`Raw data: ${data}`);
        isOn = true;
    }

    return { buttonPressed, isOn };
}

function processWirelessBTTrackerData(characteristic: string, currentButtons: number[]): string | undefined {
    switch (characteristic) {
        case "MainButton":
            currentButtons[0]++;
            return "main";
        case "SecondaryButton":
            currentButtons[1]++;
            return "sub";
        case "TertiaryButton":
            currentButtons[2]++;
            return "sub2";
        default:
            return undefined;
    }
}

function processWiredTrackerData(data: string, trackerName: string, currentButtons: number[]) {
    // example data: t:{"id":"button2", "type":"click", "start_time":6937744, "option":""}
    // TODO: do more testing with wired trackers, find different "type"(s) and what "start_time" and "option" mean
    const buttonData = JSON.parse(data);
    if (trackerName === "HaritoraXWired") {
        let pressed = undefined;
        if (buttonData.id === "button1") {
            currentButtons[MAIN_BUTTON_INDEX] += 1;
            pressed = "main";
        } else if (buttonData.id === "button2") {
            currentButtons[SUB_BUTTON_INDEX] += 1;
            pressed = "sub";
        } else if (buttonData.id === "button3") {
            currentButtons[SUB2_BUTTON_INDEX] += 1;
            pressed = "sub2";
        }

        return { buttonPressed: pressed, isOn: true };
    }

    return undefined;
}

/**
 * Processes the battery data received from the tracker by the dongle.
 * It contains the information about the battery percentage, voltage, and charge status of the tracker.
 * Supported trackers: wireless, wired
 * Supported connections: COM, Bluetooth
 *
 * @function processBatteryData
 * @param {string} data - The data to process.
 * @param {string} trackerName - The name of the tracker.
 * @fires haritora#battery
 **/

const CHARGE_STATUS_MAP = new Map([
    ["00", "discharging"],
    ["01", "charging"],
    ["02", "charged"],
]);

function processBatteryData(data: string, trackerName: string, characteristic?: string) {
    if (!trackerName || !data) return;

    const batteryData: [number | undefined, number | undefined, string | undefined] = [undefined, undefined, undefined];

    try {
        if (isWirelessBTTracker(trackerName) && characteristic) {
            const buffer = Buffer.from(data, "base64");
            switch (characteristic) {
                case "BatteryLevel":
                    updateAndEmitBatteryInfo(trackerName, characteristic, parseInt(buffer.toString("hex"), 16));
                    break;
                case "BatteryVoltage":
                    updateAndEmitBatteryInfo(trackerName, characteristic, buffer.readInt16LE(0));
                    break;
                case "ChargeStatus":
                    const hex = buffer.toString("hex");
                    updateAndEmitBatteryInfo(trackerName, characteristic, CHARGE_STATUS_MAP.get(hex) || "unknown");
                    break;
            }
        }

        trackerBattery.set(trackerName, batteryData);
        main.emit("battery", trackerName, ...batteryData);
    } catch (err) {
        error(`Error processing battery data for ${trackerName}: ${err}`);
        if (debug) log(`Raw battery data: ${data}`);
    }
}

let batteryInfo: any = {};
function updateAndEmitBatteryInfo(trackerName: string, characteristic: string, value: string | number) {
    if (!batteryInfo[trackerName]) {
        batteryInfo[trackerName] = {
            BatteryLevel: null,
            BatteryVoltage: null,
            ChargeStatus: null,
        };
    }

    batteryInfo[trackerName][characteristic] = value;

    const info = batteryInfo[trackerName];
    if (info.BatteryLevel !== null && info.BatteryVoltage !== null && info.ChargeStatus !== null) {
        main.emit("battery", trackerName, info.BatteryLevel, info.BatteryVoltage, info.ChargeStatus);

        batteryInfo[trackerName] = {
            BatteryLevel: null,
            BatteryVoltage: null,
            // ChargeStatus is not reset because it's not a value that will really change often (if at all)
        };
    }
}

/*
 * Helper functions
 */

function log(message: string, bypass = false) {
    if (!debug && !bypass) return;

    console.log(message);
    main.emit("log", message);
}

function error(message: string, exceptional = false) {
    if (!debug && !exceptional) return;

    main.emit("error", message, exceptional);
    exceptional
        ? console.error(message)
        : (() => {
              throw new Error(message);
          })();
}

function isWirelessBTTracker(trackerName: string) {
    return (
        trackerModelEnabled === "wireless" &&
        bluetoothEnabled &&
        (trackerName.startsWith("HaritoraXW") || trackerName.startsWith("HaritoraX2-"))
    );
}

function getSettingsHexValue(
    sensorMode: SensorMode,
    fpsMode: FPSMode,
    sensorAutoCorrection: SensorAutoCorrection[],
    ankleMotionDetection: boolean
): string {
    const sensorModeBit = sensorMode === 1 ? SENSOR_MODE_1 : SENSOR_MODE_2;
    const postureDataRateBit = fpsMode === 100 ? FPS_MODE_100 : FPS_MODE_50;
    const ankleMotionDetectionBit = ankleMotionDetection ? 1 : 0;
    let sensorAutoCorrectionBit = 0;
    if (sensorAutoCorrection.includes("accel")) sensorAutoCorrectionBit |= 0x01;
    if (sensorAutoCorrection.includes("gyro")) sensorAutoCorrectionBit |= 0x02;
    if (sensorAutoCorrection.includes("mag")) sensorAutoCorrectionBit |= 0x04;

    return `00000${postureDataRateBit}${sensorModeBit}010${sensorAutoCorrectionBit}00${ankleMotionDetectionBit}`;
}

async function writeToBluetooth(trackerName: string, characteristic: string, value: number) {
    try {
        const buffer = Buffer.from([value]);
        await bluetooth.write(trackerName, settingsService, characteristic, buffer);
        if (printWrites) log(`Data written to characteristic ${characteristic} ${trackerName}: ${value}`);
    } catch (err) {
        error(`Error writing to Bluetooth tracker ${trackerName}: ${err}`);
    }
}

async function readFromBluetooth(trackerName: string, characteristic: string) {
    const data = await bluetooth.read(trackerName, settingsService, characteristic);
    return parseBluetoothData(data);
}

function parseBluetoothData(data: ArrayBufferLike | string) {
    if (typeof data === "string") {
        data = Buffer.from(data, "base64");
    }
    if (data instanceof Buffer) {
        data = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }
    return new DataView(data as ArrayBufferLike).getInt8(0);
}

function logSettings(trackerName: string, settings: Object, rawHexData?: string) {
    if (trackerName === "DONGLE") return;
    log(`Tracker "${trackerName}" settings:`);
    Object.entries(settings).forEach(([key, value]) => log(`${key}: ${value}`));
    if (rawHexData) log(`Raw hex data: ${rawHexData}`);
}

/*
 * startConnection() function helpers
 */

function isConnectionModeSupported(connectionMode: string): boolean {
    return connectionMode === "com" || (connectionMode === "bluetooth" && trackerModelEnabled === "wireless");
}

function setupBluetoothServices(): boolean {
    trackerService = bluetooth.getServiceUUID("Tracker Service");
    settingsService = bluetooth.getServiceUUID("Setting Service");
    batteryService = bluetooth.getServiceUUID("Battery Service");

    magnetometerCharacteristic = bluetooth.getCharacteristicUUID("Magnetometer");
    batteryLevelCharacteristic = bluetooth.getCharacteristicUUID("BatteryLevel");
    batteryVoltageCharacteristic = bluetooth.getCharacteristicUUID("BatteryVoltage");
    chargeStatusCharacteristic = bluetooth.getCharacteristicUUID("ChargeStatus");
    sensorModeCharacteristic = bluetooth.getCharacteristicUUID("SensorModeSetting");
    fpsModeCharacteristic = bluetooth.getCharacteristicUUID("FpsSetting");
    correctionCharacteristic = bluetooth.getCharacteristicUUID("AutoCalibrationSetting");
    ankleCharacteristic = bluetooth.getCharacteristicUUID("TofSetting");

    return (
        !!trackerService &&
        !!settingsService &&
        !!batteryService &&
        !!magnetometerCharacteristic &&
        !!batteryLevelCharacteristic &&
        !!sensorModeCharacteristic &&
        !!fpsModeCharacteristic &&
        !!correctionCharacteristic &&
        !!ankleCharacteristic
    );
}

/*
 * stopConnection() function helpers
 */

function removeActiveDevices(deviceTypeToRemove: string) {
    let devices = bluetooth.getActiveTrackers();
    let removedDevices: string[] = [];

    for (let device of devices) {
        let deviceName = device.toString();
        let index = activeDevices.indexOf(deviceName);
        if (index !== -1) {
            activeDevices.splice(index, 1);
            removedDevices.push(deviceName);
        }
    }

    return removedDevices;
}

/*
 * getTrackerSettings() function helpers
 */

function getTrackerSettingsFromMap(trackerName: string) {
    const settings = trackerSettings.get(trackerName);
    if (settings) {
        const settingsToLog = {
            "Sensor mode": settings[0],
            "FPS mode": settings[1],
            "Sensor auto correction": settings[2],
            "Ankle motion detection": settings[3],
        };
        logSettings(trackerName, settingsToLog);

        return {
            sensorMode: settings[0],
            fpsMode: settings[1],
            sensorAutoCorrection: settings[2],
            ankleMotionDetection: settings[3],
        };
    } else {
        error(`Tracker "${trackerName}" settings not found in trackerSettings map.`);
        return;
    }
}

async function handleWirelessSettings(
    sensorMode: SensorMode,
    fpsMode: FPSMode,
    sensorAutoCorrection: SensorAutoCorrection[],
    ankleMotionDetection: boolean
) {
    if (bluetoothEnabled) {
        bluetooth.getActiveTrackers().forEach((trackerName) => {
            main.setTrackerSettings(trackerName, sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection);
        });
    }
}

function updateTrackerSettings(
    sensorMode: SensorMode,
    fpsMode: FPSMode,
    sensorAutoCorrection: SensorAutoCorrection[],
    ankleMotionDetection: boolean
) {
    for (let trackerName of trackerSettings.keys()) {
        trackerSettings.set(trackerName, [sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection]);
    }
}

export { HaritoraX };
