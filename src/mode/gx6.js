"use strict";

import { SerialPort, ReadlineParser } from "serialport";
import { EventEmitter } from "events";

const portNames = ["COM4", "COM5", "COM6"]; // the default ports used by the GX6 dongle
const baudRate = 500000; // from the haritora_setting.json in the HaritoraConfigurator

const trackerAssignment = new Map([
    ["rightKnee", [0, "COM4"]], // o0, right knee
    ["rightAnkle", [1, "COM4"]], // o1, right ankle
    ["hip", [0, "COM5"]], // o0, hip
    ["chest", [1, "COM5"]], // o1, chest
    ["leftKnee", [0, "COM6"]], // o0, left knee
    ["leftAnkle", [1, "COM6"]]  // o1, left ankle
]);

// Stores the ports that are currently active as objects for access later
let activePorts = {};

export default class GX6 extends EventEmitter {
    constructor() {
        super();
    }
    
    startConnection() {
        portNames.forEach(port => {
            const serial = new SerialPort({
                path: port,
                baudRate: baudRate
            });
            const parser = serial.pipe(new ReadlineParser({ delimiter: "\n" }));
            activePorts[port] = serial;
            
            serial.on("open", () => {
                this.emit("connected", port);
            });

            parser.on("data", data => {
                this.emit("data", port, data);
            });
        });
    }

    stopConnection() {
        for (let port in activePorts) {
            if (activePorts[port].isOpen) activePorts[port].close();
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
            console.log(`Tracker ${tracker} is index ${port[0]} and is in port ${port[1]}`);
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