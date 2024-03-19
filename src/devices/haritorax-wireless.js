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
        if (bluetoothEnabled) {
            log("Setting tracker settings for bluetooth is not supported yet.");
            return false;
        } else {
            log(`Setting tracker settings for ${trackerName}...`);
            const sensorModeBit = sensorMode === 1 ? "1" : "0"; // If a value other than 1, default to mode 2
            const postureDataRateBit = fpsMode === 50 ? "0" : "1"; // If a value other than 1, default to 100FPS
            const ankleMotionDetectionBit = ankleMotionDetection ? "1" : "0"; // If a value other than 1, default to disabled
            let sensorAutoCorrectionBit = 0;
            if (sensorAutoCorrection.includes("accel")) sensorAutoCorrectionBit |= 0x01;
            if (sensorAutoCorrection.includes("gyro")) sensorAutoCorrectionBit |= 0x02;
            if (sensorAutoCorrection.includes("mag")) sensorAutoCorrectionBit |= 0x04;

            let hexValue = null;
            let modeValueBuffer = null;
            
            if (trackerName === "rightKnee" || trackerName === "hip" || trackerName === "leftKnee") {
                const entries = Array.from(trackerSettings.entries());
                const currentIndex = entries.findIndex(([key]) => key === trackerName);

                hexValue = `00000${postureDataRateBit}${sensorModeBit}010${sensorAutoCorrectionBit}00${ankleMotionDetectionBit}`;
                if (currentIndex !== -1 && currentIndex < entries.length - 1) {
                    const nextKey = entries[currentIndex + 1][0];
                    let nextValue = trackerSettings.get(nextKey);
                    modeValueBuffer = Buffer.from("o0:" + hexValue + "\r\n" + "o1:" + nextValue + "\r\n", "utf-8");
                }
                
                log(`${trackerName} - Calculated hex value: ${hexValue}`);
            } else if (trackerName === "rightAnkle" || trackerName === "chest" || trackerName === "leftAnkle") {
                const entries = Array.from(trackerSettings.entries());
                const currentIndex = entries.findIndex(([key]) => key === trackerName);

                hexValue = `00000${postureDataRateBit}${sensorModeBit}010${sensorAutoCorrectionBit}00${ankleMotionDetectionBit}`;
                if (currentIndex !== -1 && currentIndex > 0) {
                    const previousKey = entries[currentIndex - 1][0];
                    let previousValue = trackerSettings.get(previousKey);
                    modeValueBuffer = Buffer.from("o0:" + previousValue + "\r\n" + "o1:" + hexValue + "\r\n", "utf-8");
                }

                log(`${trackerName} - Calculated hex value: ${hexValue}`);
            } else {
                log(`Invalid tracker name: ${trackerName}`);
                return;
            }

            log(`Setting the following settings onto tracker ${trackerName}:`);
            log(`FPS mode: ${fpsMode}`);
            log(`Sensor mode: ${sensorMode}`);
            log(`Sensor auto correction: ${sensorAutoCorrection}`);
            log(`Ankle motion detection: ${ankleMotionDetection}`);
            log(`Raw hex data calculated to be sent: ${hexValue}`);

            try {
                log(`Sending tracker settings to ${trackerName}: ${modeValueBuffer.toString()}`);
                let ports = gx6.getActivePorts();
                let trackerInfo = gx6.getTrackerInfo(trackerName);
                let trackerPort = trackerInfo[1];

                ports[trackerPort].write(modeValueBuffer, (err) => {
                    if (err) {
                        console.error(`${trackerName} - Error writing data to serial port ${trackerPort}: ${err.message}`);
                    } else {
                        trackerSettings.set(trackerName, hexValue);
                        log(`${trackerName} - Data written to serial port ${trackerPort}: ${modeValueBuffer.toString()}`);
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
            log("Setting all tracker settings...");
            try {
                const sensorModeBit = sensorMode === 1 ? "1" : "0";
                const postureDataRateBit = fpsMode === 100 ? "1" : "0";
                let sensorAutoCorrectionBit = 0;
                if (sensorAutoCorrection.includes("accel")) sensorAutoCorrectionBit |= 0x01;
                if (sensorAutoCorrection.includes("gyro")) sensorAutoCorrectionBit |= 0x02;
                if (sensorAutoCorrection.includes("mag")) sensorAutoCorrectionBit |= 0x04;
                const ankleMotionDetectionBit = ankleMotionDetection ? "1" : "0";
    
                const hexValue = `00000${postureDataRateBit}${sensorModeBit}010${sensorAutoCorrectionBit}00${ankleMotionDetectionBit}`;
                const modeValueBuffer = Buffer.from("o0:" + hexValue + "\r\n" + "o1:" + hexValue + "\r\n", "utf-8");
    
                log("Setting the following settings onto all trackers:");
                log(`FPS mode: ${fpsMode}`);
                log(`Sensor mode: ${sensorMode}`);
                log(`Sensor auto correction: ${sensorAutoCorrection}`);
                log(`Ankle motion detection: ${ankleMotionDetection}`);
                log(`Raw hex data calculated to be sent: ${hexValue}`);
    
                let ports = gx6.getActivePorts();
                for (let trackerName of trackerSettings.keys()) {
                    let trackerInfo = gx6.getTrackerInfo(trackerName);
                    let trackerPort = trackerInfo[1];
    
                    ports[trackerPort].write(modeValueBuffer, (err) => {
                        if (err) {
                            console.error(`${trackerName} - Error writing data to serial port ${trackerPort}: ${err.message}`);
                        } else {
                            trackerSettings.set(trackerName, hexValue);
                            log(`${trackerName} - Data written to serial port ${trackerPort}: ${modeValueBuffer.toString()}`);
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
                if (service.uuid !== "180a") continue;
                for (let characteristic of service.characteristics) {
                    const promise = new Promise((resolve, reject) => {
                        characteristic.read((err, data) => {
                            if (err) {
                                reject(`Error reading characteristic for ${trackerName}: ${err}`);
                            } else {
                                switch (characteristic.uuid) {
                                case "2a28":
                                    version = data.toString("utf-8");
                                    break;
                                case "2a24":
                                    model = data.toString("utf-8");
                                    break;
                                case "2a25":
                                    serial = data.toString("utf-8");
                                    break;
                                }
                                resolve();
                            }
                        });
                    
                        setTimeout(() => reject(`Read operation for ${trackerName} timed out`), 5000);
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
        deviceInformation.set(trackerName, [version, model, serial]);
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
        if (trackerBattery.has(trackerName)) {
            let batteryRemaining = trackerBattery.get(trackerName)[0];
            let batteryVoltage = trackerBattery.get(trackerName)[1];
            let chargeStatus = trackerBattery.get(trackerName)[2];
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
    const identifier = splitData[0];
    const value = splitData[1];

    // Check if the identifier contains a number, if not, it's the dongle
    const trackerId = identifier.match(/\d/) ? identifier.match(/\d/)[0] : "(DONGLE)";

    // Check what body part the tracker is assigned to
    let trackerName = gx6.getPartFromInfo(trackerId, port);

    // If the tracker is not in the list of active devices, add it
    if (!activeDevices.includes(trackerName) && trackerName !== "(DONGLE)") activeDevices.push(trackerName);
    
    if (identifier.toLowerCase().includes("x") && trackerName !== "(DONGLE)") {
        // IMU data
    } else if (identifier.toLowerCase().includes("a") && trackerName !== "(DONGLE)") {
        // Tracker data
        processTrackerData(value, trackerName);
    } else if (identifier.toLowerCase().includes("r") && trackerName !== "(DONGLE)") {
        // Tracker button info
        processButtonData(value, trackerName);
    } else if (identifier.toLowerCase().includes("v") && trackerName !== "(DONGLE)") {
        // Tracker battery info
        processBatteryData(value, trackerName);
    } else if (identifier.toLowerCase().includes("o") && trackerName !== "(DONGLE)") {
        // Tracker settings
        processTrackerSettings(value, trackerName);
    } else if (identifier.toLowerCase().includes("i")) {
        // Tracker info
        processInfoData(value, trackerName);
    } else {
        log(`${port} - Unknown data from ${trackerName}: ${data}`);
    }
});

// TODO: magnetometer, add settings
bluetooth.on("data", (localName, service, characteristic, data) => {
    if (service == "Device Information") return;
    if (characteristic === "Sensor") {
        //processIMUData(data, localName);
    } else if (characteristic === "MainButton" || characteristic === "SecondaryButton") {
        processButtonData(data, localName, characteristic);
    } else if (characteristic === "BatteryLevel") {
        processBatteryData(data, localName);
    }/* else if (characteristic === "Settings") {
        // TODO - Process settings data, probably will need to be manually read and set
        //processTrackerSettings(data, localName);
    }*/ else {
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
    let mainButton = null;
    let subButton = null;

    if (bluetoothEnabled) {
        let currentButtons = trackerButtons.get(trackerName) || [0, 0];

        if (characteristic === "MainButton") {
            currentButtons[0] += 1;
        } else if (characteristic === "SecondaryButton") {
            currentButtons[1] += 1;
        }

        mainButton = currentButtons[0];
        subButton = currentButtons[1];
        trackerButtons.set(trackerName, currentButtons);
        haritora.emit("button", trackerName, mainButton, subButton, null);
    } else if (gx6Enabled) {
        // Character 1 turns 0 when the tracker is turning off/is off (1 when turning on/is on)
        // Characters 8, 9, 11, and 12 also indicate if tracker is being turned off/is off (all f's)
        mainButton = parseInt(data[6], 16); // 7th character (0-indexed)
        subButton = parseInt(data[9], 16); // 10th character (0-indexed)

        if (data[0] === "0" || data[7] === "f" || data[8] === "f" || data[10] === "f" || data[11] === "f") {
            log(`Tracker ${trackerName} is off/turning off...`);
            // last argument - false = turning off/is off
            haritora.emit("button", trackerName, mainButton, subButton, false);
            return true;
        }

        // last argument - true = turning on/is on
        haritora.emit("button", trackerName, mainButton, subButton, true);
    }

    trackerButtons.set(trackerName, [mainButton, subButton]);
    log(`Tracker ${trackerName} main button: ${mainButton}`);
    log(`Tracker ${trackerName} sub button: ${subButton}`);
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
    let batteryRemaining = null;
    let batteryVoltage = null;
    let chargeStatus = null;

    if (bluetoothEnabled) {
        // Can only get battery percentage from BT data (need to do more testing)
        // Also seems to like to jump up and down.. for some reason? Every (x) value seems to be correct, while the rest are off by 1-2%
        try {
            let batteryRemainingHex = Buffer.from(data, "base64").toString("hex");
            batteryRemaining = parseInt(batteryRemainingHex, 16);
            log(`Tracker ${trackerName} battery remaining: ${batteryRemaining}%`);
        } catch {
            console.error(`Error processing battery data for ${trackerName}: ${data}`);
        }
    } else if (gx6Enabled) {
        try {
            const batteryInfo = JSON.parse(data);
            log(`Tracker ${trackerName} remaining: ${batteryInfo["battery remaining"]}%`);
            log(`Tracker ${trackerName} voltage: ${batteryInfo["battery voltage"]}`);
            log(`Tracker ${trackerName} Status: ${batteryInfo["charge status"]}`);
            batteryRemaining = batteryInfo["battery remaining"];
            batteryVoltage = batteryInfo["battery voltage"];
            chargeStatus = batteryInfo["charge status"];
        } catch (err) {
            console.error(`Error processing battery data for ${trackerName}: ${err}`);
        }
    }

    trackerBattery.set(trackerName, [batteryRemaining, batteryVoltage, chargeStatus]);
    haritora.emit("battery", trackerName, batteryRemaining, batteryVoltage, chargeStatus);
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
    const sensorMode = parseInt(data[6]);
    const postureDataRate = parseInt(data[5]);
    const sensorAutoCorrection = parseInt(data[10]);
    const ankleMotionDetection = parseInt(data[13]);

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

    if (trackerSettings.has(trackerName) && trackerSettings.get(trackerName) !== data) trackerSettings.set(trackerName, data);

    
    haritora.emit("settings", trackerName, sensorModeText, postureDataRateText, sensorAutoCorrectionComponents, ankleMotionDetectionText);
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

    if (trackerName === "(DONGLE)") {
        type = "dongle";
        try {
            const dongleInfo = JSON.parse(data);
            log(`Dongle version: ${dongleInfo["version"]}`);
            log(`Dongle model: ${dongleInfo["model"]}`);
            log(`Dongle serial: ${dongleInfo["serial no"]}`);

            version = dongleInfo["version"];
            model = dongleInfo["model"];
            serial = dongleInfo["serial no"];
            
        } catch (err) {
            console.error(`Error processing dongle info data:\n${err}`);
        }
    } else {
        type = "tracker";
        try {
            const trackerInfo = JSON.parse(data);
            log(`Tracker ${trackerName} version: ${trackerInfo["version"]}`);
            log(`Tracker ${trackerName} model: ${trackerInfo["model"]}`);
            log(`Tracker ${trackerName} serial: ${trackerInfo["serial no"]}`);

            version = trackerInfo["version"];
            model = trackerInfo["model"];
            serial = trackerInfo["serial no"];

            deviceInformation.set(trackerName, trackerInfo);
        } catch (err) {
            console.error(`Error processing tracker info data:\n${err}`);
        }
    }
    haritora.emit("info", type, version, model, serial);
}



function log(message) {
    if (debug) console.log(message);
}



export { HaritoraXWireless };