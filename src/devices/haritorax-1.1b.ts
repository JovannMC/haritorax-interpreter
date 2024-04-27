"use strict"

import { Buffer } from "buffer";
import { EventEmitter } from "events";
import Quaternion from "quaternion";
import { GX } from "../mode/gx";

let gx: GX;

let debug = 0;
let printTrackerIMUData = false;

let haritora: HaritoraX11b = undefined;

export default class HaritoraX11b extends EventEmitter {
    constructor(debugMode = 0, printTrackerIMUProcessing = false) {
        super();
        debug = debugMode;
        printTrackerIMUData = printTrackerIMUProcessing;
        haritora = this;
        log(`Set debug mode for HaritoraXWireless: ${debug}`);
        log(`Print tracker IMU processing: ${printTrackerIMUData}`);
    }

    /**
     * Starts the connection to the trackers with the specified mode.
     *
     * @param {string} connectionMode - Connect to the trackers with the specified mode (GX6 or bluetooth).
     * @param {string[]} [portNames] - The port names to connect to. (GX6 only)
     *
     * @example
     * device.startConnection("gx");
     **/
    startConnection(portNames?: string[]) {
        gx = new GX(debug);
        gx.startConnection(portNames);
    }

    /**
     * Stops the connection to the trackers with the specified mode.
     *
     * @param {string} connectionMode - Disconnect from the trackers with the specified mode (gx6 or bluetooth).
     *
     * @example
     * device.stopConnection("gx");
     **/
    stopConnection() {
        gx.stopConnection();
    }

    parseData(data: string) {
        processIMUData(data, "CUSTOM");
    }

}

/*gx.on(
    "data",
    (
        trackerName: string,
        port: string,
        portId: string,
        identifier: string,
        portData: string
    ) => {
        processIMUData(portData, trackerName);
    }
);*/

function processIMUData(data: string, trackerName: string) {
    // Decode and log the data
    try {
        const { rotation, gravity, ankle, magStatus } = decodeIMUPacket(
            data,
            trackerName
        );

        if (printTrackerIMUData) {
            log(
                `Tracker ${trackerName} rotation: (${rotation.x.toFixed(
                    5
                )}, ${rotation.y.toFixed(5)}, ${rotation.z.toFixed(
                    5
                )}, ${rotation.w.toFixed(5)})`
            );
            log(
                `Tracker ${trackerName} gravity: (${gravity.x.toFixed(
                    5
                )}, ${gravity.y.toFixed(5)}, ${gravity.z.toFixed(5)})`
            );
            if (ankle) log(`Tracker ${trackerName} ankle: ${ankle}`);
            if (magStatus)
                log(`Tracker ${trackerName} magnetometer status: ${magStatus}`);
        }

        haritora.emit("imu", trackerName, rotation, gravity, ankle);
        haritora.emit("mag", trackerName, magStatus);
    } catch (err) {
        error(`Error decoding tracker ${trackerName} IMU packet data: ${err}`);
    }
}

/**
 * The logic to decode the IMU packet received by the dongle.
 * Thanks to sim1222 and BracketProto's project for helping with the math and acceleration/drift code respectively :p
 * @see {@link https://github.com/sim1222/haritorax-slimevr-bridge/}
 * @see {@link https://github.com/OCSYT/SlimeTora/}
 **/

const DRIFT_INTERVAL = 15000;
let trackerAccel: { [key: string]: any } = {};
let trackerRotation: { [key: string]: any } = {};
let driftValues: { [key: string]: any } = {};
let calibrated: { [key: string]: any } = {};
let startTimes: { [key: string]: any } = {};
let initialRotations: { [key: string]: any } = {};

function decodeIMUPacket(data: string, trackerName: string) {
    try {
        if (data.length < 14) {
            throw new Error("Too few bytes to decode IMU packet");
        }

        const elapsedTime = Date.now() - startTimes[trackerName];

        const buffer = Buffer.from(data, "base64");
        const rotationX = buffer.readInt16LE(0);
        const rotationY = buffer.readInt16LE(2);
        const rotationZ = buffer.readInt16LE(4);
        const rotationW = buffer.readInt16LE(6);

        const gravityRawX = buffer.readInt16LE(8);
        const gravityRawY = buffer.readInt16LE(10);
        const gravityRawZ = buffer.readInt16LE(12);

        let ankle =
            data.slice(-2) !== "=="
                ? buffer.readInt16LE(buffer.length - 2)
                : undefined;

        let magStatus = undefined;
        if (!trackerName.startsWith("HaritoraX")) {
            const magnetometerData = data.charAt(data.length - 5);

            switch (magnetometerData) {
                case "A":
                    magStatus = "red";
                    break;
                case "B":
                    magStatus = "red";
                    break;
                case "C":
                    magStatus = "yellow";
                    break;
                case "D":
                    magStatus = "green";
                    break;
                default:
                    magStatus = "unknown";
                    break;
            }
        }

        const rotation = {
            x: (rotationX / 180.0) * 0.01,
            y: (rotationY / 180.0) * 0.01,
            z: (rotationZ / 180.0) * 0.01 * -1.0,
            w: (rotationW / 180.0) * 0.01 * -1.0,
        };
        trackerRotation[trackerName] = rotation;

        const gravityRaw = {
            x: gravityRawX / 256.0,
            y: gravityRawY / 256.0,
            z: gravityRawZ / 256.0,
        };
        trackerAccel[trackerName] = gravityRaw;

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

        if (elapsedTime >= DRIFT_INTERVAL) {
            if (!calibrated[trackerName]) {
                calibrated[trackerName] = {
                    pitch: driftValues[trackerName].pitch,
                    roll: driftValues[trackerName].roll,
                    yaw: driftValues[trackerName].yaw,
                };
            }
        }

        if (elapsedTime < DRIFT_INTERVAL) {
            if (!driftValues[trackerName]) {
                driftValues[trackerName] = { pitch: 0, roll: 0, yaw: 0 };
            }

            const rotationDifference = calculateRotationDifference(
                new Quaternion(
                    initialRotations[trackerName].w,
                    initialRotations[trackerName].x,
                    initialRotations[trackerName].y,
                    initialRotations[trackerName].z
                ).toEuler("XYZ"),
                new Quaternion(
                    rotation.w,
                    rotation.x,
                    rotation.y,
                    rotation.z
                ).toEuler("XYZ")
            );

            const prevMagnitude = Math.sqrt(
                driftValues[trackerName].pitch ** 2 +
                    driftValues[trackerName].roll ** 2 +
                    driftValues[trackerName].yaw ** 2
            );
            const currMagnitude = Math.sqrt(
                rotationDifference.pitch ** 2 +
                    rotationDifference.roll ** 2 +
                    rotationDifference.yaw ** 2
            );

            if (currMagnitude > prevMagnitude) {
                driftValues[trackerName] = rotationDifference;
                log(driftValues[trackerName]);
            }
        }

        if (elapsedTime >= DRIFT_INTERVAL && calibrated) {
            const driftCorrection = {
                pitch:
                    (calibrated[trackerName].pitch *
                        (elapsedTime / DRIFT_INTERVAL)) %
                    (2 * Math.PI),
                roll:
                    (calibrated[trackerName].roll *
                        (elapsedTime / DRIFT_INTERVAL)) %
                    (2 * Math.PI),
                yaw:
                    (calibrated[trackerName].yaw *
                        (elapsedTime / DRIFT_INTERVAL)) %
                    (2 * Math.PI),
            };

            const rotQuat = new Quaternion([
                rotation.w,
                rotation.x,
                rotation.y,
                rotation.z,
            ]);

            const rotationDriftCorrected = RotateAround(
                rotQuat,
                trackerAccel[trackerName],
                driftCorrection.yaw
            );

            log("Applied drift fix");

            return {
                rotation: {
                    x: rotationDriftCorrected.x,
                    y: rotationDriftCorrected.y,
                    z: rotationDriftCorrected.z,
                    w: rotationDriftCorrected.w,
                },
                gravity,
                ankle,
                magStatus,
            };
        }

        return { rotation, gravity, ankle, magStatus };
    } catch (error: any) {
        throw new Error("Error decoding IMU packet: " + error.message);
    }
}

function RotateAround(
    quat: Quaternion,
    vector: { x: number; y: number; z: number },
    angle: number
) {
    // Create a copy of the input quaternion
    var initialQuaternion = new Quaternion(quat.w, quat.x, quat.y, quat.z);

    // Create a rotation quaternion
    var rotationQuaternion = Quaternion.fromAxisAngle(
        [vector.x, vector.y, vector.z],
        angle
    );

    // Apply the rotation to the copy of the input quaternion
    initialQuaternion = initialQuaternion.mul(rotationQuaternion).normalize();

    // Return the resulting quaternion as a dictionary
    return {
        x: initialQuaternion.x,
        y: initialQuaternion.y,
        z: initialQuaternion.z,
        w: initialQuaternion.w,
    };
}

function calculateRotationDifference(
    prevRotation: number[],
    currentRotation: number[]
) {
    const pitchDifferenceRad = currentRotation[0] - prevRotation[0];
    const rollDifferenceRad = currentRotation[1] - prevRotation[1];
    const yawDifferenceRad = currentRotation[2] - prevRotation[2];

    return {
        pitch: pitchDifferenceRad,
        roll: rollDifferenceRad,
        yaw: yawDifferenceRad,
    };
}

/*
 * Helper functions
 */

function log(message: string) {
    let emittedMessage = undefined;
    if (debug === 1) {
        emittedMessage = `(haritorax-interpreter) - ${message}`;
        console.log(emittedMessage);
        haritora.emit("log", emittedMessage);
    } else if (debug === 2) {
        const stack = new Error().stack;
        const callerLine = stack.split("\n")[2];
        const callerName = callerLine.match(/at (\S+)/)[1];
        const lineNumber = callerLine.match(/:(\d+):/)[1];

        emittedMessage = `(haritorax-interpreter) - ${callerName} (line ${lineNumber}) || ${message}`;
        console.log(emittedMessage);
        haritora.emit("log", emittedMessage);
    }
}

function error(message: string) {
    let emittedError = undefined;
    if (debug === 1) {
        emittedError = `(haritorax-interpreter) - ${message}`;
        console.error(emittedError);
        haritora.emit("logError", emittedError);
    } else if (debug === 2) {
        const stack = new Error().stack;
        const callerLine = stack.split("\n")[2];
        const callerName = callerLine.match(/at (\S+)/)[1];
        const lineNumber = callerLine.match(/:(\d+):/)[1];

        emittedError = `(haritorax-interpreter) - ${callerName} (line ${lineNumber}) || ${message}`;
        console.error(emittedError);
        haritora.emit("logError", emittedError);
    }
}

export { HaritoraX11b };
