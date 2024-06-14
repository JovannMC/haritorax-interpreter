"use strict";

import { BluetoothSerialPort } from "bluetooth-serial-port";
import { EventEmitter } from "events";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

let main: Bluetooth = undefined;
let debug = 0;

// Stores the ports that are currently active as objects for access later
let activePorts: ActivePorts = {};
let trackerModelEnabled: String;

export default class Bluetooth extends EventEmitter {
    constructor(trackerModel: string, debugMode = 0) {
        super();
        debug = debugMode;
        main = this;
        trackerModelEnabled = trackerModel;
        log(`Debug mode for GX: ${debug}`);
    }

    startConnection(deviceName = "HaritoraX") {
        const bluetooth = new BluetoothSerialPort();
        let disconnectTimeout: NodeJS.Timeout;

        bluetooth.on("found", (address, name) => {
            log(`Found device with address ${address} and name ${name}`);

            if (name.includes(deviceName)) {
                log(`Connecting to device with address ${address} and name ${name}`);
                bluetooth.findSerialPortChannel(
                    address,
                    (channel) => {
                        bluetooth.connect(
                            address,
                            channel,
                            () => {
                                log(
                                    `Connected to device at address ${address} on channel ${channel}`
                                );
                                const port = `${address}:${channel}`;
                                activePorts[port] = bluetooth;
                                this.emit("connected", port);

                                bluetooth.on("data", (buffer) => {
                                    const data = buffer.toString("utf-8");

                                    let identifier = null;
                                    let portData = null;

                                    const splitData = data.toString().split(/:(.+)/);
                                    identifier = splitData[0].toLowerCase();
                                    portData = splitData[1];

                                    log(`Received data from port ${port}: ${data}`);

                                    this.emit("data", identifier, portData);
                                });

                                // Send "heartbeat" packets to the trackers to keep them alive
                                setInterval(() => {
                                    log(`Sending heartbeat to port ${port}`);
                                    bluetooth.write(Buffer.from(""), (err) => {
                                        if (err) {
                                            error(
                                                `Error while sending heartbeat to port ${port}: ${err}`
                                            );
                                        }
                                    });
                                }, 10000);

                                // Reset the disconnect timeout whenever data is received
                                clearTimeout(disconnectTimeout);
                                disconnectTimeout = setTimeout(() => {
                                    this.emit(
                                        "disconnect",
                                        `No data received from port ${port} for 10 seconds`
                                    );
                                }, 10000); // Set timeout to 10 seconds
                            },
                            () => {
                                error(
                                    `Cannot connect to device at address ${address} on channel ${channel}`
                                );
                            }
                        );
                    },
                    () => {
                        error(`No RFCOMM channel found for device at address ${address}`);
                    }
                );
            }
        });

        return true;
    }

    stopConnection() {
        try {
            for (let port in activePorts) {
                log(`Closing Bluetooth Serial port: ${port}`);
                activePorts[port].close();
                delete activePorts[port];
            }
        } catch (err) {
            error(`Error while closing Bluetooth ports: ${err}`);
            return false;
        }

        return true;
    }

    getActiveTrackerModel() {
        return trackerModelEnabled;
    }

    getActivePorts() {
        return activePorts;
    }
}

/*
 * Helper functions
 */

function log(message: string) {
    let emittedMessage = `(haritorax-interpreter) BT-COM - ${message}`;

    const date = new Date();

    main.emit("log", emittedMessage);
    console.log(`${date.toTimeString()} -- (haritorax-interpreter) -- BT-COM: ${emittedMessage}`);

    const logDir = path.join(os.homedir(), "Desktop", "logs");
    const logPath = path.join(
        logDir,
        `log-haritorax-interpreter-raw-bluetooth-serial-data-${date.getFullYear()}${(
            "0" +
            (date.getMonth() + 1)
        ).slice(-2)}${("0" + date.getDate()).slice(-2)}.txt`
    );

    // Create the directory if it doesn't exist
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }

    // Create the file if it doesn't exist
    if (!fs.existsSync(logPath)) {
        fs.writeFileSync(logPath, "");
    }

    fs.appendFileSync(
        logPath,
        `${date.toTimeString()} -- (haritorax-interpreter) -- BT-COM: ${emittedMessage}\n`
    );
}

function error(msg: string) {
    let emittedMessage = `(haritorax-interpreter) - ${msg}`;

    const date = new Date();

    main.emit("error", emittedMessage);
    console.error(`${date.toTimeString()} -- (haritorax-interpreter) -- BT-COM: ${msg}`);

    const logDir = path.join(os.homedir(), "Desktop", "logs");
    const logPath = path.join(
        logDir,
        `log-haritorax-interpreter-${date.getFullYear()}${("0" + (date.getMonth() + 1)).slice(
            -2
        )}${("0" + date.getDate()).slice(-2)}.txt`
    );

    // Create the directory if it doesn't exist
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }

    // Create the file if it doesn't exist
    if (!fs.existsSync(logPath)) {
        fs.writeFileSync(logPath, "");
    }

    fs.appendFileSync(
        logPath,
        `${date.toTimeString()} -- (haritorax-interpreter) -- BT-COM: ${msg}\n`
    );
}

/*
 * Typescript type definitions
 */

interface ActivePorts {
    [key: string]: BluetoothSerialPort;
}

export { Bluetooth };
