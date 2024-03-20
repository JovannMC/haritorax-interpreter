"use strict";

import { Buffer } from "buffer";
import { EventEmitter } from "events";
import GX6 from "../mode/gx6.js";
import Bluetooth from "../mode/bluetooth.js";

let debug = false;

const gx6 = new GX6();
const bluetooth = new Bluetooth();
let gx6Enabled = false;
let bluetoothEnabled = false;
let haritora;

const SENSOR_MODE_1 = "1";
const SENSOR_MODE_2 = "0";
const FPS_MODE_100 = "1";
const FPS_MODE_50 = "0";

const trackerButtons = new Map([
    // trackerName, [mainButton, subButton]
    ["rightKnee", [0, 0]],
    ["rightAnkle", [0, 0]],
    ["hip", [0, 0]],
    ["chest", [0, 0]],
    ["leftKnee", [0, 0]],
    ["leftAnkle", [0, 0]]
]);

const trackerSettings = new Map([
    // trackerName, settings
    ["rightKnee", ""],
    ["rightAnkle", ""],
    ["hip", ""],
    ["chest", ""],
    ["leftKnee", ""],
    ["leftAnkle", ""]
]);

const trackerBattery = new Map([
    // trackerName, [batteryRemaining, batteryVoltage, chargeStatus]
]);

const deviceInformation = new Map([
    // deviceName, [version, model, serial] (in JSON)
]);

let activeDevices = [];

// JSDoc comments for events

/**
 * The "imu" event which provides info about the tracker's IMU data.
 * Support: GX6, Bluetooth
 * 
 * @event this#imu
 * @type {object}
 * @property {string} trackerName - The name of the tracker. Possible values: "rightKnee", "rightAnkle", "hip", "chest", "leftKnee", "leftAnkle".
 * @property {object} rotation - The rotation data of the tracker.
 * @property {number} rotation.x - The x component of the rotation.
 * @property {number} rotation.y - The y component of the rotation.
 * @property {number} rotation.z - The z component of the rotation.
 * @property {number} rotation.w - The w component of the rotation.
 * @property {object} gravity - The gravity data of the tracker.
 * @property {number} gravity.x - The x component of the gravity.
 * @property {number} gravity.y - The y component of the gravity.
 * @property {number} gravity.z - The z component of the gravity.
 * @property {number|null} ankle - The ankle motion data of the tracker if enabled. Null if disabled.
**/

/** 
 * The "tracker" event which provides info about the tracker's other data.
 * Support: GX6
 * 
 * @event this#tracker
 * @type {object}
 * @property {string} trackerName - The name of the tracker. (rightKnee, rightAnkle, hip, chest, leftKnee, leftAnkle)
 * @property {string} data - The data received from the tracker.
**/

/** 
 * The "settings" event which provides info about the tracker settings.
 * Support: GX6, Bluetooth (untested)
 * 
 * @event this#settings
 * @type {object}
 * @property {string} trackerName - The name of the tracker.
 * @property {number} sensorMode - The sensor mode, which controls whether magnetometer is used (1 or 2).
 * @property {number} fpsMode - The posture data transfer rate/FPS (50 or 100).
 * @property {string} sensorAutoCorrection - The sensor auto correction mode, multiple or none can be used (accel, gyro, mag).
 * @property {boolean} ankleMotionDetection - Whether ankle motion detection is enabled. (true or false)
**/

/**
 * The "button" event which provides info about the tracker's button data.
 * Support: GX6, Bluetooth (partial)
 * 
 * @event this#button
 * @type {object}
 * @property {string} trackerName - The name of the tracker. (rightKnee, rightAnkle, hip, chest, leftKnee, leftAnkle)
 * @property {number} mainButton - Amount of times the main button was pressed.
 * @property {number} subButton - Amount of times the sub button was pressed.
 * @property {boolean} isOn - Whether the tracker is turning on/is on (true) or turning off/is off (false).
**/

/**
 * The "battery" event which provides info about the tracker's battery data.
 * Support: GX6, Bluetooth (partial)
 * 
 * @event this#battery
 * @type {object}
 * @property {string} trackerName - The name of the tracker. (rightKnee, rightAnkle, hip, chest, leftKnee, leftAnkle)
 * @property {number} batteryRemaining - The remaining battery percentage of the tracker.
 * @property {number} batteryVoltage - The voltage of the tracker's battery.
 * @property {string} chargeStatus - The charge status of the tracker. (discharging, charging(?), charged(?))
 */

/**
 * The "info" event which provides info about the tracker or dongle.
 * Support: GX6, Bluetooth
 *
 * @event this#info
 * @type {object}
 * @property {string} type - The type of the device. (tracker or dongle)
 * @property {string} version - The version of the device.
 * @property {string} model - The model of the device.
 * @property {string} serial - The serial number of the device.
**/



/**
 * The HaritoraXWireless class.
 * 
 * This class represents a HaritoraX wireless device. It provides methods to start/stop a connection,
 * set settings for all/individual trackers, and emits events for: IMU data, tracker data, button data, battery data, and settings data.
 * 
 * @param {boolean} debugMode - Enable logging of debug messages. (true or false)
 * 
 * @example
 * let device = new HaritoraXWireless(true);
**/
export default class HaritoraXWireless extends EventEmitter {
    constructor(debugMode = false) {
        super();
        debug = debugMode;
        haritora = this;
    }

    /**
     * Starts the connection to the trackers with the specified mode.
     * 
     * @param {string} connectionMode - Connect to the trackers with the specified mode (gx6 or bluetooth).
     * 
     * @example
     * device.startConnection("gx6");
    **/
    startConnection(connectionMode) {
        if (connectionMode === "gx6") {
            gx6.startConnection();
            gx6Enabled = true;
        } else if (connectionMode === "bluetooth") {
            bluetooth.startConnection();
            bluetoothEnabled = true;
        }
    }


    /**
     * Stops the connection to the trackers with the specified mode.
     * 
     * @param {string} connectionMode - Disconnect from the trackers with the specified mode (gx6 or bluetooth).
     * 
     * @example
     * device.stopConnection("gx6");
    **/
    stopConnection(connectionMode) {
        if (connectionMode === "gx6") {
            gx6.stopConnection();
            gx6Enabled = false;
        } else if (connectionMode === "bluetooth") {
            bluetooth.stopConnection();
            bluetoothEnabled = false;
        }
    }

    /**
     * Sets the tracker settings for a specific tracker.
     * Support: GX6
     * 
     * @param {string} trackerName - The name of the tracker to apply settings to (rightKnee, rightAnkle, hip, chest, leftKnee, leftAnkle).
     * @param {number} fpsMode - The posture data transfer rate/FPS (50 or 100).
     * @param {number} sensorMode - The sensor mode, which controls whether magnetometer is used (1 or 2).
     * @param {string} sensorAutoCorrection - The sensor auto correction mode, multiple or none can be used (accel, gyro, mag).
     * @param {boolean} ankleMotionDetection - Whether ankle motion detection is enabled. (true or false)
     * @returns {boolean} - Whether the settings were successfully sent to the tracker.
     * @fires this#settings
     * 
     * @example
     * trackers.setTrackerSettings("rightAnkle", 100, 1, ['accel', 'gyro'], true);
    **/ 

    setTrackerSettings(trackerName, fpsMode, sensorMode, sensorAutoCorrection, ankleMotionDetection) {
        const TRACKERS_GROUP_ONE = ["rightKnee", "hip", "leftKnee"];
        const TRACKERS_GROUP_TWO = ["rightAnkle", "chest", "leftAnkle"];

        if (bluetoothEnabled) {
            log("Setting tracker settings for bluetooth is not supported yet.");
            return false;
        } else {
            log(`Setting tracker settings for ${trackerName}...`);
            const sensorModeBit = sensorMode === 1 ? SENSOR_MODE_1 : SENSOR_MODE_2; // Default to mode 2
            const postureDataRateBit = fpsMode === 100 ? FPS_MODE_100 : FPS_MODE_50; // Default to 50 FPS
            const ankleMotionDetectionBit = ankleMotionDetection ? "1" : "0"; // Default to false
            let sensorAutoCorrectionBit = 0;
            if (sensorAutoCorrection.includes("accel")) sensorAutoCorrectionBit |= 0x01;
            if (sensorAutoCorrection.includes("gyro")) sensorAutoCorrectionBit |= 0x02;
            if (sensorAutoCorrection.includes("mag")) sensorAutoCorrectionBit |= 0x04;

            let hexValue = `00000${postureDataRateBit}${sensorModeBit}010${sensorAutoCorrectionBit}00${ankleMotionDetectionBit}`;
            let trackerSettingsBuffer = null;

            if (TRACKERS_GROUP_ONE.includes(trackerName)) {
                trackerSettingsBuffer = this.getTrackerSettingsBuffer(trackerName, hexValue, 1);
            } else if (TRACKERS_GROUP_TWO.includes(trackerName)) {
                trackerSettingsBuffer = this.getTrackerSettingsBuffer(trackerName, hexValue, -1);
            } else {
                log(`Invalid tracker name: ${trackerName}`);
                return;
            }

            log(`Setting the following settings onto tracker ${trackerName}:
                FPS mode: ${fpsMode}
                Sensor mode: ${sensorMode}
                Sensor auto correction: ${sensorAutoCorrection}
                Ankle motion detection: ${ankleMotionDetection}
                Raw hex data calculated to be sent: ${hexValue}`);
            
            try {
                log(`Sending tracker settings to ${trackerName}: ${trackerSettingsBuffer.toString()}`);
                let ports = gx6.getActivePorts();
                let trackerInfo = gx6.getTrackerInfo(trackerName);
                let trackerPort = trackerInfo[1];

                ports[trackerPort].write(trackerSettingsBuffer, (err) => {
                    if (err) {
                        console.error(`${trackerName} - Error writing data to serial port ${trackerPort}: ${err.message}`);
                    } else {
                        trackerSettings.set(trackerName, hexValue);
                        log(`${trackerName} - Data written to serial port ${trackerPort}: ${trackerSettingsBuffer.toString()}`);
                    }
                });
            } catch (error) {
                console.error(`Error sending tracker settings:\n${error.message}`);
                return false;
            }
        }

        this.emit("settings", trackerName, sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection);
        return true;
    }

    getTrackerSettingsBuffer(trackerName, hexValue, direction) {
        const entries = Array.from(trackerSettings.entries());
        const currentIndex = entries.findIndex(([key]) => key === trackerName);
    
        if (currentIndex !== -1 && currentIndex + direction >= 0 && currentIndex + direction < entries.length) {
            const adjacentKey = entries[currentIndex + direction][0];
            let adjacentValue = trackerSettings.get(adjacentKey);
            return Buffer.from(`o0:${direction === 1 ? hexValue : adjacentValue}\r\no1:${direction === 1 ? adjacentValue : hexValue}\r\n`, "utf-8");
        }
    
        log(`${trackerName} - Calculated hex value: ${hexValue}`);
        return null;
    }

    
    /**
     * Sets the tracker settings for all connected trackers
     * Support: GX6
     *
     * @param {number} fpsMode - The posture data transfer rate/FPS (50 or 100).
     * @param {number} sensorMode - The sensor mode, which controls whether magnetometer is used (1 or 2).
     * @param {string} sensorAutoCorrection - The sensor auto correction mode, multiple or none can be used (accel, gyro, mag).
     * @param {boolean} ankleMotionDetection - Whether ankle motion detection is enabled. (true or false)
     * @returns {boolean} - Whether the settings were successfully sent to all trackers.
     * @fires this#settings
     * 
     * @example
     * trackers.setAllTrackerSettings(50, 2, ['mag'], false);
    **/

    setAllTrackerSettings(fpsMode, sensorMode, sensorAutoCorrection, ankleMotionDetection) {
        if (bluetoothEnabled) {
            log("Setting all tracker settings for bluetooth is not supported yet.");
            return false;
        } else if (gx6Enabled) {
            try {
                const sensorModeBit = sensorMode === 1 ? SENSOR_MODE_1 : SENSOR_MODE_2; // Default to mode 2
                const postureDataRateBit = fpsMode === 100 ? FPS_MODE_100 : FPS_MODE_50; // Default to 50 FPS
                const ankleMotionDetectionBit = ankleMotionDetection ? "1" : "0"; // Default to false
                let sensorAutoCorrectionBit = 0;
                if (sensorAutoCorrection.includes("accel")) sensorAutoCorrectionBit |= 0x01;
                if (sensorAutoCorrection.includes("gyro")) sensorAutoCorrectionBit |= 0x02;
                if (sensorAutoCorrection.includes("mag")) sensorAutoCorrectionBit |= 0x04;

                const hexValue = `00000${postureDataRateBit}${sensorModeBit}010${sensorAutoCorrectionBit}00${ankleMotionDetectionBit}`;
                const trackerSettingsBuffer = Buffer.from("o0:" + hexValue + "\r\n" + "o1:" + hexValue + "\r\n", "utf-8");

                log(`Setting the following settings onto all connected trackers:
                    Connected trackers: ${activeDevices}
                    FPS mode: ${fpsMode}
                    Sensor mode: ${sensorMode}
                    Sensor auto correction: ${sensorAutoCorrection}
                    Ankle motion detection: ${ankleMotionDetection}
                    Raw hex data calculated to be sent: ${hexValue}`);

                let ports = gx6.getActivePorts();
                for (let trackerName of trackerSettings.keys()) {
                    let trackerInfo = gx6.getTrackerInfo(trackerName);
                    let trackerPort = trackerInfo[1];

                    ports[trackerPort].write(trackerSettingsBuffer, (err) => {
                        if (err) {
                            console.error(`${trackerName} - Error writing data to serial port ${trackerPort}: ${err.message}`);
                        } else {
                            trackerSettings.set(trackerName, hexValue);
                            log(`${trackerName} - Data written to serial port ${trackerPort}: ${trackerSettingsBuffer.toString()}`);
                        }
                    });
                }
            } catch (error) {
                console.error(`Error sending tracker settings:\n ${error}`);
                return false;
            }
        } else {
            log("No connection mode is enabled");
            return false;
        }

        for (let trackerName of trackerSettings.keys()) {
            this.emit("settings", trackerName, sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection);
        }
        return true;
    }

    /**
     * Returns device info for the specified tracker or dongle.
     * Support: GX6, Bluetooth
     * 
     * @function getDeviceInfo
     * @returns {object} - The device info (version, model, serial)
     * @fires this#info
    **/

    async getDeviceInfo(trackerName) {
        const SERVICE_UUID = "180a";
        const VERSION_UUID = "2a28";
        const MODEL_UUID = "2a24";
        const SERIAL_UUID = "2a25";
        const TIMEOUT = 3000;

        let serial = null;
        let model = null;
        let version = null;
        
        if (trackerName === "(DONGLE)" || gx6Enabled) {
            const device = trackerName === "(DONGLE)" ? "dongle" : "tracker";
            log(`Getting ${device} info for ${trackerName}...`);
            if (deviceInformation.has(trackerName)) {
                let deviceInfo = deviceInformation.get(trackerName);
                version = deviceInfo["version"];
                model = deviceInfo["model"];
                serial = deviceInfo["serial no"];
            } else {
                log(`No information found for tracker ${trackerName}`);
            }
            
            this.emit("info", device, version, model, serial);
        } else if (bluetoothEnabled) {
            let trackerObject = bluetooth.getActiveDevices().find(device => device.advertisement.localName === trackerName);
            if (!trackerObject) {
                log(`Tracker ${trackerName} not found`);
                return null;
            }

            const readPromises = [];

            for (let service of trackerObject.services) {
                if (service.uuid !== SERVICE_UUID) continue;
                for (let characteristic of service.characteristics) {
                    const promise = new Promise((resolve, reject) => {
                        characteristic.read((err, data) => {
                            if (err) {
                                reject(`Error reading characteristic for ${trackerName}: ${err}`);
                            } else {
                                switch (characteristic.uuid) {
                                case VERSION_UUID:
                                    version = data.toString("utf-8");
                                    break;
                                case MODEL_UUID:
                                    model = data.toString("utf-8");
                                    break;
                                case SERIAL_UUID:
                                    serial = data.toString("utf-8");
                                    break;
                                }
                                resolve();
                            }
                        });
                    
                        setTimeout(() => reject(`Read operation for ${trackerName} timed out`), TIMEOUT);
                    });
                    readPromises.push(promise);
                }
            }

            try {
                await Promise.all(readPromises);
                log(`Tracker ${trackerName} info: ${version}, ${model}, ${serial}`);
                this.emit("info", "tracker", version, model, serial);
            } catch (error) {
                console.error(error);
            }
        }

        log(`Tracker ${trackerName} info: ${version}, ${model}, ${serial}`);
        deviceInformation.set(trackerName, { version: version, model: model, "serial no": serial });
        return { version, model, serial };
    }

    /**
     * Get battery info from the trackers.
     * Support: GX6, Bluetooth
     * 
     * @function getBatteryInfo
     * @returns {object} - The battery info (batteryRemaining, batteryVoltage, chargeStatus)
     * @fires this#battery
    **/

    async getBatteryInfo(trackerName) {
        try {
            if (trackerBattery.has(trackerName)) {
                let [batteryRemaining, batteryVoltage, chargeStatus] = trackerBattery.get(trackerName);
                log(`Tracker ${trackerName} battery remaining: ${batteryRemaining}%`);
                log(`Tracker ${trackerName} battery voltage: ${batteryVoltage}`);
                log(`Tracker ${trackerName} charge status: ${chargeStatus}`);
                this.emit("battery", trackerName, batteryRemaining, batteryVoltage, chargeStatus);
                return { batteryRemaining, batteryVoltage, chargeStatus };
            } else {
                if (gx6Enabled) {
                    log(`Tracker ${trackerName} battery info not found`);
                    return null;
                } else if (bluetoothEnabled) {
                    let trackerObject = bluetooth.getActiveDevices().find(device => device.advertisement.localName === trackerName);
                    if (!trackerObject) {
                        log(`Tracker ${trackerName} not found`);
                        return null;
                    }
                    let batteryCharacteristic = trackerObject.services.find(service => service.uuid === "180f").characteristics.find(characteristic => characteristic.uuid === "2a19");

                    batteryCharacteristic.read((err, data) => {
                        if (err) {
                            console.error(`Error reading battery characteristic for ${trackerName}: ${err}`);
                        } else {
                            let batteryRemaining = data[0];
                            log(`Tracker ${trackerName} battery remaining: ${batteryRemaining}%`);
                            this.emit("battery", trackerName, batteryRemaining, null, null);
                        }
                    });
                }
            }
        } catch (error) {
            console.error(`Error getting battery info for ${trackerName}:`, error);
        }
    }

    /**
     * Get the active trackers.
     * Support: GX6, Bluetooth
     * 
     * @function getActiveTrackers
     * @returns {array} - The active trackers.
    **/

    getActiveTrackers() {
        if (gx6Enabled) {
            return activeDevices;
        } else if (bluetoothEnabled) {
            return bluetooth.getActiveTrackers();
        } else {
            return null;
        }
    }
}

gx6.on("data", (port, data) => {
    const splitData = data.toString().split(/:(.+)/);
    const identifier = splitData[0].toLowerCase();
    const value = splitData[1];

    // Check if the identifier contains a number, if not, it's the dongle
    const trackerId = identifier.match(/\d/) ? identifier.match(/\d/)[0] : "(DONGLE)";

    // Check what body part the tracker is assigned to
    let trackerName = gx6.getPartFromInfo(trackerId, port);

    // If the tracker is not in the list of active devices, add it
    if (!activeDevices.includes(trackerName) && trackerName !== "(DONGLE)") activeDevices.push(trackerName);

    if (trackerName === "(DONGLE)") {
        if (identifier.includes("i")) {
            processInfoData(value, trackerName);
        }
        return;
    }

    switch (identifier[0]) {
    case "x":
        //processIMUData(value, trackerName);
        break;
    case "a":
        processTrackerData(value, trackerName);
        break;
    case "r":
        processButtonData(value, trackerName);
        break;
    case "v":
        processBatteryData(value, trackerName);
        break;
    case "o":
        processTrackerSettings(value, trackerName);
        break;
    case "i":
        processInfoData(value, trackerName);
        break;
    default:
        log(`${port} - Unknown data from ${trackerName}: ${data}`);
    }
});

// TODO: magnetometer, add settings
bluetooth.on("data", (localName, service, characteristic, data) => {
    if (service === "Device Information") return;

    switch (characteristic) {
    case "Sensor":
        //processIMUData(data, localName);
        break;
    case "MainButton":
    case "SecondaryButton":
        processButtonData(data, localName, characteristic);
        break;
    case "BatteryLevel":
        processBatteryData(data, localName);
        break;
    /*case "Settings":
        // TODO - Process settings data, probably will need to be manually read and set
        //processTrackerSettings(data, localName);
        break;*/
    default:
        log(`Unknown data from ${localName}: ${data} - ${characteristic} - ${service}`);
        log(`Data in utf-8: ${Buffer.from(data, "base64").toString("utf-8")}`);
        log(`Data in hex: ${Buffer.from(data, "base64").toString("hex")}`);
        log(`Data in base64: ${Buffer.from(data, "base64").toString("base64")}`);
    }
});
/**
 * Processes the IMU data received from the tracker by the dongle.
 * The data contains the information about the rotation, gravity, and ankle motion (if enabled) of the tracker.
 * Support: GX6, Bluetooth
 *
 * @function processIMUData
 * 
 * @param {string} data - The data to process.
 * @param {string} trackerName - The name of the tracker.
 * @fires haritora#imu
**/

function processIMUData(data, trackerName) {
    // Check if the data is valid
    if (!data || !data.length === 24) {
        log(`Invalid IMU packet for tracker ${trackerName}: ${data}`);
        return false;
    }

    // Decode and log the data
    try {
        const { rotation, gravity, ankle } = decodeIMUPacket(data);
        
        log(`Tracker ${trackerName} rotation: (${rotation.x.toFixed(5)}, ${rotation.y.toFixed(5)}, ${rotation.z.toFixed(5)}, ${rotation.w.toFixed(5)})`);
        log(`Tracker ${trackerName} gravity: (${gravity.x.toFixed(5)}, ${gravity.y.toFixed(5)}, ${gravity.z.toFixed(5)})`);
        if (ankle) log(`Tracker ${trackerName} ankle: ${ankle}`);

        haritora.emit("imu", trackerName, rotation, gravity, ankle);
    } catch (err) {
        console.error(`Error decoding tracker ${trackerName} IMU packet data: ${err.message}`);
    }
}


/**
 * The logic to decode the IMU packet received by the dongle. 
 * Thanks to sim1222's project for helping with the math :p
 * @see {@link https://github.com/sim1222/haritorax-slimevr-bridge/}
**/

function decodeIMUPacket(data) {
    try {
        if (data.length < 14) {
            throw new Error("Too few bytes to decode IMU packet");
        }

        const buffer = Buffer.from(data, "base64");
        const rotationX = buffer.readInt16LE(0);
        const rotationY = buffer.readInt16LE(2);
        const rotationZ = buffer.readInt16LE(4);
        const rotationW = buffer.readInt16LE(6);
        const gravityX = buffer.readInt16LE(8);
        const gravityY = buffer.readInt16LE(10);
        const gravityZ = buffer.readInt16LE(12);

        const rotation = {
            x: rotationX / 180.0 * 0.01,
            y: rotationY / 180.0 * 0.01,
            z: rotationZ / 180.0 * 0.01 * -1.0,
            w: rotationW / 180.0 * 0.01 * -1.0
        };

        const gravity = {
            x: gravityX / 256.0,
            y: gravityY / 256.0,
            z: gravityZ / 256.0
        };

        let ankle = null;
        if (data.slice(-2) !== "==" && data.length > 14){
            ankle = buffer.readInt16LE(14);
        }

        return { rotation, gravity, ankle };
    } catch (error) {
        throw new Error("Error decoding IMU packet: " + error.message);
    }
}


/**
 * Processes other tracker data received from the tracker by the dongle.
 * Read function comments for more information.
 * Support: GX6
 * 
 * @function processTrackerData
 * @param {string} data - The data to process.
 * @param {string} trackerName - The name of the tracker.
 * @fires haritora#tracker
**/

function processTrackerData(data, trackerName) {
    /* 
    * Currently unsure what other data a0/a1 could represent other than trying to find the trackers, I see other values for it too reporting every second (mag info?).
    * This could also be used to report calibration data when running the calibration through the software.
    */
    
    if (data === "7f7f7f7f7f7f") {
        //log(`Searching for tracker ${trackerName}...`);
        if (activeDevices.includes(trackerName)) activeDevices.splice(activeDevices.indexOf(trackerName), 1);
    } else {
        log(`Tracker ${trackerName} other data processed: ${data}`);
    }

    // TODO - Find out what the other data represents, then add to emitter
    haritora.emit("tracker", trackerName, data);
}


/**
 * Processes the button data received from the tracker by the dongle.
 * The data contains the information about the main and sub buttons on the tracker.
 * Support: GX6, Bluetooth
 * 
 * @function processButtonData
 * @param {string} data - The data to process.
 * @param {string} trackerName - The name of the tracker.
 * @param {string} characteristic - The characteristic of the data, if bluetooth trackers. (MainButton, SecondaryButton)
 * @fires haritora#button
**/

function processButtonData(data, trackerName, characteristic) {
    const MAIN_BUTTON_INDEX = 0;
    const SUB_BUTTON_INDEX = 1;
    const TRACKER_OFF = false;
    const TRACKER_ON = true;

    let currentButtons = trackerButtons.get(trackerName) || [0, 0];
    let buttonState = null;

    try {
        if (bluetoothEnabled) {
            if (characteristic === "MainButton") {
                currentButtons[MAIN_BUTTON_INDEX] += 1;
            } else if (characteristic === "SecondaryButton") {
                currentButtons[SUB_BUTTON_INDEX] += 1;
            }
            buttonState = TRACKER_ON; // Tracker is always on when connected via bluetooth, because need to be connected to read button data
        } else if (gx6Enabled) {
            currentButtons[MAIN_BUTTON_INDEX] = parseInt(data[6], 16);
            currentButtons[SUB_BUTTON_INDEX] = parseInt(data[9], 16);

            if (data[0] === "0" || data[7] === "f" || data[8] === "f" || data[10] === "f" || data[11] === "f") {
                log(`Tracker ${trackerName} is off/turning off...`);
                buttonState = TRACKER_OFF;
            } else {
                buttonState = TRACKER_ON;
            }
        }
    } catch (err) {
        console.error(`Error processing button data for ${trackerName}: ${err}`);
        return false;
    }

    trackerButtons.set(trackerName, currentButtons);
    haritora.emit("button", trackerName, currentButtons[MAIN_BUTTON_INDEX], currentButtons[SUB_BUTTON_INDEX], buttonState);

    log(`Tracker ${trackerName} main button: ${currentButtons[MAIN_BUTTON_INDEX]}`);
    log(`Tracker ${trackerName} sub button: ${currentButtons[SUB_BUTTON_INDEX]}`);
    return true;
}


/**
 * Processes the battery data received from the tracker by the dongle.
 * It contains the information about the battery percentage, voltage, and charge status of the tracker.
 * Support: GX6, Bluetooth (partial)
 * 
 * @function processBatteryData
 * @param {string} data - The data to process.
 * @param {string} trackerName - The name of the tracker.
 * @fires haritora#battery
**/

function processBatteryData(data, trackerName) {
    const BATTERY_REMAINING_INDEX = 0;
    const BATTERY_VOLTAGE_INDEX = 1;
    const CHARGE_STATUS_INDEX = 2;
    let batteryData = [null, null, null];

    if (bluetoothEnabled) {
        try {
            let batteryRemainingHex = Buffer.from(data, "base64").toString("hex");
            batteryData[0] = parseInt(batteryRemainingHex, 16);
            log(`Tracker ${trackerName} battery remaining: ${batteryData[BATTERY_REMAINING_INDEX]}%`);
        } catch {
            console.error(`Error converting battery data to hex for ${trackerName}: ${data}`);
        }
    } else if (gx6Enabled) {
        try {
            const batteryInfo = JSON.parse(data);
            log(`Tracker ${trackerName} remaining: ${batteryInfo["battery remaining"]}%`);
            log(`Tracker ${trackerName} voltage: ${batteryInfo["battery voltage"]}`);
            log(`Tracker ${trackerName} Status: ${batteryInfo["charge status"]}`);
            batteryData[BATTERY_REMAINING_INDEX] = batteryInfo["battery remaining"];
            batteryData[BATTERY_VOLTAGE_INDEX] = batteryInfo["battery voltage"];
            batteryData[CHARGE_STATUS_INDEX] = batteryInfo["charge status"];
        } catch (err) {
            console.error(`Error parsing battery data JSON for ${trackerName}: ${err}`);
        }
    }

    trackerBattery.set(trackerName, batteryData);
    haritora.emit("battery", trackerName, ...batteryData);
}


/**
 * Processes the tracker settings data received from the dongle by the tracker.
 * Support: GX6
 * 
 * @function processTrackerSettings
 * @param {string} data - The data to process.
 * @param {string} trackerName - The name of the tracker.
 * @fires haritora#settings
**/

function processTrackerSettings(data, trackerName) {
    const SENSOR_MODE_INDEX = 6;
    const POSTURE_DATA_RATE_INDEX = 5;
    const SENSOR_AUTO_CORRECTION_INDEX = 10;
    const ANKLE_MOTION_DETECTION_INDEX = 13;
    try {
        const sensorMode = parseInt(data[SENSOR_MODE_INDEX]);
        const postureDataRate = parseInt(data[POSTURE_DATA_RATE_INDEX]);
        const sensorAutoCorrection = parseInt(data[SENSOR_AUTO_CORRECTION_INDEX]);
        const ankleMotionDetection = parseInt(data[ANKLE_MOTION_DETECTION_INDEX]);

        const sensorModeText = sensorMode === 0 ? "2" : "1";
        const postureDataRateText = postureDataRate === 0 ? "50" : "100";
        const ankleMotionDetectionText = ankleMotionDetection === 0 ? "false" : "true";

        const sensorAutoCorrectionComponents = [];
        if (sensorAutoCorrection & 1) sensorAutoCorrectionComponents.push("Accel");
        if (sensorAutoCorrection & 2) sensorAutoCorrectionComponents.push("Gyro");
        if (sensorAutoCorrection & 4) sensorAutoCorrectionComponents.push("Mag");

        const sensorAutoCorrectionText = sensorAutoCorrectionComponents.join(", ");

        log(`Tracker ${trackerName} settings:`);
        log(`Sensor Mode: ${sensorModeText}`);
        log(`Posture Data Transfer Rate: ${postureDataRateText}`);
        log(`Sensor Auto Correction: ${sensorAutoCorrectionText}`);
        log(`Ankle Motion Detection: ${ankleMotionDetectionText}`);
        log(`Raw data: ${data}`);

        if (!trackerSettings.has(trackerName) || trackerSettings.get(trackerName) !== data) {
            trackerSettings.set(trackerName, data);
            haritora.emit("settings", trackerName, sensorModeText, postureDataRateText, sensorAutoCorrectionComponents, ankleMotionDetectionText);
        }
    } catch (error) {
        console.error(`Error processing tracker settings for ${trackerName}:`, error);
    }
}


/**
 * Processes the info data received from the tracker or dongle.
 * Support: GX6 (for bluetooth, see getDeviceInfo())
 * 
 * @function processInfoData
 * @param {string} data - The data to process.
 * @param {string} trackerName - The name of the tracker.
 * @fires haritora#info
**/

function processInfoData(data, trackerName) {
    if (!gx6Enabled) return false;

    let type = null;
    let version = null;
    let model = null;
    let serial = null;

    try {
        log(`Processing info data for ${trackerName}...`);
        const info = JSON.parse(data);
        version = info["version"];
        model = info["model"];
        serial = info["serial no"];

        if (trackerName === "(DONGLE)") {
            type = "dongle";
        } else {
            type = "tracker";
        }

        let prefix = type === "dongle" ? "Dongle" : `Tracker ${trackerName}`;
        log(`${prefix} version: ${version}`);
        log(`${prefix} model: ${model}`);
        log(`${prefix} serial: ${serial}`);
        
        deviceInformation.set(trackerName, info);
    } catch (err) {
        console.error(`Error processing info data:\n${err}`);
    }

    haritora.emit("info", type, version, model, serial);
}


function log(message) {
    if (debug) console.log(message);
}



export { HaritoraXWireless };