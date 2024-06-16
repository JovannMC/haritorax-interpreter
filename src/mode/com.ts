"use strict";

import { SerialPort, ReadlineParser } from "serialport";
import { EventEmitter } from "events";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

let main: COM = undefined;
let debug = 0;

const BAUD_RATE = 500000; // from the haritora_setting.json in the HaritoraConfigurator

// For HaritoraX Wireless
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

// For HaritoraX Wireless
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
let trackerModelEnabled: String;

export default class COM extends EventEmitter {
    constructor(trackerModel: string, debugMode = 0) {
        super();
        debug = debugMode;
        main = this;
        trackerModelEnabled = trackerModel;
        log(`Debug mode for GX: ${debug}`);
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
                this.emit("connected", port);
            });

            parser.on("data", (data) => {
                let trackerName = null;
                let identifier = null;
                let portId = null;
                let portData = null;

                if (trackerModelEnabled === "wireless") {
                    const splitData = data.toString().split(/:(.+)/);
                    identifier = splitData[0].toLowerCase();
                    portId = identifier.match(/\d/) ? identifier.match(/\d/)[0] : "DONGLE";
                    portData = splitData[1];

                    if (!trackersAssigned) {
                        for (let [key, value] of trackerAssignment.entries()) {
                            if (value[1] === "") {
                                if (identifier.startsWith("r")) {
                                    const trackerId = parseInt(portData.charAt(4));
                                    if (parseInt(value[0]) == trackerId) {
                                        trackerAssignment.set(key, [trackerId, port, portId]);
                                        log(
                                            ` Setting ${key} to port ${port} with port ID ${portId}`
                                        );
                                    }
                                } else if (identifier.startsWith("i")) {
                                    const info = JSON.parse(portData);
                                    const version = info["version"];
                                    const model = info["model"];
                                    const serial = info["serial no"];

                                    deviceInformation.set(key, [version, model, serial]);
                                }
                            }
                        }

                        if (
                            Array.from(trackerAssignment.values()).every((value) => value[1] !== "")
                        ) {
                            trackersAssigned = true;
                            log(
                                `All trackers have been assigned: ${Array.from(
                                    trackerAssignment.entries()
                                )}`
                            );
                        }
                    }

                    for (let [key, value] of trackerAssignment.entries()) {
                        if (value[1] === port && value[2] === portId) {
                            trackerName = key;
                            break;
                        }
                    }
                } else if (trackerModelEnabled === "wired") {
                    const splitData = data.toString().split(/:(.+)/);
                    identifier = splitData[0].toLowerCase();
                    portData = splitData[1];
                }

                this.emit("data", trackerName, port, portId, identifier, portData);
            });

            serial.on("close", () => {
                this.emit("disconnected", port);
            });

            // Send "heartbeat" packets to the trackers to keep them alive (by requesting info from the trackers)
            // note: THIS TOOK ME 4 DAYS STRAIGHT TO FIGURE OUT WHY, I AM GOING TO EXPLODE
            // -jovannmc
            setInterval(() => {
                if (serial.isOpen) {
                    log(`Sending heartbeat to port ${port}`);
                    serial.write("report send info\r\nblt send info\r\n", (err) => {
                        if (!err) return;
                        error(`Error while sending heartbeat to port ${port}: ${err}`);
                    });
                }
            }, 10000);
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
 * Helper functions
 */

function log(message: string) {
    main.emit("log", message);
}

function error(message: string) {
    main.emit("logError", message);
}

/*
 * Typescript type definitions
 */

interface ActivePorts {
    [key: string]: SerialPort;
}

export { COM };
