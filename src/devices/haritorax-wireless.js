"use strict";

import { Buffer } from "buffer";
import { EventEmitter } from "events";
import GX6 from "../mode/gx6.js";
import Bluetooth from "../mode/bluetooth.js";

const gx6 = new GX6();
const bluetooth = new Bluetooth();

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

export default class HaritoraXWireless extends EventEmitter {
    startConnection(connectionMode) {
        if (connectionMode === "gx6") {
            gx6.startConnection();
        } else if (connectionMode === "bluetooth") {
            bluetooth.startConnection();
        }
    }

    stopConnection(connectionMode) {
        if (connectionMode === "gx6") {
            gx6.stopConnection();
        } else if (connectionMode === "bluetooth") {
            bluetooth.stopConnection();
        }
    }

    // ! To remove after testing
    getTrackers() {
        return gx6.getTrackers();
    }

    getTrackersInPort(port) {
        return gx6.getTrackersInPort(port);
    }

    getTrackerInfo(tracker) {
        return gx6.getTrackerInfo(tracker);
    }

    getPartFromInfo(trackerId, port) {
        return gx6.getPartFromInfo(trackerId, port);
    }

    getActivePorts() {
        return gx6.getActivePorts();
    }
}

gx6.on("data", (port, data) => {
    const splitData = data.toString().split(/:(.+)/);
    const identifier = splitData[0];
    const value = splitData[1];

    // Check if the identifier contains a number, if not, it's the dongle
    const trackerIdMatch = identifier.match(/\d/);
    const trackerId = trackerIdMatch ? trackerIdMatch[0] : "(DONGLE)";

    // Check what body part the tracker is assigned to
    let trackerName = gx6.getPartFromInfo(trackerId, port);
    
    if (identifier.includes("X")) {
        // IMU data
        processIMUData(value, trackerName);
    } else if (identifier.includes("a")) {
        // Tracker data
        processTrackerData(value, trackerName);
    } else if (identifier.includes("r") && trackerName !== "(DONGLE)") {
        // Tracker button info
        processButtonData(value, trackerName);
    } else if (identifier.includes("v")) {
        // Tracker battery info
        processBatteryData(value, trackerName);
    } else if (identifier.includes("o") && trackerName !== "(DONGLE)") {
        // Tracker settings
        processTrackerSettings(value, trackerName);
    } else if (identifier.includes("i")) {
        // Tracker info
        processInfoData(value, trackerName);
    } else {
        console.log(`${port} - Unknown data: ${data}`);
    }
});

/*
* Tracker data
* This is obviously the IMU tracking data, the juicy stuff. Ankle motion data also included (if enabled).
* Can be used to forward to other software such as SlimeVR's server!
* Rotation has: x, y, z, w
* Gravity has: x, y, z
* Ankle has: ? (unknown, assuming distance?)
*/

function logIMUData(trackerName, rotation, gravity, ankle) {
    console.log(`Tracker ${trackerName} rotation: (${rotation.x.toFixed(5)}, ${rotation.y.toFixed(5)}, ${rotation.z.toFixed(5)}, ${rotation.w.toFixed(5)})`);
    console.log(`Tracker ${trackerName} gravity: (${gravity.x.toFixed(5)}, ${gravity.y.toFixed(5)}, ${gravity.z.toFixed(5)})`);
    if (ankle) console.log(`Tracker ${trackerName} ankle: ${ankle}`);
}

function processIMUData(data, trackerName) {
    // Check if the data is valid
    if (!data || !data.length === 24) {
        console.log(`Invalid IMU packet for tracker ${trackerName}: ${data}`);
        return;
    }

    // Decode and log the data
    try {
        const { rotation, gravity, ankle } = decodeIMUPacket(data);
        logIMUData(trackerName, rotation, gravity, ankle);

        gx6.emit("imu", trackerName, rotation, gravity, ankle);
    } catch (err) {
        console.log(`Error decoding tracker ${trackerName} IMU packet: ${data}`);
    }
}

/*
* Decoding IMU packet
* The logic to decode the IMU packet received by the dongle. Thanks to sim1222's project for helping with the math :p
* https://github.com/sim1222/haritorax-slimevr-bridge/
*/

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
        if (data.slice(-2) !== "==") {
            // or buffer.length - 2
            ankle = buffer.readInt16LE(14);
        }

        return { rotation, gravity, ankle };
    } catch (error) {
        throw new Error("Error decoding IMU packet: " + error.message);
    }
}

/*
* Tracker data
* Currently unsure what other data a0/a1 could represent other than trying to find the trackers,
* I see other values for it too. This could also be used to report calibration data when running the
* calibration through the software. Also, could be if the tracker is just turned on/off.
*/

function processTrackerData(data, trackerName) {
    if (data === "7f7f7f7f7f7f") {
        console.log(`Searching for tracker ${trackerName}...`);
    } else {
        console.log(`Tracker ${trackerName} other data processed: ${data}`);
    }

    // TODO - Find out what the other data represents, then add to emitter
    gx6.emit("tracker", trackerName, data);
}

/*
* Tracker button data
* Here we're processing the button pressed, the 7th/10th character in the decoded data is the
* amount of times the main/sub buttons were pressed respectively.
*/

function processButtonData(data, trackerName) {
    // Character 1 turns 0 when the tracker is turning off/is off (1 when turning on/is on)
    // Characters 8, 9, 11, and 12 also indicate if tracker is being turned off/is off (all f's)
    let mainButton = parseInt(data[6], 16); // 7th character (0-indexed)
    let subButton = parseInt(data[9], 16); // 10th character (0-indexed)
    trackerButtons.set(trackerName, [mainButton, subButton]);
    console.log(`Tracker ${trackerName} main button: ${mainButton}`);
    console.log(`Tracker ${trackerName} sub button: ${subButton}`);

    if (data[0] === "0" || data[7] === "f" || data[8] === "f" || data[10] === "f" || data[11] === "f") {
        console.log(`Tracker ${trackerName} is off/turning off...`);
        // last argument - false = turning off/is off
        gx6.emit("button", trackerName, mainButton, subButton, false);
        return;
    }

    // last argument - false = turning off/is off
    gx6.emit("button", trackerName, mainButton, subButton, true);
}

/*
* Tracker battery info
* This contains the information about the battery, voltage, and charge status of the tracker.
* Can be used to forward to other software such as SlimeVR's server!
*/

function processBatteryData(data, trackerName) {
    let batteryRemaining;
    let batteryVoltage;
    let chargeStatus;

    try {
        const batteryInfo = JSON.parse(data);
        console.log(`Tracker ${trackerName} remaining: ${batteryInfo["battery remaining"]}%`);
        console.log(`Tracker ${trackerName} voltage: ${batteryInfo["battery voltage"]}`);
        console.log(`Tracker ${trackerName} Status: ${batteryInfo["charge status"]}`);
        batteryRemaining = batteryInfo["battery remaining"];
        batteryVoltage = batteryInfo["battery voltage"];
        chargeStatus = batteryInfo["charge status"];
    } catch (err) {
        console.log(`Error processing battery data: ${err}`);
    }

    gx6.emit("battery", trackerName, batteryRemaining, batteryVoltage, chargeStatus);
}

/*
*   Tracker settings
*/

function processTrackerSettings(data, trackerName) {
    const sensorMode = parseInt(data[6]);
    const postureDataRate = parseInt(data[5]);
    const sensorAutoCorrection = parseInt(data[10]);
    const ankleMotionDetection = parseInt(data[13]);

    const sensorModeText = sensorMode === 0 ? "Mode 2" : "Mode 1";
    const postureDataRateText = postureDataRate === 0 ? "50FPS" : "100FPS";
    const ankleMotionDetectionText = ankleMotionDetection === 0 ? "Disabled" : "Enabled";

    const sensorAutoCorrectionComponents = [];
    if (sensorAutoCorrection & 1) {
        sensorAutoCorrectionComponents.push("Accel");
    }
    if (sensorAutoCorrection & 2) {
        sensorAutoCorrectionComponents.push("Gyro");
    }
    if (sensorAutoCorrection & 4) {
        sensorAutoCorrectionComponents.push("Mag");
    }

    const sensorAutoCorrectionText = sensorAutoCorrectionComponents.join(", ");

    console.log(`Tracker ${trackerName} settings:`);
    console.log(`Sensor Mode: ${sensorModeText}`);
    console.log(`Posture Data Transfer Rate: ${postureDataRateText}`);
    console.log(`Sensor Auto Correction: ${sensorAutoCorrectionText}`);
    console.log(`Ankle Motion Detection: ${ankleMotionDetectionText}`);
    console.log(`Raw data: ${data}`);

    if (trackerSettings.has(trackerName) && trackerSettings.get(trackerName) !== data) {
        trackerSettings.set(trackerName, data);
    }

    gx6.emit("settings", trackerName, sensorModeText, postureDataRateText, sensorAutoCorrectionComponents, ankleMotionDetectionText);
}

function setTrackerSettings(trackerName, fpsMode, sensorMode, sensorAutoCorrection, ankleMotionDetection) {
    console.log(`Setting tracker settings for ${trackerName}...`);
    const sensorModeBit = sensorMode === 1 ? "1" : "0"; // If a value other than 1, default to mode 2
    const postureDataRateBit = fpsMode === 50 ? "0" : "1"; // If a value other than 1, default to 100FPS
    const ankleMotionDetectionBit = ankleMotionDetection ? "1" : "0"; // If a value other than 1, default to disabled
    let sensorAutoCorrectionBit = 0;
    if (sensorAutoCorrection.includes("Accel")) sensorAutoCorrectionBit |= 0x01;
    if (sensorAutoCorrection.includes("Gyro")) sensorAutoCorrectionBit |= 0x02;
    if (sensorAutoCorrection.includes("Mag")) sensorAutoCorrectionBit |= 0x04;

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
        
        console.log(`${trackerName} - Calculated hex value: ${hexValue}`);
    } else if (trackerName === "rightAnkle" || trackerName === "chest" || trackerName === "leftAnkle") {
        const entries = Array.from(trackerSettings.entries());
        const currentIndex = entries.findIndex(([key]) => key === trackerName);

        hexValue = `00000${postureDataRateBit}${sensorModeBit}010${sensorAutoCorrectionBit}00${ankleMotionDetectionBit}`;
        if (currentIndex !== -1 && currentIndex > 0) {
            const previousKey = entries[currentIndex - 1][0];
            let previousValue = trackerSettings.get(previousKey);
            modeValueBuffer = Buffer.from("o0:" + previousValue + "\r\n" + "o1:" + hexValue + "\r\n", "utf-8");
        }

        console.log(`${trackerName} - Calculated hex value: ${hexValue}`);
    } else {
        console.log(`Invalid tracker name: ${trackerName}`);
        return;
    }

    console.log(`Setting the following settings onto tracker ${trackerName}:`);
    console.log(`FPS mode: ${fpsMode}`);
    console.log(`Sensor mode: ${sensorMode}`);
    console.log(`Sensor auto correction: ${sensorAutoCorrection}`);
    console.log(`Ankle motion detection: ${ankleMotionDetection}`);
    console.log(`Raw hex data calculated to be sent: ${hexValue}`);

    try {
        console.log(`Sending tracker settings to ${trackerName}: ${modeValueBuffer.toString()}`);
        let ports = gx6.getActivePorts();
        let trackerInfo = gx6.getTrackerInfo(trackerName);
        let trackerPort = trackerInfo[1];

        ports[trackerPort].write(modeValueBuffer, (err) => {
            if (err) {
                console.error(`${trackerName} - Error writing data to serial port ${trackerPort}: ${err.message}`);
            } else {
                trackerSettings.set(trackerName, hexValue);
                console.log(`${trackerName} - Data written to serial port ${trackerPort}: ${modeValueBuffer.toString()}`);
            }
        });
    } catch (error) {
        console.error(`Error sending tracker settings: ${error.message}`);
    }

    gx6.emit("settings", trackerName, sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection);
}

function setAllTrackerSettings(fpsMode, sensorMode, sensorAutoCorrection, ankleMotionDetection) {
    try {
        const sensorModeBit = sensorMode === 1 ? "1" : "0";
        const postureDataRateBit = fpsMode === 100 ? "1" : "0";
        let sensorAutoCorrectionBit = 0;
        if (sensorAutoCorrection.includes("Accel")) sensorAutoCorrectionBit |= 0x01;
        if (sensorAutoCorrection.includes("Gyro")) sensorAutoCorrectionBit |= 0x02;
        if (sensorAutoCorrection.includes("Mag")) sensorAutoCorrectionBit |= 0x04;
        const ankleMotionDetectionBit = ankleMotionDetection ? "1" : "0";

        const hexValue = `00000${postureDataRateBit}${sensorModeBit}010${sensorAutoCorrectionBit}00${ankleMotionDetectionBit}`;
        const modeValueBuffer = Buffer.from("o0:" + hexValue + "\r\n" + "o1:" + hexValue + "\r\n", "utf-8");

        console.log("Setting the following settings onto all trackers:");
        console.log(`FPS mode: ${fpsMode}`);
        console.log(`Sensor mode: ${sensorMode}`);
        console.log(`Sensor auto correction: ${sensorAutoCorrection}`);
        console.log(`Ankle motion detection: ${ankleMotionDetection}`);
        console.log(`Raw hex data calculated to be sent: ${hexValue}`);

        let ports = gx6.getActivePorts();
        for (let trackerName of trackerSettings.keys()) {
            let trackerInfo = gx6.getTrackerInfo(trackerName);
            let trackerPort = trackerInfo[1];

            ports[trackerPort].write(modeValueBuffer, (err) => {
                if (err) {
                    console.error(`${trackerName} - Error writing data to serial port ${trackerPort}: ${err.message}`);
                } else {
                    trackerSettings.set(trackerName, hexValue);
                    console.log(`${trackerName} - Data written to serial port ${trackerPort}: ${modeValueBuffer.toString()}`);
                }
            });
        }
    } catch (error) {
        console.error("Error sending tracker settings:", error.message);
    }

    for (let trackerName of trackerSettings.keys()) {
        gx6.emit("settings", trackerName, sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection);
    }
}

function processInfoData(data, trackerName) {
    let type;
    let version;
    let model;
    let serial;

    if (trackerName === "(DONGLE)") {
        type = "dongle";
        try {
            const dongleInfo = JSON.parse(data);
            console.log(`Dongle version: ${dongleInfo["version"]}`);
            console.log(`Dongle model: ${dongleInfo["model"]}`);
            console.log(`Dongle serial: ${dongleInfo["serial no"]}`);

            version = dongleInfo["version"];
            model = dongleInfo["model"];
            serial = dongleInfo["serial no"];
        } catch (err) {
            console.log(`Error processing dongle info data: ${err}`);
        }
    } else {
        type = "tracker";
        try {
            const trackerInfo = JSON.parse(data);
            console.log(`Tracker ${trackerName} version: ${trackerInfo["version"]}`);
            console.log(`Tracker ${trackerName} model: ${trackerInfo["model"]}`);
            console.log(`Tracker ${trackerName} serial: ${trackerInfo["serial no"]}`);

            version = trackerInfo["version"];
            model = trackerInfo["model"];
            serial = trackerInfo["serial no"];
        } catch (err) {
            console.log(`Error processing tracker info data: ${err}`);
        }
    }

    gx6.emit("info", type, version, model, serial);
}

export { HaritoraXWireless, setTrackerSettings, setAllTrackerSettings };