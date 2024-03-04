"use strict";

import { SerialPort } from "serialport";
import { EventEmitter } from "events";

const portNames = ["COM4", "COM5", "COM6"]; // the default ports used by the GX6 dongle
const baudRate = 500000; // from the haritora_setting.json in the HaritoraConfigurator

// Stores the ports that are currently active as objects for access later
let activePorts = {};

export default class GX6 extends EventEmitter {
    startConnection() {
        portNames.forEach(port => {
            const serial = new SerialPort({
                path: port,
                baudRate: baudRate
            });
            activePorts[port] = serial;
            
            serial.on("open", () => {
                console.log(`Connected to ${port}`);
                this.emit("connected", port);
            });

            serial.on("data", data => {
                console.log(data);
                this.emit("data", data);
            });
        });
    }

    stopConnection() {
        for (let port in activePorts) {
            activePorts[port].close();
        }
        this.emit("disconnected");
    }
}

export { GX6 };