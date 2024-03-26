"use strict";

import { SerialPort, ReadlineParser } from "serialport";
import { EventEmitter } from "events";

const BAUD_RATE = 500000; // from the haritora_setting.json in the HaritoraConfigurator

const trackerAssignment = new Map([
    ["rightKnee", [0, ""]], // o0, right knee
    ["rightAnkle", [1, ""]], // o1, right ankle
    ["hip", [0, ""]], // o0, hip
    ["chest", [1, ""]], // o1, chest
    ["leftKnee", [0, ""]], // o0, left knee
    ["leftAnkle", [1, ""]]  // o1, left ankle
]);

// Stores the ports that are currently active as objects for access later
let activePorts = {};

export default class GX6 extends EventEmitter {
    constructor() {
        super();
    }
    
    startConnection(portNames) {
        // Assign the trackers to the ports, assumes that the ports are in ascending order
        let trackerNames = Array.from(trackerAssignment.keys());
        for (let i = 0; i < trackerNames.length; i++) {
            let trackerName = trackerNames[i];
            let trackerInfo = trackerAssignment.get(trackerName);
            trackerInfo[1] = portNames[Math.floor(i / 2)];
            trackerAssignment.set(trackerName, trackerInfo);

            console.log(`Tracker ${trackerName} assigned to port ${trackerInfo[1]}`);
        }

        portNames.forEach(port => {
            const serial = new SerialPort({
                path: port,
                baudRate: BAUD_RATE
            });
            const parser = serial.pipe(new ReadlineParser({ delimiter: "\n" }));
            activePorts[port] = serial;
            
            serial.on("open", () => {
                this.emit("connected", port);
            });

            parser.on("data", data => {
                this.emit("data", port, data);
            });

            serial.on("close", () => {
                this.emit("disconnected", port);
            });
        });
    }

    stopConnection() {
        for (let port in activePorts) {
            if (activePorts[port].isOpen) {
                activePorts[port].close();
                activePorts[port].destroy();
            }
        }
        this.emit("disconnected");
    }

    getTrackers() {
        return Array.from(trackerAssignment.keys());
    }

    getTrackersInPort(port) {
        let trackers = [];
        for (let tracker in trackerAssignment) {
            if (trackerAssignment[tracker][1] === port) {
                trackers.push(tracker);
            }
        }
        return trackers;
    }

    getTrackerInfo(tracker) {
        const port = trackerAssignment.get(tracker);
        if (port) {
            return port;
        }
        return null;
    }

    getPartFromInfo(trackerId, port) {
        if (trackerId === "(DONGLE)") return "(DONGLE)";
        for (let [key, value] of trackerAssignment.entries()) {
            if (value[0] == trackerId && value[1] == port) {
                return key;
            }
        }
        return null;
    }

    getActivePorts() {
        return activePorts;
    }
}

export { GX6 };