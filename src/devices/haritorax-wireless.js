"use strict";

import { EventEmitter } from "events";
import GX6 from "../mode/gx6.js";
import bluetooth from "../mode/bluetooth.js";

const gx6 = new GX6();

export default class HaritoraXWireless extends EventEmitter {
    constructor() {
        super();
        this.gx6 = gx6;
        this.bluetooth = new bluetooth();
    }

    startConnection(connectionMode) {
        if (connectionMode === "gx6") {
            this.gx6.startConnection();
        } else if (connectionMode === "bluetooth") {
            this.bluetooth.startConnection();
        }
    }

    stopConnection(connectionMode) {
        if (connectionMode === "gx6") {
            this.gx6.stopConnection();
        } else if (connectionMode === "bluetooth") {
            this.bluetooth.stopConnection();
        }
    }

    // ! To remove after testing
    getTrackers() {
        return this.gx6.getTrackers();
    }

    getTrackersInPort(port) {
        return this.gx6.getTrackersInPort(port);
    }

    getTrackerInfo(tracker) {
        return this.gx6.getTrackerInfo(tracker);
    }

    getPartFromInfo(trackerId, port) {
        return this.gx6.getPartFromInfo(trackerId, port);
    }

    getActivePorts() {
        return this.gx6.getActivePorts();
    }
}

gx6.on("data", (port, data) => {
    const splitData = data.toString().split(/:(.+)/);
    const identifier = splitData[0];
    const value = splitData[1];
    const trackerIdMatch = identifier.match(/\d/);
    const trackerId = trackerIdMatch ? trackerIdMatch[0] : "(DONGLE)";

    // Check what body part the tracker is assigned to
    let bodyPart = gx6.getPartFromInfo(trackerId, port);
    
    if (identifier.includes("X")) {
        // IMU data
        processIMUData(value, bodyPart);
    } else if (identifier.includes("a")) {
        // Tracker data
        processTrackerData(value, bodyPart);
    } else if (identifier.includes("r")) {
        // Tracker button info
        console.log(`${port} - Button Data for tracker ${bodyPart}: ${value}`);
    } else if (identifier.includes("v")) {
        // Tracker battery info
        console.log(`${port} - Battery Data for tracker ${bodyPart}: ${value}`);
    } else if (identifier.includes("o")) {
        // Tracker settings
        console.log(`${port} - Settings Data for tracker ${bodyPart}: ${value}`);
    } else if (identifier.includes("i")) {
        // Tracker info
        console.log(`${port} - Info Data for tracker ${bodyPart}: ${value}`);
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

function logIMUData(bodyPart, rotation, gravity, ankle) {
    console.log(`Tracker ${bodyPart} rotation: (${rotation.x.toFixed(5)}, ${rotation.y.toFixed(5)}, ${rotation.z.toFixed(5)}, ${rotation.w.toFixed(5)})`);
    console.log(`Tracker ${bodyPart} gravity: (${gravity.x.toFixed(5)}, ${gravity.y.toFixed(5)}, ${gravity.z.toFixed(5)})`);
    console.log(`Tracker ${bodyPart} ankle: ${ankle}`);
}

function processIMUData(data, bodyPart) {
    // Check if the data is valid
    if (!(data && data.length === 24)) {
        console.log(`Invalid IMU packet for tracker ${bodyPart}: ${data}`);
        return;
    }

    // Decode and log the data
    try {
        const { rotation, gravity, ankle } = decodeIMUPacket(data);
        logIMUData(bodyPart, rotation, gravity, ankle);

        gx6.emit("imu", bodyPart, rotation, gravity, ankle);
    } catch (err) {
        console.log(`Error decoding tracker ${bodyPart} IMU packet: ${data}`);
    }
}

/*
* Tracker data
* Currently unsure what other data a0/a1 could represent other than trying to find the trackers,
* I see other values for it too. This could also be used to report calibration data when running the
* calibration through the software. Also, could be if the tracker is just turned on/off.
*/

function processTrackerData(data, bodyPart) {
    if (data.trim() === '7f7f7f7f7f7f') {
        console.log(`Searching for tracker ${bodyPart}...`);
    } else {
        console.log(`Other tracker ${bodyPart} data processed: ${data}`);
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

        const buffer = Buffer.from(data, 'base64');
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