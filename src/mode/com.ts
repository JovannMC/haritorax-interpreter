"use strict";

import { autoDetect } from "@serialport/bindings-cpp";
import { ReadlineParser } from "@serialport/parser-readline";
import { SerialPortStream } from "@serialport/stream";
import { EventEmitter } from "events";
import { BTSPP } from "../libs/btspp";
import { TrackerModel } from "../types";

const Binding = autoDetect();

let main: COM = undefined;
let btspp: BTSPP = undefined;

const BAUD_RATE = 500000; // from the haritora_setting.json in the HaritoraConfigurator

// For HaritoraX Wireless
const trackerAssignment: Map<string, string[]> = new Map([
    // tracker part, [tracker id, port, port id]
    ["DONGLE", ["0", null, null]],
    ["chest", ["1", "", ""]],
    ["leftKnee", ["2", "", ""]],
    ["leftAnkle", ["3", "", ""]],
    ["rightKnee", ["4", "", ""]],
    ["rightAnkle", ["5", "", ""]],
    ["hip", ["6", "", ""]],
    ["leftElbow", ["7", "", ""]],
    ["rightElbow", ["8", "", ""]],
    ["leftWrist", ["9", "", ""]],
    ["rightWrist", ["10", "", ""]],
    ["head", ["11", "", ""]],
    ["leftFoot", ["12", "", ""]],
    ["rightFoot", ["13", "", ""]],
]);

const dongles = [
    { name: "GX2", vid: "1915", pid: "520F" },
    { name: "GX6", vid: "04DA", pid: "3F18" },
];

const portChannels: { [key: string]: number } = {};

// Stores the ports that are currently active as objects for access later
let activePorts: ActivePorts = {};
let trackerModelEnabled: string;
let heartbeatInterval = 5000; // in milliseconds
let retryConnectionInterval = 5000; // in milliseconds
let printWrites = true;

export default class COM extends EventEmitter {
    constructor(trackerModel: string, heartbeat = 5000, printSerialWrites = false, retryInterval = 5000) {
        super();
        main = this;
        trackerModelEnabled = trackerModel;
        heartbeatInterval = heartbeat;
        printWrites = printSerialWrites;
        retryConnectionInterval = retryInterval;
        btspp = new BTSPP();
        log(`Initialized COM module with settings: ${trackerModelEnabled} ${heartbeatInterval}`);

        btspp.on("log", (msg) => log(msg));
        btspp.on("logError", (err) => error(err.message, err.exceptional));
    }

    async isDeviceAvailable() {
        const ports = await Binding.list();
        const btsppDevices = await btspp.getPairedDevices();
        const allDevices = btsppDevices ? [...dongles, ...btsppDevices] : [...dongles];

        for (const device of allDevices) {
            if (
                ports.some((port) => "pid" in device && port.vendorId === device.vid && port.productId === device.pid) ||
                device.name.startsWith("HaritoraX-") ||
                device.name.startsWith("Haritora-")
            ) {
                return true;
            }
        }
    }

    async getAvailableDevices() {
        const ports = await Binding.list();
        const btsppDevices = await btspp.getPairedDevices();
        const availableDeviceNames: Set<string> = new Set();
        let gxDevicesFound = false;

        for (const device of dongles) {
            const matchingPort = ports.find((port) => port.vendorId === device.vid && port.productId === device.pid);
            if (matchingPort) {
                if (device.name === "GX6" || device.name === "GX2") {
                    gxDevicesFound = true;
                    availableDeviceNames.add(device.name);
                }
            }
        }

        if (btsppDevices) {
            for (const btDevice of btsppDevices) {
                if (btDevice.name.startsWith("HaritoraX-") || btDevice.name.startsWith("Haritora-")) {
                    availableDeviceNames.add("HaritoraX Wired");
                }
            }
        }

        if (gxDevicesFound) availableDeviceNames.add("HaritoraX Wireless");

        return Array.from(availableDeviceNames);
    }

    async getDevicePorts(device: string) {
        const ports = await Binding.list();
        let bluetoothDevices;
        if (device === TrackerModel.Wired) bluetoothDevices = await btspp.getPairedDevices();
        const availablePorts = ports
            .map((port) => {
                const deviceMatch = dongles.find(
                    (deviceItem) =>
                        deviceItem.vid &&
                        deviceItem.pid &&
                        port.vendorId &&
                        port.productId &&
                        port.vendorId.toLowerCase() === deviceItem.vid.toLowerCase() &&
                        port.productId.toLowerCase() === deviceItem.pid.toLowerCase()
                );
                return {
                    ...port,
                    deviceName: deviceMatch ? deviceMatch.name : undefined,
                };
            })
            .filter((port_1) => port_1.deviceName !== undefined);

        let foundPorts = [];
        for (const port_2 of availablePorts) {
            if (port_2.deviceName?.toLowerCase() === device.toLowerCase()) foundPorts.push(port_2.path);
        }

        if (device === TrackerModel.Wired) {
            for (const btDevice of bluetoothDevices) {
                if (btDevice.name.startsWith("HaritoraX-") || btDevice.name.startsWith("Haritora-")) {
                    foundPorts.push(btDevice.comPort);
                }
            }
        }

        return foundPorts;
    }

    startConnection(portNames: string[]) {
        const initializeSerialPort = (port: string, isRetry = false) => {
            try {
                // make sure no existing port is open
                if (activePorts[port]) {
                    if (activePorts[port].isOpen) {
                        log(`Port ${port} is already open, closing it before reinitializing...`);
                        activePorts[port].close((err) => {
                            if (err) {
                                error(`Error closing port ${port}: ${err.message}`, true);
                            }
                            delete activePorts[port];
                            initializeSerialPort(port, isRetry);
                        });
                        return;
                    }
                    delete activePorts[port];
                }

                const serial = new SerialPortStream({ path: port, baudRate: BAUD_RATE, binding: Binding });
                const parser = serial.pipe(new ReadlineParser({ delimiter: "\n" }));
                activePorts[port] = serial;

                serial.on("open", async () => {
                    this.emit("connected", port);

                    const errorListener = (err: any) => {
                        error(`Error while trying to read data from port ${port}: ${err}`);
                    };

                    // Manually request all the info from the trackers
                    const initialCommands = ["r0:", "r1:", "r:", "o:"];
                    const delayedCommands = ["i:", "i0:", "i1:", "o0:", "o1:", "v0:", "v1:"];

                    initialCommands.forEach((command) => this.write(serial, command, errorListener));
                    setTimeout(() => {
                        delayedCommands.forEach((command) => this.write(serial, command, errorListener));
                        // Repeated initial commands just to make sure, lol
                        initialCommands.forEach((command) => this.write(serial, command, errorListener));
                    }, 1500);
                });

                parser.on("data", (data) => processData(data, port));
                serial.on("close", () => {
                    // Retry the connection because we only want the port to be closed if we manually close it (assume disconnected/unplugged)
                    retryConnection(port);
                });
                serial.on("error", (err) => {
                    error(`Error${isRetry ? " while retrying connection" : ""} on port ${port}: ${err}`, true);
                    retryConnection(port);
                });

                setupHeartbeat(serial, port, trackerModelEnabled);
            } catch (err) {
                error(`Failed to initialize serial port ${port}: ${err}`);
                retryConnection(port);
            }
        };

        const retryConnection = (port: string) => {
            this.emit("disconnected", port);
            setTimeout(() => {
                log(`Retrying connection to COM port: ${port}`);
                initializeSerialPort(port, true);
            }, retryConnectionInterval);
        };

        for (const port of portNames) {
            log(`Opening COM port: ${port}`);
            initializeSerialPort(port);
        }
    }

    stopConnection() {
        Object.entries(activePorts).forEach(([port, serialPort]) => {
            if (!serialPort.isOpen) return;
            log(`Closing COM port: ${port}`);
            try {
                serialPort.removeAllListeners();
                serialPort.close();
                delete activePorts[port];
            } catch (err) {
                error(`Error closing COM port: ${port}: ${err}`, true);
                throw err;
            }
        });

        this.emit("disconnected");
    }

    setChannel(port: string, channel: number) {
        // theoretically.. we *could* set it higher than 10 2.4 ghz channels, but that should be ignored by the firmware
        // also illegal to go higher than 11 in some countries lol
        if (channel < 0 || channel > 10) {
            error(`Invalid channel: ${channel}`);
            throw new Error(`Invalid channel: ${channel}`);
        }

        if (!activePorts[port]) {
            error(`Invalid port: ${port}`);
            throw new Error(`Invalid port: ${port}`);
        }

        this.write(activePorts[port], `o:30${channel === 10 ? "a" : channel}0\n`, (err: any) => {
            if (!err) return;
            error(`Error while changing channel on port ${port}: ${err}`);
            throw err;
        });

        log(`Changed channel of port ${port} to: ${channel}`);
    }

    pair(port: string, portId: string) {
        const channel = portChannels[port];

        if (!activePorts[port]) {
            error(`Invalid port: ${port}`);
            throw new Error(`Invalid port: ${port}`);
        }

        if (!channel) {
            error(`Channel not found for port: ${port}`);
            throw new Error(`Channel not found for port: ${port}`);
        }

        let commands;
        isPairing = true;

        switch (portId) {
            case "0":
                commands = [`o:11${channel}0`, `o:10${channel}0`, `o:30${channel}0`];
                break;
            case "1":
                commands = [`o:22${channel}0`, `o:20${channel}0`, `o:30${channel}0`];
                break;
            default:
                error(`Invalid port ID: ${portId}`);
                throw new Error(`Invalid port ID: ${portId}`);
        }

        commands.forEach((command, index) =>
            setTimeout(() => {
                this.write(activePorts[port], command, (err: any) => {
                    error(`Error while pairing on port ${port}: ${err}`);
                });
            }, index * 1000)
        );

        log(`Started pairing on port ${port} with port ID ${portId}`);

        waitForPairing(() => {
            log(`Paired on port ${port} with port ID ${portId}`);

            this.write(activePorts[port], `o:30${channel}0`, (err: any) => {
                error(`Error while finishing pairing on ${port}: ${err}`);
            });

            this.write(activePorts[port], `r${portId}:`, (err: any) => {
                error(`Error while requesting button info from tracker on ${port}: ${err}`);
            });

            isPairing = false;
            hasPaired = false;

            setTimeout(() => {
                const trackerName = this.getTrackerFromInfo(port, portId);
                this.emit("paired", trackerName, port, portId);
            }, 1000);
        });
    }

    unpair(port: string, portId: string) {
        const channel = portChannels[port];
        const trackerName = this.getTrackerFromInfo(port, portId);

        if (!activePorts[port]) {
            error(`Invalid port: ${port}`);
            throw new Error(`Invalid port: ${port}`);
        }

        if (!channel) {
            error(`Channel not found for port: ${port}`);
            throw new Error(`Channel not found for port: ${port}`);
        }

        let commands;

        switch (portId) {
            case "0":
                commands = [`o:30${channel}1`, `o:30${channel}0`];
                break;
            case "1":
                commands = [`o:30${channel}2`, `o:30${channel}0`];
                break;
            default:
                error(`Invalid port ID: ${portId}`);
                throw new Error(`Invalid port ID: ${portId}`);
        }

        commands.forEach((command, index) =>
            setTimeout(() => {
                this.write(activePorts[port], command, (err: any) => {
                    error(`Error while unpairing on port ${port}: ${err}`);
                });
            }, index * 1000)
        );

        log(`Unpaired "${trackerName}" on port ${port} with port ID ${portId}`);
        resetTrackerAssignment(trackerName);
        this.emit("unpaired", trackerName, port, portId);
    }

    getPortChannel(port: string) {
        return portChannels[port];
    }

    getPortChannels() {
        return portChannels;
    }

    getActiveTrackerModel() {
        return trackerModelEnabled;
    }

    getTrackerAssignment() {
        return Array.from(trackerAssignment.entries());
    }

    getTrackers() {
        return Array.from(trackerAssignment.keys());
    }

    getTrackerId(tracker: string) {
        return trackerAssignment.get(tracker)?.[0] || null;
    }

    getTrackerPort(tracker: string) {
        return trackerAssignment.get(tracker)[1];
    }

    getTrackerPortId(tracker: string) {
        return trackerAssignment.get(tracker)[2];
    }

    getTrackerFromId(trackerId: string) {
        for (let [key, value] of trackerAssignment.entries()) {
            if (value[0] === trackerId) {
                return key;
            }
        }
    }

    getTrackerFromInfo(port: string, portId: string) {
        log(`Tracker assignment: ${Array.from(trackerAssignment.entries()).join(", ")}`);
        for (let [key, value] of trackerAssignment.entries()) {
            if (value[1] === port && value[2] === portId) {
                return key;
            }
        }
    }

    getActivePorts() {
        return activePorts;
    }

    write(port: SerialPortStream, rawData: string, callbackError?: Function) {
        const data = `\n${rawData}\n`;

        port.write(data, (err: any) => {
            if (err) {
                if (callbackError) {
                    callbackError(err);
                } else {
                    error(`Error writing data to serial port ${port.path}: ${err}`);
                }
            } else if (printWrites) {
                log(`(DONGLE) - Data written to serial port ${port.path}: ${rawData.toString().replace(/\r\n/g, " ")}`);
            }
        });
    }
}

/*
 * startConnection() helper functions
 */

let isPairing = false;
let hasPaired = false;

async function processData(data: string, port: string) {
    main.emit("dataRaw", data, port);

    try {
        let trackerName = null;
        let identifier = null;
        let portId = null;
        let portData = null;

        if (trackerModelEnabled === "wireless") {
            const splitData = data.toString().split(/:(.+)/);
            if (splitData.length > 1) {
                identifier = splitData[0].toLowerCase();
                // For normal trackers we extract a digit from the identifier...
                const match = identifier.match(/\d/);
                portId = match ? match[0] : "DONGLE";
                portData = splitData[1];

                // Decode Base64 data
                const decodedData = Buffer.from(portData, "base64");
                const dataLength = decodedData.length;

                // Leg tracker data is expected to be at least 28 bytes (sometimes 30 bytes)
                if (dataLength >= 28) {
                    log(`Leg tracker detected on port ${port} with data length: ${dataLength} bytes`);

                    const kneeData = decodedData.slice(0, 14);  // First 14 bytes
                    const ankleData = decodedData.slice(14, 28); // Next 14 bytes

                    // Determine which leg tracker to assign by checking current assignments
                    const leftKneeAssign = trackerAssignment.get("leftKnee");
                    const rightKneeAssign = trackerAssignment.get("rightKnee");
                    let kneeTracker, ankleTracker;

                    if ((!leftKneeAssign[1] || leftKneeAssign[1] === "") && (!rightKneeAssign[1] || rightKneeAssign[1] === "")) {
                        // Neither leg has been assigned yet; assign this one to left by default.
                        kneeTracker = "leftKnee";
                        ankleTracker = "leftAnkle";
                    } else if (leftKneeAssign[1] && leftKneeAssign[1] !== port) {
                        // Left is assigned elsewhere, so assign this tracker to right if available.
                        if (!rightKneeAssign[1] || rightKneeAssign[1] === "") {
                            kneeTracker = "rightKnee";
                            ankleTracker = "rightAnkle";
                        } else if (rightKneeAssign[1] === port) {
                            kneeTracker = "rightKnee";
                            ankleTracker = "rightAnkle";
                        } else {
                            // Fallback: update left if current port already matches left.
                            kneeTracker = "leftKnee";
                            ankleTracker = "leftAnkle";
                        }
                    } else if (leftKneeAssign[1] === port) {
                        // Current port is already assigned to left.
                        kneeTracker = "leftKnee";
                        ankleTracker = "leftAnkle";
                    } else if ((!rightKneeAssign[1] || rightKneeAssign[1] === "") || rightKneeAssign[1] === port) {
                        // Otherwise, assign to right.
                        kneeTracker = "rightKnee";
                        ankleTracker = "rightAnkle";
                    } else {
                        // Fallback to left if none of the above conditions match.
                        kneeTracker = "leftKnee";
                        ankleTracker = "leftAnkle";
                    }

                    // Use default tracker IDs:
                    // leftKnee is "2" (and leftAnkle "3"), rightKnee is "4" (and rightAnkle "5")
                    const assignedTrackerId = (kneeTracker === "leftKnee") ? "2" : "4";
                    trackerAssignment.set(kneeTracker, [assignedTrackerId, port, assignedTrackerId]);
                    trackerAssignment.set(ankleTracker, [(parseInt(assignedTrackerId) + 1).toString(), port, assignedTrackerId]);
                    log(`Assigned ${kneeTracker} and ${ankleTracker} to port ${port} with tracker id ${assignedTrackerId}`);

                    main.emit("data", kneeTracker, port, assignedTrackerId, identifier, kneeData.toString("base64"));
                    main.emit("data", ankleTracker, port, assignedTrackerId, identifier, ankleData.toString("base64"));
                    return;
                }

                // Normal tracker assignment for non-leg trackers
                for (let [key, value] of trackerAssignment.entries()) {
                    if (value[1] === "" && /^r.+/.test(identifier)) {
                        const trackerId = parseInt(portData.charAt(4));
                        if (parseInt(value[0]) === trackerId && trackerId !== 0) {
                            trackerAssignment.set(key, [trackerId.toString(), port, portId]);
                            log(`Setting ${key} to port ${port} with port ID ${portId}`);
                        }
                    }
                }

                for (let [key, value] of trackerAssignment.entries()) {
                    if (value[1] === port && value[2] === portId) {
                        trackerName = key;
                        break;
                    }
                }
            }
        } else if (trackerModelEnabled === "wired") {
            const splitData = data.toString().split(/:(.+)/);
            if (splitData.length > 1) {
                identifier = splitData[0].toLowerCase();
                portData = splitData[1];
            }
        }

        if (portId === "DONGLE") {
            trackerName = "DONGLE";

            if (identifier === "o") {
                const channel = parseInt(portData.charAt(2));
                if (!isNaN(channel)) portChannels[port] = channel;
                log(`Channel of port ${port} is: ${channel}`);
            } else if (identifier === "r" && isPairing) {
                if (portData.charAt(0) === "3" || portData.charAt(1) === "3") {
                    isPairing = false;
                    hasPaired = true;
                }
            }
        }

        main.emit("data", trackerName, port, portId, identifier, portData);
    } catch (err) {
        error(`An unexpected error occurred: ${err}`);
    }
}

function resetTrackerAssignment(trackerName: string) {
    const currentValue = trackerAssignment.get(trackerName);
    if (currentValue) {
        trackerAssignment.set(trackerName, [currentValue[0], "", ""]);
    }
}

function waitForPairing(callback: () => void) {
    const interval = setInterval(() => {
        if (hasPaired) {
            clearInterval(interval);
            callback();
        }
    }, 1000);
}

function setupHeartbeat(serial: SerialPortStream, port: string, trackerModel: string) {
    setInterval(() => {
        if (serial.isOpen) {
            const command = trackerModel === "wired" ? "report send info\nblt send info" : "i:";
            if (printWrites) log(`Sending heartbeat to port ${port}`);
            main.write(serial, command);
        }
    }, heartbeatInterval);
}

/*
 * Helper functions
 */

function log(message: string) {
    const finalMessage = `(COM) ${message}`;
    console.log(finalMessage);
    main.emit("log", finalMessage);
}

function error(message: string, exceptional = false) {
    const finalMessage = `(COM) ${message}`;
    console.error(finalMessage);
    main.emit("logError", { message: finalMessage, exceptional });
}

/*
 * Typescript type definitions
 */

export interface ActivePorts {
    [key: string]: SerialPortStream;
}

export { COM };

