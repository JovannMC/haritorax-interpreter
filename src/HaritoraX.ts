"use strict";

import { Buffer } from "buffer";
import { EventEmitter } from "events";
import { COM } from "./mode/com.js";
import Bluetooth from "./mode/bluetooth.js";
import { TrackerModel, SensorMode, FPSMode, SensorAutoCorrection, MagStatus } from "./types.js";

let debug = false;
let printIMU = false;
let printRaw = false;

let com: COM;
let bluetooth: Bluetooth;
let comEnabled = false;
let bluetoothEnabled = false;
let main: HaritoraX;
let canSendButtonData = false;
let canProcessComData = false;
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

// COM
const VERSION_INDEX = 0;
const MODEL_INDEX = 1;
const SERIAL_INDEX = 2;
const COMM_INDEX = 3; // wired only
const COMM_NEXT_INDEX = 4; // wired only

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

// For HaritoraX Wired
const deviceInformation: Map<string, string[]> = new Map([
    // example: {"model":"MC2B", "version":"1.7.10", "serial no":"0000000", "comm":"BLT", "comm_next":"BTSPP"}
    // deviceName, [version, model, serial, comm, comm_next]
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
 * @property {object} gravity - The gravity data of the tracker.
 * @property {number} gravity.x - The x component of the gravity.
 * @property {number} gravity.y - The y component of the gravity.
 * @property {number} gravity.z - The z component of the gravity.
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
 * The SensorAutoCorrection.Magnetometer event which provides the tracker's magnetometer status
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
 *
 * @example
 * let device = new HaritoraXWireless(2);
 **/
export default class HaritoraX extends EventEmitter {
    constructor(
        trackerModel: TrackerModel,
        debugMode: boolean = false,
        printIMUData: boolean = false,
        printRawData: boolean = false
    ) {
        super();

        trackerModelEnabled = trackerModel;
        debug = debugMode;
        printIMU = printIMUData;
        printRaw = printRawData;
        main = this;

        log(`Set debug mode: ${debug}`);
        log(`Print tracker IMU processing: ${printIMU}`);
        log(`Print raw data: ${printRaw}`);
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
            com = new COM(trackerModelEnabled, heartbeatInterval);
            comEnabled = true;

            com.startConnection(portNames);
            canProcessComData = true;
        } else if (connectionMode === "bluetooth") {
            bluetooth = new Bluetooth();
            bluetoothEnabled = true;
            bluetooth.startConnection();

            if (setupBluetoothServices()) {
                canProcessBluetoothData = true;
            } else {
                error("Error setting up Bluetooth services", true);
            }
        }

        if (com || bluetooth) {
            setTimeout(() => {
                canSendButtonData = true;
            }, 500);
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
        if (connectionMode === "com" && comEnabled) {
            canProcessComData = false;
            removedDevices = removeActiveDevices("com");

            com.stopConnection();
            comEnabled = false;
        } else if (connectionMode === "bluetooth" && bluetoothEnabled) {
            canProcessBluetoothData = false;
            removedDevices = removeActiveDevices("bluetooth");

            bluetooth.stopConnection();
            bluetoothEnabled = false;
        }

        log(`Stopped ${connectionMode} connection, removed devices: ${removedDevices.join(", ")}`);
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
    setTrackerSettings(
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

        if (trackerName.startsWith("HaritoraXW")) {
            writeToBluetooth(trackerName, sensorModeCharacteristic, sensorMode === 1 ? 5 : 8);
            writeToBluetooth(trackerName, fpsModeCharacteristic, fpsMode === 50 ? 1 : 2);
            writeToBluetooth(trackerName, correctionCharacteristic, sensorAutoCorrectionBit);
            writeToBluetooth(trackerName, ankleCharacteristic, ankleMotionDetection ? 1 : 0);
        } else {
            // GX dongle(s)
            const trackerPort = com.getTrackerPort(trackerName);
            const trackerPortId = com.getTrackerPortId(trackerName);

            const identifierValue = `o${trackerPortId}:`;
            const hexValue = getSettingsHexValue(sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection);
            const finalValue = `${identifierValue}${hexValue}`;

            writeToPort(trackerPort, finalValue, trackerName);
            writeToPort(trackerPort, identifierValue, trackerName);
        }

        logSettings(trackerName, settings);
        log(
            `Tracker ${trackerName} settings applied: ${JSON.stringify([
                sensorMode,
                fpsMode,
                sensorAutoCorrection,
                ankleMotionDetection,
            ])}`
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

    setAllTrackerSettings(
        sensorMode: SensorMode,
        fpsMode: FPSMode,
        sensorAutoCorrection: SensorAutoCorrection[],
        ankleMotionDetection: boolean
    ) {
        try {
            if (trackerModelEnabled === "wired") {
                handleWiredSettings(sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection);
            } else if (trackerModelEnabled === "wireless") {
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

    getActiveTrackers(): Array<any> {
        if (!comEnabled && !bluetoothEnabled) return null;
        const comTrackers = comEnabled ? activeDevices : [];
        const bluetoothTrackers = bluetoothEnabled ? bluetooth.getActiveTrackers() : [];
        return comTrackers.concat(bluetoothTrackers);
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
    async getTrackerSettings(trackerName?: string, forceBluetoothRead?: boolean): Promise<object> {
        const logSettings = (name: string, sensorMode: SensorMode, fpsMode: FPSMode, correction: string[], ankle: boolean) => {
            log(`Tracker ${name} settings:`);
            log(`Sensor mode: ${sensorMode}`);
            log(`FPS mode: ${fpsMode}`);
            log(`Sensor auto correction: ${correction}`);
            log(`Ankle motion detection: ${ankle}`);
        };

        if (trackerModelEnabled === "wired") {
            return await getTrackerSettingsFromMap("HaritoraXWired");
        } else if (isWirelessBTTracker(trackerName)) {
            if (forceBluetoothRead || !trackerSettings.has(trackerName)) {
                try {
                    const sensorModeValue = await readFromBluetooth(trackerName, sensorModeCharacteristic);
                    const fpsModeValue = await readFromBluetooth(trackerName, fpsModeCharacteristic);
                    const correctionValue = await readFromBluetooth(trackerName, correctionCharacteristic);
                    const ankleValue = await readFromBluetooth(trackerName, ankleCharacteristic);

                    const sensorMode = sensorModeValue === 5 ? 1 : 2;
                    const fpsMode = fpsModeValue === 1 ? 50 : 100;
                    const sensorAutoCorrection = ["accel", "gyro", "mag"].filter((_, i) => correctionValue & (1 << i));
                    const ankleMotionDetection = ankleValue === 1;

                    logSettings(trackerName, sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection);

                    return { sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection };
                } catch (err) {
                    error(`Error reading characteristic: ${err}`);
                }
            } else {
                return await getTrackerSettingsFromMap(trackerName);
            }
        } else if (trackerModelEnabled === "wireless" && comEnabled && !trackerName.startsWith("HaritoraXW")) {
            return getTrackerSettingsFromMap(trackerName);
        } else {
            error(`Cannot get settings for ${trackerName} settings.`);
            return null;
        }
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
            log(`Tracker ${trackerName} main button: ${mainButton}, sub button: ${subButton}, sub2 button: ${sub2Button}`);
            return { mainButton, subButton, sub2Button };
        }
        log(`Tracker ${trackerName} buttons not found`);
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
            case "com":
                return comEnabled;
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
        // Global
        let serial, model, version, comm, comm_next;

        if (comEnabled) {
            // Get device info from COM by sending "i0" and "i1" commands
            const trackerPort = com.getTrackerPort(trackerName);
            const trackerPortId = com.getTrackerPortId(trackerName);

            const rawValue = `i${trackerPortId}:`;

            writeToPort(trackerPort, rawValue, trackerName);
        }

        if (isWirelessBTTracker(trackerName)) {
            const trackerObject = bluetooth.getActiveDevices().find((device) => device[0] === trackerName);
            if (!trackerObject) {
                log(`Tracker ${trackerName} not found`);
                return null;
            }

            const decoder = new TextDecoder("utf-8");

            const readCharacteristic = async (uuid: string) => {
                const buffer = await bluetooth.read(trackerName, SERVICE_UUID, uuid);
                return buffer ? decoder.decode(buffer) : undefined;
            };

            [version, model, serial] = await Promise.all([
                readCharacteristic(VERSION_UUID),
                readCharacteristic(MODEL_UUID),
                readCharacteristic(SERIAL_UUID),
            ]);
        } else if (comEnabled) {
            const deviceInfo = com.getDeviceInformation(trackerName);
            [version, model, serial] = [deviceInfo[VERSION_INDEX], deviceInfo[MODEL_INDEX], deviceInfo[SERIAL_INDEX]];

            if (trackerModelEnabled === "wired") {
                [comm, comm_next] = [deviceInfo[COMM_INDEX], deviceInfo[COMM_NEXT_INDEX]];
            }
        } else {
            log(`Tracker ${trackerName} not found or unsupported model enabled`);
            return null;
        }

        log(`Tracker ${trackerName} info: ${version}, ${model}, ${serial}, ${comm}, ${comm_next}`);
        this.emit("info", trackerName, version, model, serial, comm, comm_next);
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
        log(`Getting battery info for ${trackerName}`);
        let batteryRemaining, batteryVoltage, chargeStatus;

        // Get battery info from COM
        if (comEnabled) {
            const trackerPort = com.getTrackerPort(trackerName);
            const trackerPortId = com.getTrackerPortId(trackerName);

            const rawValue = `v${trackerPortId}:`;

            writeToPort(trackerPort, rawValue, trackerName);
        }

        // Check if battery info is already available
        if (trackerBattery.has(trackerName)) {
            [batteryRemaining, batteryVoltage, chargeStatus] = trackerBattery.get(trackerName);
        } else if (trackerName.startsWith("HaritoraXW")) {
            // Attempt to read battery info for wireless BT trackers
            log(`Reading battery info for ${trackerName}...`);
            try {
                const batteryLevelBuffer = await bluetooth.read(trackerName, batteryService, batteryLevelCharacteristic);
                if (!batteryLevelBuffer) error(`Tracker ${trackerName} battery level not found`);
                batteryRemaining = new DataView(batteryLevelBuffer).getUint8(0);

                const batteryVoltageBuffer = await bluetooth.read(trackerName, settingsService, batteryVoltageCharacteristic);
                if (!batteryVoltageBuffer) error(`Tracker ${trackerName} battery voltage not found`);
                batteryVoltage = new DataView(batteryVoltageBuffer).getInt16(0, true);

                const chargeStatusBuffer = await bluetooth.read(trackerName, settingsService, chargeStatusCharacteristic);
                const chargeStatusHex = Buffer.from(chargeStatusBuffer).toString("hex");
                if (!chargeStatusBuffer) error(`Tracker ${trackerName} charge status not found`);
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
            error(`Tracker ${trackerName} battery info not found`);
            return null;
        }

        log(`Tracker ${trackerName} battery remaining: ${batteryRemaining}%`);
        log(`Tracker ${trackerName} battery voltage: ${batteryVoltage}`);
        log(`Tracker ${trackerName} charge status: ${chargeStatus}`);
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
        if (trackerMag.has(trackerName)) {
            let magStatus = trackerMag.get(trackerName);
            log(`Tracker ${trackerName} magnetometer status: ${magStatus}`);
            main.emit("mag", trackerName, magStatus);
        } else {
            // Read from BLE device
            if (!trackerName.startsWith("HaritoraXW")) {
                log(`Tracker ${trackerName} magnetometer status not found`);
                return null;
            }

            try {
                await bluetooth.read(trackerName, trackerService, magnetometerCharacteristic);
            } catch (err) {
                error(`Error reading mag status: ${err}`);
                return null;
            }
        }

        return true;
    }

    /**
     * Manually emit a "data" event from com.ts to emulate receiving data from trackers.
     * Useful for development purposes.
     *
     * @function emitData
     * @param trackerName - The name of the tracker.
     * @param port - COM port that data was sent by.
     * @param portId - ID of tracker in the port for data (0/1).
     * @param identifier - Identifier of the data.
     * @param data - The data to be processed.
     */
    emitData(trackerName: string, port: string, portId: string, identifier: string, data: string) {
        com.emit("data", trackerName, port, portId, identifier, data);
    }

    /**
     * Gets the available devices
     *
     * @function getAvailableDevices
     * @returns {string} The available devices to connect to/with (HaritoraX Wired/HaritoraX Wireless/GX6/GX2/Bluetooth).
     */
    async getAvailableDevices(): Promise<string[]> {
        let availableDevices: string[] = [];

        let com = new COM("wireless"); // variable doesn't matter, just need to initialize it to get the available devices
        let bluetooth = new Bluetooth();

        log("Checking if any COM devices is available");
        if (await com.isDeviceAvailable()) {
            log("COM devices available");
            const devices = await com.getAvailableDevices();
            log(`Got COM devices: ${devices}`);
            // for each device, add the device name to the available devices
            devices.forEach((device: string) => {
                if (device === "HaritoraX 1.0" || device === "HaritoraX 1.1" || device === "HaritoraX 1.1b") {
                    availableDevices.push("HaritoraX Wired");
                } else {
                    availableDevices.push(device);
                }
            });
        }
        log("Checking if any Bluetooth devices is available");
        if (await bluetooth.isDeviceAvailable()) {
            log("Bluetooth available");
            availableDevices.push("Bluetooth");

            const devices = await bluetooth.getAvailableDevices();
            log(`Got Bluetooth devices: ${devices}`);

            if (devices) {
                devices.forEach((device: string) => {
                    availableDevices.push(device);
                });
            }
        }

        com.removeAllListeners();
        bluetooth.removeAllListeners();

        com = null;
        bluetooth = null;

        return availableDevices;
    }

    /**
     * Gets the available ports for the specified device
     *
     * @function getDevicePorts
     * @param {string} device - The device to get the ports for.
     * @returns {string[]} The available ports for the specified device.
     */
    async getDevicePorts(device: string): Promise<string[]> {
        let com = new COM("wireless");
        try {
            if (device === "HaritoraX Wired") {
                return await com.getDevicePorts("HaritoraX Wired");
            } else {
                return await com.getDevicePorts(device);
            }
        } finally {
            com.removeAllListeners();
            com = null;
        }
    }

    /**
     * Changes the 2.4 GHz communication channel that specified COM port is using.
     * 
     * @function setChannel
     * @param {string} port - The COM port to change the channel for.
     * @param {number} channel - The channel to change to.
     */
    setChannel(port: string, channel: number) {
        if (!com || !comEnabled) {
            error("COM connection not enabled", true);
            return;
        }

        com.setChannel(port, channel);
    }
}

function listenToDeviceEvents() {
    /*
     * COM events
     */

    if (com) {
        com.on("data", (trackerName: string, port: string, _portId: string, identifier: string, portData: string) => {
            if (!canProcessComData) return;

            if (trackerModelEnabled === "wireless") {
                switch (identifier[0]) {
                    case "x":
                        processIMUData(Buffer.from(portData, "base64"), trackerName);
                        break;
                    case "a":
                        processTrackerData(portData, trackerName);
                        break;
                    case "r":
                        processButtonData(portData, trackerName);
                        break;
                    case "v":
                        processBatteryData(portData, trackerName);
                        break;
                    case "o":
                        processSettingsData(portData, trackerName);
                        break;
                    case "i":
                        processInfoData(portData, trackerName);
                        break;
                    default:
                        log(`${port} - Unknown data from ${trackerName} (identifier: ${identifier}): ${portData}`);
                }
            } else if (trackerModelEnabled === "wired") {
                switch (identifier[0]) {
                    // alright, so for some ungodly reason shiftall decided to use different letters for different number of trackers, AND if they have ankle motion enabled or not
                    // WHAT THE HELL.
                    // x = 5 trackers
                    // p = 6 trackers
                    // r = 6 trackers (w/ ankle motion)
                    // e = 7 trackers
                    // h = 7 trackers (w/ ankle motion)
                    // g = 8 trackers
                    // h = 8 trackers (w/ ankle motion)
                    // (yes. duplicates.)
                    case "x":
                    case "r":
                    case "p":
                    case "h":
                    case "e":
                    case "g":
                        processWiredData(identifier, portData);
                        break;
                    case "s":
                        // settings and tracker info, for now we will only use this for mag status
                        // example: s:{"imu_mode":1, "imu_num":6, "magf_status":"020200", "speed_mode":2, "dcal_flags":"04", "detected":"04004C6C"}
                        processMagData(portData, "HaritoraXWired");
                        processSettingsData(portData, "HaritoraXWired");
                        break;
                    case "t":
                        processButtonData(portData, "HaritoraXWired");
                        break;
                    case "v":
                        processBatteryData(portData, "HaritoraXWired");
                        break;
                    case "i":
                        // "comm" shows it is in bluetooth mode, a dongle for the wired trackers *was* planned, but never released
                        // "comm_next" defines whether it is in classic bluetooth (Bluetooth Serial Port Profile) or BLE (Bluetooth Low Energy) mode
                        // example: {"model":"MC2B", "version":"1.7.10", "serial no":"0000000", "comm":"BLT", "comm_next":"BTSPP"}
                        processInfoData(portData, "HaritoraXWired");
                        break;
                    default:
                        log(`${port} - Unknown data from ${trackerName} (identifier: ${identifier}): ${portData}`);
                }
            }
        });

        com.on("log", (message: string) => {
            log(message);
        });

        com.on("logError", ({ message, exceptional }) => {
            error(message, exceptional);
        });

        com.on("dataRaw", (data, port) => {
            if (!printRaw) return;
            log(`${port} - Raw data: ${data}`);
        });
    }

    /*
     * BLE events
     */

    if (bluetooth) {
        bluetooth.on("data", (localName: string, service: string, characteristic: string, data: string) => {
            if (!canProcessBluetoothData || service === "Device Information") return;

            switch (characteristic) {
                case "Sensor":
                    processIMUData(Buffer.from(data, "base64"), localName);
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
                    log(`Data in utf-8: ${Buffer.from(data, "base64").toString("utf-8")}`);
                    log(`Data in hex: ${Buffer.from(data, "base64").toString("hex")}`);
                    log(`Data in base64: ${Buffer.from(data, "base64").toString("base64")}`);
            }
        });

        bluetooth.on("connect", (peripheral) => {
            const trackerName = peripheral.advertisement.localName;
            if (trackerName && !activeDevices.includes(trackerName)) {
                activeDevices.push(trackerName);
                main.emit("connect", trackerName, "bluetooth");
            }
        });

        bluetooth.on("disconnect", (peripheral) => {
            const trackerName = peripheral.advertisement.localName;
            main.emit("disconnect", trackerName);
        });

        bluetooth.on("log", (message: string) => {
            log(message);
        });

        bluetooth.on("logError", ({ message, exceptional }) => {
            error(message, exceptional);
        });

        bluetooth.on("dataRaw", (localName, service, characteristic, data) => {
            if (!printRaw) return;
            log(`${localName} - Raw data: - ${data} - ${data.toString("base64")} - ${characteristic} - ${service}`);
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

    if (identifier === "x") {
        // 5 (base) trackers
    } else if (identifier === "p" || identifier === "r") {
        // 5 (base) + 1 (hip) = 6 trackers
        trackerNames.push("hip");
    } else if (identifier === "e" || (identifier === "h" && data.split("A").length - 1 >= 18)) {
        // 5 (base) + 2 (elbows) = 7 trackers
        trackerNames.push("leftElbow");
        trackerNames.push("rightElbow");
    } else if (identifier === "g" || (identifier === "h" && data.split("A").length - 1 < 18)) {
        // 5 (base) + 1 (hip) + 2 (elbows) = 8 trackers
        trackerNames.push("hip");
        trackerNames.push("leftElbow");
        trackerNames.push("rightElbow");
    }

    trackerNames.forEach((trackerName, index) => {
        const start = index * 14; // 14 bytes per tracker
        const trackerBuffer = buffer.slice(start, start + 14);

        const ankleBuffer = buffer.slice(buffer.length - 4);
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
 **/

function processIMUData(data: Buffer, trackerName: string, ankleValue?: number) {
    if (!trackerName || !data) return;

    // If tracker isn't in activeDevices, add it and emit "connect" event
    if (!activeDevices.includes(trackerName) && (comEnabled || bluetoothEnabled)) {
        log(`Tracker ${trackerName} isn't in active devices, adding and emitting connect event`);

        const mode = trackerName.startsWith("HaritoraXW") ? "bluetooth" : "com";
        const port = trackerName.startsWith("HaritoraXW") ? undefined : com.getTrackerPort(trackerName);

        log(`Tracker ${trackerName} mode: ${mode}, port: ${port}`);

        activeDevices.push(trackerName);
        main.emit("connect", trackerName, mode, port);
    }

    // Decode and log the data
    try {
        const { rotation, gravity, ankle, magStatus } = decodeIMUPacket(data, trackerName);

        if (printIMU) {
            log(
                `Tracker ${trackerName} rotation: (${rotation.x.toFixed(5)}, ${rotation.y.toFixed(5)}, ${rotation.z.toFixed(
                    5
                )}, ${rotation.w.toFixed(5)})`
            );
            log(`Tracker ${trackerName} gravity: (${gravity.x.toFixed(5)}, ${gravity.y.toFixed(5)}, ${gravity.z.toFixed(5)})`);
            if (ankle) log(`Tracker ${trackerName} ankle: ${ankle}`);
            if (ankleValue) log(`Tracker ${trackerName} (wired/manual) ankle: ${ankleValue}`);
            if (magStatus) log(`Tracker ${trackerName} magnetometer status: ${magStatus}`);
        }

        main.emit("imu", trackerName, rotation, gravity, ankle ? ankle : ankleValue);
        if (!trackerName.startsWith("HaritoraXW")) main.emit("mag", trackerName, magStatus);
    } catch (err) {
        error(`Error decoding tracker ${trackerName} IMU packet data: ${err}`, false);
    }
}

/**
 * The logic to decode the IMU packet received by the dongle.
 * Thanks to sim1222 and BracketProto's project for helping with the math and acceleration/gravity code respectively :p
 * @see {@link https://github.com/sim1222/haritorax-slimevr-bridge/}
 * @see {@link https://github.com/OCSYT/SlimeTora/}
 **/

function decodeIMUPacket(data: Buffer, trackerName: string) {
    if (!trackerName) return;

    try {
        if (data.length < 14) {
            error(`Too few bytes to decode IMU packet, data: ${data.toString("utf-8")}`);
            return null;
        }

        const rotationX = data.readInt16LE(0);
        const rotationY = data.readInt16LE(2);
        const rotationZ = data.readInt16LE(4);
        const rotationW = data.readInt16LE(6);

        const gravityRawX = data.readInt16LE(8);
        const gravityRawY = data.readInt16LE(10);
        const gravityRawZ = data.readInt16LE(12);

        // wireless
        let ankle = undefined;
        // wired
        let magStatus = undefined;

        if (trackerModelEnabled === "wireless") {
            let bufferData = data.toString("base64");
            ankle = bufferData.slice(-2) !== "==" ? data.readUint16LE(data.length - 2) : undefined;

            if (!trackerName.startsWith("HaritoraXW")) {
                const magnetometerData = bufferData.charAt(bufferData.length - 5);

                switch (magnetometerData) {
                    case "A":
                        magStatus = MagStatus.VERY_BAD;
                        break;
                    case "B":
                        magStatus = MagStatus.BAD;
                        break;
                    case "C":
                        magStatus = MagStatus.OKAY;
                        break;
                    case "D":
                        magStatus = MagStatus.GREAT;
                        break;
                    default:
                        magStatus = MagStatus.Unknown;
                        break;
                }

                trackerMag.set(trackerName, magStatus);
            }
        }

        const rotation = {
            x: (rotationX / 180.0) * 0.01,
            y: (rotationY / 180.0) * 0.01,
            z: (rotationZ / 180.0) * 0.01 * -1.0,
            w: (rotationW / 180.0) * 0.01 * -1.0,
        };

        const gravityRaw = {
            x: gravityRawX / 256.0,
            y: gravityRawY / 256.0,
            z: gravityRawZ / 256.0,
        };

        const rc = [rotation.w, rotation.x, rotation.y, rotation.z];
        const r = [rc[0], -rc[1], -rc[2], -rc[3]];
        const p = [0.0, 0.0, 0.0, 9.8];

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

        const gravity = {
            x: gravityRaw.x - hFinal[1] * -1.2,
            y: gravityRaw.y - hFinal[2] * -1.2,
            z: gravityRaw.z - hFinal[3] * 1.2,
        };

        return { rotation, gravity, ankle, magStatus };
    } catch (err) {
        error(`Error decoding IMU packet: ${err}`, false);
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
     */

    if (data === "7f7f7f7f7f7f") {
        //log(`Searching for tracker ${trackerName}...`);
        if (activeDevices.includes(trackerName)) activeDevices.splice(activeDevices.indexOf(trackerName), 1);
        main.emit("disconnect", trackerName);
    } else {
        //log(`Tracker ${trackerName} other data processed: ${data}`);
    }

    // TODO - Find out what "other data" represents, then add to emitted event.
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
            log(`Tracker ${trackerName} mag status: ${magStatus}`);
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

    const SENSOR_MODE_INDEX = 6;
    const POSTURE_DATA_RATE_INDEX = 5;
    const SENSOR_AUTO_CORRECTION_INDEX = 10;
    const ANKLE_MOTION_DETECTION_INDEX = 13;

    try {
        if (trackerModelEnabled === "wireless" && !trackerName.startsWith("HaritoraXW")) {
            const sensorMode = parseInt(data[SENSOR_MODE_INDEX]);
            const fpsMode = parseInt(data[POSTURE_DATA_RATE_INDEX]);
            const sensorAutoCorrection = parseInt(data[SENSOR_AUTO_CORRECTION_INDEX]);
            const ankleMotionDetection = parseInt(data[ANKLE_MOTION_DETECTION_INDEX]);

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
                    log(`11 Tracker ${trackerName} sensor mode: ${sensorModeText}`);
                    main.emit("settings", trackerName, sensorModeText);
                    break;
                case "FpsSetting":
                    const fpsMode = parseBluetoothData(data);
                    const fpsModeText = fpsMode === 50 ? 1 : 2;
                    log(`11 Tracker ${trackerName} FPS mode: ${fpsModeText}`);
                    main.emit("settings", trackerName, undefined, fpsModeText);
                    break;
                case "AutoCalibrationSetting":
                    const sensorAutoCorrection = parseBluetoothData(data);
                    const sensorAutoCorrectionComponents = ["accel", "gyro", "mag"].filter(
                        (_, i) => sensorAutoCorrection & (1 << i)
                    );
                    log(`11 Tracker ${trackerName} sensor auto correction: ${sensorAutoCorrectionComponents}`);
                    main.emit("settings", trackerName, undefined, undefined, sensorAutoCorrectionComponents);
                    break;
                case "TofSetting":
                    const ankleMotionDetection = parseBluetoothData(data);
                    const ankleMotionDetectionText = ankleMotionDetection !== 0;
                    log(`11 Tracker ${trackerName} ankle motion detection: ${ankleMotionDetectionText}`);
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
        log(`Tracker ${trackerName} info: ${version}, ${model}, ${serial}, ${comm}, ${comm_next}`);
        main.emit("info", trackerName, version, model, serial, comm, comm_next);
        deviceInformation.set(trackerName, [version, model, serial, comm, comm_next]);
        return { version, model, serial, comm, comm_next };
    } catch (err) {
        log(`Error processing info data for tracker ${trackerName}: ${err}`);
        return null;
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

    let currentButtons = trackerButtons.get(trackerName) || [0, 0, 0];
    let buttonPressed = undefined;
    let isOn = true;

    try {
        if (trackerName.startsWith("HaritoraXW")) {
            buttonPressed = processWirelessBTTrackerData(characteristic, currentButtons);
        } else if (comEnabled && trackerModelEnabled === "wireless") {
            const { buttonPressed: newButtonPressed, isOn: newIsOn } = processWirelessTrackerData(
                data,
                trackerName,
                currentButtons
            );
            buttonPressed = newButtonPressed;
            isOn = newIsOn;
        } else if (comEnabled && trackerModelEnabled === "wired") {
            buttonPressed = processWiredTrackerData(data, trackerName, currentButtons);
        }

        logButtonPress(trackerName, buttonPressed, currentButtons);
        trackerButtons.set(trackerName, currentButtons);
        main.emit("button", trackerName, buttonPressed, isOn, ...currentButtons);
        return true;
    } catch (err) {
        error(`Error processing button data for ${trackerName}: ${err}`);
        return false;
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
        log(`Tracker ${trackerName} is off/turning off...`);
        log(`Raw data: ${data}`);
        isOn = false;
    } else {
        log(`Tracker ${trackerName} is on/turning on...`);
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

function processWiredTrackerData(data: string, trackerName: string, currentButtons: number[]): string | undefined {
    // example data: t:{"id":"button2", "type":"click", "start_time":6937744, "option":""}
    // TODO: do more testing with wired trackers, find different "type"(s) and what "start_time" and "option" mean
    const buttonData = JSON.parse(data);
    if (trackerName === "HaritoraXWired") {
        if (buttonData.id === "button1") {
            currentButtons[MAIN_BUTTON_INDEX] += 1;
            return "main";
        } else if (buttonData.id === "button2") {
            currentButtons[SUB_BUTTON_INDEX] += 1;
            return "sub";
        } else if (buttonData.id === "button3") {
            currentButtons[SUB2_BUTTON_INDEX] += 1;
            return "sub2";
        }
    }

    return undefined;
}

function logButtonPress(trackerName: string, buttonPressed: string | undefined, currentButtons: number[]) {
    if (buttonPressed) {
        log(`Button ${buttonPressed} pressed on tracker ${trackerName}. Current state: ${currentButtons}`);
    } else {
        log(`No button press detected for tracker ${trackerName}. Current state: ${currentButtons}`);
    }
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

function processBatteryData(data: string, trackerName: string, characteristic?: string) {
    const batteryData: [number | undefined, number | undefined, string | undefined] = [undefined, undefined, undefined];
    const logBatteryInfo = (remaining: number | undefined, voltage: number | undefined, status: string | undefined) => {
        if (remaining !== undefined) log(`Tracker ${trackerName} remaining: ${remaining}%`);
        if (voltage !== undefined) log(`Tracker ${trackerName} voltage: ${voltage}`);
        if (status !== undefined) log(`Tracker ${trackerName} Status: ${status}`);
    };

    if (comEnabled && !trackerName.startsWith("HaritoraXW")) {
        try {
            const batteryInfo = JSON.parse(data);
            batteryData[0] = batteryInfo["battery remaining"];
            batteryData[1] = batteryInfo["battery voltage"];
            batteryData[2] = batteryInfo["charge status"];
            logBatteryInfo(batteryData[0], batteryData[1], batteryData[2]);
        } catch (err) {
            error(`Error parsing battery data JSON for ${trackerName}: ${err}`);
            log(`Raw battery data: ${data}`);
        }
    } else if (isWirelessBTTracker(trackerName) && characteristic) {
        try {
            if (characteristic === "BatteryLevel") {
                const batteryRemaining = parseInt(Buffer.from(data, "base64").toString("hex"), 16);
                updateAndEmitBatteryInfo(trackerName, "BatteryLevel", batteryRemaining);
            } else if (characteristic === "BatteryVoltage") {
                const batteryVoltage = Buffer.from(data, "base64").readInt16LE(0);
                updateAndEmitBatteryInfo(trackerName, "BatteryVoltage", batteryVoltage);
            } else if (characteristic === "ChargeStatus") {
                const chargeStatus = Buffer.from(data, "base64").toString("hex");
                let chargeStatusReadable;
                switch (chargeStatus) {
                    case "00":
                        chargeStatusReadable = "discharging";
                        break;
                    case "01":
                        chargeStatusReadable = "charging";
                        break;
                    case "02":
                        chargeStatusReadable = "charged";
                        break;
                    default:
                        chargeStatusReadable = "unknown";
                        break;
                }
                updateAndEmitBatteryInfo(trackerName, "ChargeStatus", chargeStatusReadable);
            }
        } catch (err) {
            error(`Error processing battery data for ${trackerName}: ${err}`);
        }
    }

    trackerBattery.set(trackerName, batteryData);
    main.emit("battery", trackerName, ...batteryData);
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

function log(message: string) {
    if (!debug) return;

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
    return trackerModelEnabled === "wireless" && bluetoothEnabled && trackerName.startsWith("HaritoraXW");
}

function writeToPort(port: string, rawData: String, trackerName = "unknown") {
    const ports = com.getActivePorts();
    const data = rawData instanceof Buffer ? rawData.toString() : rawData;
    const finalData = `\n${data}\n`;

    ports[port].write(finalData, (err: any) => {
        if (err) {
            error(`${trackerName} - Error writing data to serial port ${port}: ${err}`);
        } else {
            log(`${trackerName} - Data written to serial port ${port}: ${data.toString().replace(/\r\n/g, " ")}`);
        }
    });
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

function writeToBluetooth(trackerName: string, characteristic: string, value: number) {
    const buffer = Buffer.from([value]);
    bluetooth.write(trackerName, settingsService, characteristic, buffer);
}

async function readFromBluetooth(trackerName: string, characteristic: string) {
    const data = await bluetooth.read(trackerName, settingsService, characteristic);
    return parseBluetoothData(data);
}

function parseBluetoothData(data: ArrayBufferLike | string) {
    if (typeof data === "string") data = Buffer.from(data, "base64");
    return new DataView(data).getInt8(0);
}

function logSettings(trackerName: string, settings: Object, rawHexData?: string) {
    if (trackerName === "DONGLE") return;
    log(`Tracker ${trackerName} settings:`);
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
    let devices = deviceTypeToRemove === "bluetooth" ? bluetooth.getActiveDevices() : com.getTrackers();
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

async function getTrackerSettingsFromMap(trackerName: string) {
    const settings = trackerSettings.get(trackerName);
    if (settings) {
        const settingsToLog = {
            "Sensor mode": settings[0],
            "FPS mode": settings[1],
            "Sensor auto correction": settings[2],
            "Ankle motion detection": settings[3],
        };
        logSettings(trackerName, settingsToLog);

        return Promise.resolve({
            sensorMode: settings[0],
            fpsMode: settings[1],
            sensorAutoCorrection: settings[2],
            ankleMotionDetection: settings[3],
        });
    } else {
        error(`Tracker ${trackerName} settings not found in trackerSettings map.`);
        return Promise.reject(`Tracker ${trackerName} settings not found in trackerSettings map.`);
    }
}

function handleWiredSettings(
    sensorMode: SensorMode,
    fpsMode: FPSMode,
    sensorAutoCorrection: SensorAutoCorrection[],
    ankleMotionDetection: boolean
) {
    const ports = com.getActivePorts();

    // Prepare commands
    const commands: { [key: string]: string | null } = {
        sensorMode: sensorMode === 1 ? "sensor imu mode 1\r\n" : sensorMode === 2 ? "sensor imu mode 2\r\n" : null,
        fpsMode: fpsMode === 50 ? "system speed mode 1\r\n" : fpsMode === 100 ? "system speed mode 2\r\n" : null,
        sensorAutoCorrection: (() => {
            let sensorAutoCorrectionBit = 0;
            if (sensorAutoCorrection.includes("accel")) sensorAutoCorrectionBit += 1;
            if (sensorAutoCorrection.includes("gyro")) sensorAutoCorrectionBit += 2;
            if (sensorAutoCorrection.includes("mag")) sensorAutoCorrectionBit += 4;
            return `sensor cal flags ${sensorAutoCorrectionBit}\r\nsensor restart\r\n`;
        })(),
        ankleMotionDetection: ankleMotionDetection
            ? "param sensor range\r\nparam save\r\nsensor restart\r\n"
            : "param sensor basic\r\nparam save\r\nsensor restart\r\n",
    };

    // Send commands to all ports
    for (const port in ports) {
        for (const commandKey in commands) {
            const command = commands[commandKey];
            if (command) writeToPort(port, command, "HaritoraXWired");
        }
    }

    trackerSettings.set("HaritoraXWired", [sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection]);

    return true;
}

function handleWirelessSettings(
    sensorMode: SensorMode,
    fpsMode: FPSMode,
    sensorAutoCorrection: SensorAutoCorrection[],
    ankleMotionDetection: boolean
) {
    if (comEnabled) {
        const hexValue = getSettingsHexValue(sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection);
        const finalValue = `o0:${hexValue}\no1:${hexValue}`;

        for (const port in com.getActivePorts()) {
            writeToPort(port, finalValue, "HaritoraXWireless");
        }
    }

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
