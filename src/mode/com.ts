"use strict";

import { SerialPortStream } from "@serialport/stream";
import { autoDetect } from "@serialport/bindings-cpp";
import { ReadlineParser } from "@serialport/parser-readline";
import { EventEmitter } from "events";
import { getPairedDevices, BluetoothDevice } from "../libs/btspp";

const Binding = autoDetect();

let main: COM = undefined;

const BAUD_RATE = 500000; // from the haritora_setting.json in the HaritoraConfigurator

// For HaritoraX Wireless
const trackerAssignment: Map<string, string[]> = new Map([
    // tracker part, [tracker id, port, port id]
    ["DONGLE", ["0", "", ""]],
    ["chest", ["1", "", ""]],
    ["leftKnee", ["2", "", ""]],
    ["leftAnkle", ["3", "", ""]],
    ["rightKnee", ["4", "", ""]],
    ["rightAnkle", ["5", "", ""]],
    ["hip", ["6", "", ""]],
    ["leftElbow", ["7", "", ""]],
    ["rightElbow", ["8", "", ""]],
]);

// For HaritoraX Wireless
const deviceInformation: Map<string, string[]> = new Map([
    // deviceName, [version, model, serial]
    ["DONGLE", ["", "", "", "", ""]],
    ["chest", ["", "", "", "", ""]],
    ["leftKnee", ["", "", "", "", ""]],
    ["leftAnkle", ["", "", "", "", ""]],
    ["rightKnee", ["", "", "", "", ""]],
    ["rightAnkle", ["", "", "", "", ""]],
    ["hip", ["", "", "", "", ""]],
    ["leftElbow", ["", "", "", "", ""]],
    ["rightElbow", ["", "", "", "", ""]],
]);

const devices = [
    { name: "GX2", vid: "1915", pid: "520F" },
    { name: "GX6", vid: "04DA", pid: "3F18" },
    /*{ name: "HaritoraX 1.1b", vid: "", pid: "" },
    { name: "HaritoraX 1.1", vid: "", pid: "" },
    { name: "HaritoraX 1.0", vid: "", pid: "" },
    // { name: "Haritora", vid: "", pid: "" }, - these were before Shiftall (and users had to build it themselves), so they may not have the same VID/PID*/
];

// Stores the ports that are currently active as objects for access later
let activePorts: ActivePorts = {};
let trackersAssigned = false;
let trackerModelEnabled: String;
let heartbeatInterval: number; // in milliseconds

export default class COM extends EventEmitter {
    constructor(trackerModel: string, heartbeat?: number) {
        super();
        main = this;
        trackerModelEnabled = trackerModel;
        heartbeatInterval = heartbeat;
        log(`Initialized COM module with settings: ${trackerModelEnabled} ${heartbeatInterval}`);
    }

    async isDeviceAvailable() {
        const ports = await Binding.list();
        const btsppDevices = await getPairedDevices();
        const allDevices = [...devices, ...btsppDevices];

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
        const btsppDevices = await getPairedDevices();
        const availableDeviceNames: Set<string> = new Set();
        let gxDevicesFound = false;

        for (const device of devices) {
            const matchingPort = ports.find((port) => port.vendorId === device.vid && port.productId === device.pid);
            if (matchingPort) {
                if (device.name === "GX6" || device.name === "GX2") {
                    gxDevicesFound = true;
                    availableDeviceNames.add(device.name);
                }
            }
        }

        for (const btDevice of btsppDevices) {
            if (btDevice.name.startsWith("HaritoraX-") || btDevice.name.startsWith("Haritora-")) {
                availableDeviceNames.add("HaritoraX Wired");
            }
        }

        if (gxDevicesFound) availableDeviceNames.add("HaritoraX Wireless");

        return Array.from(availableDeviceNames);
    }

    async getDevicePorts(device: string) {
        const ports = await Binding.list();
        const bluetoothDevices = await getPairedDevices();
        const availablePorts = ports
            .map((port) => {
                const deviceMatch = devices.find(
                    (deviceItem) => port.vendorId === deviceItem.vid && port.productId === deviceItem.pid
                );
                return {
                    ...port,
                    deviceName: deviceMatch ? deviceMatch.name : undefined,
                };
            })
            .filter((port_1) => port_1.deviceName !== undefined);

        let foundPorts = [];
        for (const port_2 of availablePorts) {
            if (port_2.deviceName === device) foundPorts.push(port_2.path);
        }

        for (const btDevice of bluetoothDevices) {
            if ((btDevice.name.startsWith("HaritoraX-") || btDevice.name.startsWith("Haritora-")) && btDevice.comPort) {
                foundPorts.push(btDevice.comPort);
            }
        }

        return foundPorts;
    }

    startConnection(portNames: string[]) {
        const initializeSerialPort = (port: string) => {
            try {
                const serial = new SerialPortStream({ path: port, baudRate: BAUD_RATE, binding: Binding });
                const parser = serial.pipe(new ReadlineParser({ delimiter: "\n" }));
                activePorts[port] = serial;

                serial.on("open", () => this.emit("connected", port));
                parser.on("data", (data) => processData(data, port));
                serial.on("close", () => this.emit("disconnected", port));
                serial.on("error", (err) => {
                    error(`Error on port ${port}: ${err}`, true);
                });

                if (trackerModelEnabled === "wired") setupHeartbeat(serial, port);
            } catch (err) {
                throw err;
            }
        };

        for (const port of portNames) {
            log(`Opening COM port: ${port}`);
            initializeSerialPort(port);
        }
    }

    stopConnection() {
        Object.entries(activePorts).forEach(([port, serialPort]) => {
            if (!serialPort.isOpen) return;
            try {
                log(`Closing COM port: ${port}`);
                serialPort.removeAllListeners();
                serialPort.close();
                delete activePorts[port];
            } catch (err) {
                error(`Error closing COM port: ${port}: ${err}`, true);
            }
        });

        this.emit("disconnected");
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
        const trackerId: number = parseInt(trackerAssignment.get(tracker)[0]);
        if (trackerId) {
            return trackerId;
        }
        return null;
    }

    getTrackerPort(tracker: string) {
        const port: string = trackerAssignment.get(tracker)[1];
        if (port) {
            return port;
        }
        return null;
    }

    getTrackerPortId(tracker: string) {
        const portId = parseInt(trackerAssignment.get(tracker)[2]);
        if (portId) {
            return portId;
        }
        return null;
    }

    getPartFromId(trackerId: string) {
        for (let [key, value] of trackerAssignment.entries()) {
            if (value[0] == trackerId) {
                return key;
            }
        }
    }

    getPartFromInfo(port: string, portId: string) {
        for (let [key, value] of trackerAssignment.entries()) {
            if (value[1] == port && value[2] == portId) {
                return key;
            }
        }
    }

    getDeviceInformation(deviceName: string) {
        return deviceInformation.get(deviceName);
    }

    getActivePorts() {
        return activePorts;
    }
}

/*
 * startConnection() helper functions
 */

let isOverThreshold = false;
let dataQueue: { data: string; port: string }[] = [];

async function processData(data: string, port: string) {
    main.emit("dataRaw", data, port);

    try {
        let trackerName = null;
        let identifier: string = null;
        let portId: string = null;
        let portData: string = null;

        if (trackerModelEnabled === "wireless") {
            const splitData = data.toString().split(/:(.+)/);
            if (splitData.length > 1) {
                identifier = splitData[0].toLowerCase();
                const match = identifier.match(/\d/);
                portId = match ? match[0] : "DONGLE";
                portData = splitData[1];

                if (!trackersAssigned) {
                    for (let [key, value] of trackerAssignment.entries()) {
                        if (value[1] === "") {
                            if (identifier.startsWith("r")) {
                                const trackerId = parseInt(portData.charAt(4));
                                if (!isNaN(trackerId) && parseInt(value[0]) == trackerId) {
                                    trackerAssignment.set(key, [trackerId.toString(), port, portId]);
                                    log(`Setting ${key} to port ${port} with port ID ${portId}`);
                                }
                            }
                        }
                    }

                    // Check if all trackers are assigned and queue if not
                    if (!trackersAssigned && !isOverThreshold) {
                        if (dataQueue && dataQueue.length >= 50) {
                            isOverThreshold = true;
                            log(`Data queue is over threshold, assuming not all trackers have been connected.`);
                            dataQueue = null;
                            return;
                        }

                        // Skip IMU data for trackers, not needed to be processed after trackers are assigned
                        if (identifier.startsWith('x')) return;
                    
                        dataQueue.push({ data, port });
                        log(`Trackers not assigned yet - ${data} - Queue length: ${dataQueue.length}`);
                    }
                    const numberOfPorts = Object.keys(activePorts).length;
                    const requiredAssignments = numberOfPorts * 2;

                    if (
                        Array.from(trackerAssignment.values()).filter((value) => value[1] !== "" && value[2] !== "DONGLE")
                            .length >= requiredAssignments
                    ) {
                        log(`Required assignments completed: ${Array.from(trackerAssignment.entries())}`);
                        trackersAssigned = true;

                        // Process the queued data
                        while (dataQueue.length > 0) {
                            const queuedData = dataQueue.shift();
                            if (queuedData) {
                                log(`Processing queued data: ${queuedData.data}`);
                                await processData(queuedData.data, queuedData.port);
                            }
                        }

                        main.emit("assigned");
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

        if (portId === "DONGLE") trackerName = "DONGLE";

        main.emit("data", trackerName, port, portId, identifier, portData);
    } catch (err) {
        error(`An unexpected error occurred: ${err}`);
    }
}

function setupHeartbeat(serial: SerialPortStream, port: string) {
    setInterval(() => {
        if (serial.isOpen) {
            // TODO: find another way to send heartbeat instead of requesting info from the tracker
            log(`Sending heartbeat to port ${port}`);
            serial.write("report send info\r\nblt send info\r\n", (err) => {
                if (err) {
                    error(`Error while sending heartbeat to port ${port}: ${err}`);
                }
            });
        }
    }, heartbeatInterval);
}

/*
 * Helper functions
 */

function log(message: string) {
    main.emit("log", message);
}

function error(message: string, exceptional = false) {
    main.emit("logError", { message, exceptional });
}

/*
 * Typescript type definitions
 */

interface ActivePorts {
    [key: string]: SerialPortStream;
}

export { COM };
