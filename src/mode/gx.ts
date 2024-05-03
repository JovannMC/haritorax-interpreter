"use strict";

import { SerialPort, ReadlineParser } from "serialport";
import { EventEmitter } from "events";

let gx: GX = undefined;
let debug = 0;

const BAUD_RATE = 500000; // from the haritora_setting.json in the HaritoraConfigurator

const trackerAssignment = new Map([
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

const deviceInformation = new Map([
    // deviceName, [version, model, serial]
    ["DONGLE", ["", "", ""]],
    ["rightKnee", ["", "", ""]],
    ["rightAnkle", ["", "", ""]],
    ["hip", ["", "", ""]],
    ["chest", ["", "", ""]],
    ["leftKnee", ["", "", ""]],
    ["leftAnkle", ["", "", ""]],
    ["leftElbow", ["", "", ""]],
    ["rightElbow", ["", "", ""]],
]);

// Stores the ports that are currently active as objects for access later
let activePorts: ActivePorts = {};
let trackersAssigned = false;

export default class GX extends EventEmitter {
    constructor(debugMode = 0) {
        super();
        debug = debugMode;
        gx = this;
        log(`(haritorax-interpreter) - Debug mode for GX: ${debug}`);
    }

    startConnection(portNames: string[]) {
        portNames.forEach((port) => {
            let serial = undefined;
            try {
                serial = new SerialPort({
                    path: port,
                    baudRate: BAUD_RATE,
                });

                serial.on("error", (err) => {
                    error(`Error while opening serial port: ${err}`);
                    return false;
                });
            } catch (err) {
                error("Unexpected error: ${err}");
                return false;
            }

            const parser = serial.pipe(new ReadlineParser({ delimiter: "\n" }));
            activePorts[port] = serial;

            serial.on("open", () => {
                log(`Opened COM port: ${port}`);
                this.emit("connected", port);
            });

            parser.on("data", (data) => {
                const splitData = data.toString().split(/:(.+)/);
                const identifier = splitData[0].toLowerCase();
                const portData = splitData[1];
                this.emit("data", identifier, portData);
            });

            serial.on("close", () => {
                log(`Closed COM port: ${port}`);
                this.emit("disconnected", port);
            });
        });
        return true;
    }

    stopConnection() {
        try {
            for (let port in activePorts) {
                if (activePorts[port].isOpen) {
                    log(`Closing COM port: ${port}`);
                    activePorts[port].close();
                    activePorts[port].destroy();
                }
            }
        } catch (err) {
            error(`Error while closing serial ports: ${err}`);
            return false;
        }

        this.emit("disconnected");
        return true;
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
 * Helper functions
 */

function log(message: string) {
    gx.emit("log", message);
}

function error(message: string) {
    gx.emit("logError", message);
}

/*
 * Typescript type definitions
 */

interface ActivePorts {
    [key: string]: SerialPort;
}

export { GX };
