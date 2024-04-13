"use strict";

import { SerialPort, ReadlineParser } from "serialport";
import { EventEmitter } from "events";

const BAUD_RATE = 500000; // from the haritora_setting.json in the HaritoraConfigurator

const trackerAssignment = new Map([
    // tracker part, [tracker id, port, port id]
    ["DONGLE", [0, "", ""]],
    ["chest", [1, "", ""]],
    ["leftKnee", [2, "", ""]],
    ["leftAnkle", [3, "", ""]],
    ["rightKnee", [4, "", ""]],
    ["rightAnkle", [5, "", ""]],
    ["hip", [6, "", ""]],
    ["leftElbow", [7, "", ""]],
    ["rightElbow", [8, "", ""]],
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

export default class GX6 extends EventEmitter {
    constructor() {
        super();
    }

    startConnection(portNames: string[]) {
        portNames.forEach((port) => {
            const serial = new SerialPort({
                path: port,
                baudRate: BAUD_RATE,
            });
            const parser = serial.pipe(new ReadlineParser({ delimiter: "\n" }));
            activePorts[port] = serial;

            serial.on("open", () => {
                this.emit("connected", port);
            });

            parser.on("data", (data) => {
                const splitData = data.toString().split(/:(.+)/);
                const identifier = splitData[0].toLowerCase();
                const portId = identifier.match(/\d/)
                    ? identifier.match(/\d/)[0]
                    : "DONGLE";
                const portData = splitData[1];

                if (!trackersAssigned) {
                    for (let [key, value] of trackerAssignment.entries()) {
                        if (value[1] === "") {
                            if (identifier.startsWith("r")) {
                                const trackerId = parseInt(portData.charAt(4));
                                if (value[0] == trackerId) {
                                    trackerAssignment.set(key, [
                                        trackerId,
                                        port,
                                        portId,
                                    ]);
                                    //console.log(`(haritorax-interpreter) - Setting ${key} to port ${port} with port ID ${portId}`);
                                }
                            } else if (identifier.startsWith("i")) {
                                const info = JSON.parse(portData);
                                const version = info["version"];
                                const model = info["model"];
                                const serial = info["serial no"];

                                deviceInformation.set(key, [
                                    version,
                                    model,
                                    serial,
                                ]);
                            }
                        }
                    }

                    if (
                        Array.from(trackerAssignment.values()).every(
                            (value) => value[1] !== ""
                        )
                    ) {
                        trackersAssigned = true;
                        //console.log("(haritorax-interpreter) - All trackers have been assigned: ", Array.from(trackerAssignment.entries()));
                    }
                }

                let trackerName = null;
                for (let [key, value] of trackerAssignment.entries()) {
                    if (value[1] === port && value[2] === portId) {
                        trackerName = key;
                        break;
                    }
                }

                this.emit(
                    "data",
                    trackerName,
                    port,
                    portId,
                    identifier,
                    portData
                );
            });

            serial.on("close", () => {
                this.emit("disconnected", port);
            });
        });
    }

    stopConnection() {
        try {
            for (let port in activePorts) {
                if (activePorts[port].isOpen) {
                    activePorts[port].close();
                    activePorts[port].destroy();
                }
            }
        } catch (err) {
            console.error(
                "(haritorax-interpreter) - Error while closing serial ports: ",
                err
            );
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
        const port = trackerAssignment.get(tracker)[0];
        if (port) {
            return port;
        }
        return null;
    }

    getTrackerPort(tracker: string) {
        const port = trackerAssignment.get(tracker)[1];
        if (port) {
            return port;
        }
        return null;
    }

    getTrackerPortId(tracker: string) {
        const portId = trackerAssignment.get(tracker)[2];
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
        //console.log((haritorax-interpreter) - deviceInformation);
        return deviceInformation.get(deviceName);
    }

    getActivePorts() {
        return activePorts;
    }
}

/*
 * Typescript type definitions
 */

interface ActivePorts {
    [key: string]: SerialPort;
}

export { GX6 };
