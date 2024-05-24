"use strict";

import noble, { Peripheral, Service, Characteristic } from "@abandonware/noble";
import { EventEmitter } from "events";

let bluetooth: Bluetooth = undefined;
let debug = 0;

const services = new Map([
    ["1800", "Generic Access"],
    ["1801", "Generic Attribute"],
    ["180a", "Device Information"],
    ["180f", "Battery Service"],
    ["00dbec3a90aa11eda1eb0242ac120002", "Tracker Service"],
    ["ef84369a90a911eda1eb0242ac120002", "Setting Service"],
]);

const characteristics = new Map([
    // Battery Service
    ["2a19", "BatteryLevel"],
    // BT device info
    ["2a25", "SerialNumber"],
    ["2a29", "Manufacturer"],
    ["2a27", "HardwareRevision"],
    ["2a26", "FirmwareRevision"],
    ["2a28", "SoftwareRevision"],
    ["2a24", "ModelNumber"],
    // Tracker Service
    ["00dbf1c690aa11eda1eb0242ac120002", "Sensor"],
    ["00dbf30690aa11eda1eb0242ac120002", "Magnetometer"],
    ["00dbf45090aa11eda1eb0242ac120002", "MainButton"],
    ["00dbf58690aa11eda1eb0242ac120002", "SecondaryButton"],
    // Setting Service
    ["ef84420290a911eda1eb0242ac120002", "FpsSetting"],
    ["ef8443f690a911eda1eb0242ac120002", "TofSetting"],
    ["ef8445c290a911eda1eb0242ac120002", "SensorModeSetting"],
    ["ef84c30090a911eda1eb0242ac120002", "WirelessModeSetting"],
    ["ef84c30590a911eda1eb0242ac120002", "AutoCalibrationSetting"],
    //["ef843b5490a911eda1eb0242ac120002", "Something"], unsure what this is, reports randomly like battery level
]);

type ActiveDevice = [string, Peripheral, Service[], Characteristic[]];
let activeDevices: ActiveDevice[] = [];

let allowReconnect = true;

export default class Bluetooth extends EventEmitter {
    constructor(debugMode = 0) {
        super();
        noble.on("discover", this.onDiscover.bind(this));
        debug = debugMode;
        bluetooth = this;
        console.log(`(haritorax-interpreter) - Debug mode for BT: ${debug}`);
    }

    startConnection() {
        log("Connected to bluetooth");

        if (noble.state === "poweredOn") {
            try {
                noble.startScanning([], true);
                this.emit("connected");
                return true;
            } catch (err) {
                error(`Error starting scanning of BT devices:\n${err}`);
                return false;
            }
        } else {
            noble.on("stateChange", (state) => {
                if (state === "poweredOn") {
                    try {
                        noble.startScanning([], true);
                        this.emit("connected");
                        return true;
                    } catch (err) {
                        error(`Error starting scanning of BT devices:\n${err}`);
                        return false;
                    }
                }
            });
            return true;
        }
    }

    onDiscover(peripheral: Peripheral) {
        const {
            advertisement: { localName },
        } = peripheral;
        if (
            localName &&
            localName.startsWith("HaritoraX") &&
            (!activeDevices.find((device) => device[1] === peripheral) ||
                !activeDevices.find((device) => device[0] === localName))
        ) {
            log(`Found device: ${localName}`);
            if (localName.startsWith("HaritoraX-"))
                log(
                    "HaritoraX (1.0/1.1/1.1b) detected. Device is not fully supported and you may experience issues."
                );

            activeDevices.push([localName, peripheral, [], []]);

            peripheral.connect((err: any) => {
                if (err) {
                    error(`Error connecting to ${localName}: ${err}`);
                    return;
                }
                log(`(bluetooth) Connected to ${localName}`);
                this.emit("connect", peripheral);

                const activeServices: any[] = [];
                const activeCharacteristics: any[] = [];

                peripheral.discoverServices(null, (err: any, services: any[]) => {
                    if (err) {
                        error(`Error discovering services: ${err}`);
                        return;
                    }

                    services.forEach(
                        (service: {
                            discoverCharacteristics: (
                                arg0: any[],
                                arg1: (error: any, characteristics: any) => void
                            ) => void;
                            uuid: any;
                        }) => {
                            activeServices.push(service);
                            service.discoverCharacteristics(
                                [],
                                (err: any, characteristics: any[]) => {
                                    if (err) {
                                        error(
                                            `Error discovering characteristics of service ${service.uuid}: ${err}`
                                        );
                                        return;
                                    }

                                    characteristics.forEach(
                                        (characteristic: {
                                            on: (arg0: string, arg1: (data: any) => void) => void;
                                            uuid: any;
                                            subscribe: (arg0: (err: any) => void) => void;
                                        }) => {
                                            activeCharacteristics.push(characteristic);
                                            characteristic.on("data", (data: any) => {
                                                emitData(
                                                    this,
                                                    localName,
                                                    service.uuid,
                                                    characteristic.uuid,
                                                    data
                                                );
                                            });
                                            characteristic.subscribe((err: any) => {
                                                if (err) {
                                                    error(
                                                        `Error subscribing to characteristic ${characteristic.uuid} of service ${service.uuid}: ${err}`
                                                    );
                                                }
                                            });
                                        }
                                    );
                                }
                            );
                        }
                    );
                    const deviceIndex = activeDevices.findIndex(
                        (device) => device[0] === localName
                    );
                    if (deviceIndex !== -1) {
                        activeDevices[deviceIndex] = [
                            localName,
                            peripheral,
                            activeServices,
                            activeCharacteristics,
                        ];
                    } else {
                        activeDevices.push([
                            localName,
                            peripheral,
                            activeServices,
                            activeCharacteristics,
                        ]);
                    }
                });
            });

            peripheral.on("disconnect", () => {
                if (!allowReconnect) return;
                log(`Disconnected from ${localName}`);
                this.emit("disconnect", peripheral);
                const index = activeDevices.findIndex((device) => device[1] === peripheral);
                if (index !== -1) {
                    activeDevices.splice(index, 1);
                }

                setTimeout(() => {
                    noble.startScanning([], true);
                }, 3000);
            });
        }
    }

    stopConnection() {
        try {
            noble.stopScanning();
            for (let device of activeDevices) {
                log(`Disconnecting from BT device ${device[0]}`);
                device[1].disconnect();
            }
        } catch (err) {
            error(`Error while closing bluetooth connection: ${err}`);
            return false;
        }

        activeDevices = [];
        allowReconnect = false;

        this.emit("disconnected");
        log("Disconnected from bluetooth");
        return true;
    }

    async read(localName: string, service: string, characteristic: string): Promise<any> {
        if (!activeDevices.find((device: ActiveDevice) => device[0] === localName)) {
            error(`Device ${localName} not found`);
            return null;
        }

        while (!(await areAllBLEDiscovered())) {
            log("Waiting for all services and characteristics to be discovered...");
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        log(`Reading characteristic ${characteristic} of service ${service}`);

        const device = activeDevices.find((device: ActiveDevice) => device[0] === localName);
        if (!device) {
            error(`Device ${localName} not found`);
            throw new Error(`Device ${localName} not found`);
        }

        const serviceInstance = device[2].find((s: Service) => s.uuid === service);
        if (!serviceInstance) {
            error(`Service ${service} not found`);
            throw new Error(`Service ${service} not found`);
        }

        const characteristicInstance = device[3].find(
            (c: Characteristic) => c.uuid === characteristic
        );
        if (!characteristicInstance) {
            error(`Characteristic ${characteristic} not found`);
            throw new Error(`Characteristic ${characteristic} not found`);
        }

        return new Promise((resolve, reject) => {
            characteristicInstance.read((err: any, data: any) => {
                const characteristicName = characteristics.get(characteristic);
                if (err) {
                    error(`Error reading characteristic ${characteristicName}: ${err}`);
                    reject(err);
                    return;
                }

                const buffer = new Uint8Array(data).buffer;

                resolve(buffer);
            });
        });
    }

    async write(
        localName: string,
        service: string,
        characteristic: string,
        data: any
    ): Promise<void> {
        while (!(await areAllBLEDiscovered())) {
            log("Waiting for all services and characteristics to be discovered...");
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        log(
            `Writing to characteristic ${characteristic} of service ${service} for device ${localName}`
        );
        const device = activeDevices.find((device: ActiveDevice) => device[0] === localName);
        if (!device) {
            error(`Device ${localName} not found`);
            throw new Error(`Device ${localName} not found`);
        }

        const serviceInstance = device[2].find((s: Service) => s.uuid === service);
        if (!serviceInstance) {
            error(`Service ${service} not found`);
            throw new Error(`Service ${service} not found`);
        }

        const characteristicInstance = device[3].find(
            (c: Characteristic) => c.uuid === characteristic
        );
        if (!characteristicInstance) {
            error(`Characteristic ${characteristic} not found`);
            throw new Error(`Characteristic ${characteristic} not found`);
        }

        return new Promise((resolve, reject) => {
            characteristicInstance.write(data, false, (err: any) => {
                if (err) {
                    error(`Error writing to characteristic ${characteristic}: ${err}`);
                    reject(err);
                    return;
                }

                log(`Wrote data to characteristic ${characteristic}`);
                resolve();
            });
        });
    }

    getServices() {
        return services;
    }

    getCharacteristics() {
        return characteristics;
    }

    getActiveDevices() {
        return activeDevices;
    }

    getAllowReconnect() {
        return allowReconnect;
    }

    getActiveTrackers() {
        return activeDevices.map((device) => device[0]);
    }

    getServiceUUID(name: string) {
        for (let [uuid, serviceName] of services) {
            if (serviceName === name) {
                return uuid;
            }
        }
        return null;
    }

    getCharacteristicUUID(name: string) {
        for (let [uuid, characteristicName] of characteristics) {
            if (characteristicName === name) {
                return uuid;
            }
        }
        return null;
    }

    getDeviceInfo(localName: any) {
        for (let device of activeDevices) {
            if (device[0] === localName) {
                return device;
            }
        }
        return null;
    }
}

const importantServices = ["ef84369a90a911eda1eb0242ac120002", "180f"];
const importantCharacteristics = [
    "2a19",
    "ef84420290a911eda1eb0242ac120002",
    "ef8443f690a911eda1eb0242ac120002",
    "ef8445c290a911eda1eb0242ac120002",
    "ef84c30090a911eda1eb0242ac120002",
    "ef84c30590a911eda1eb0242ac120002",
];

async function areAllBLEDiscovered(): Promise<boolean> {
    for (const serviceUuid of importantServices) {
        if (
            !activeDevices.find((device: any) =>
                device[2].find((service: any) => service.uuid === serviceUuid)
            )
        ) {
            return false;
        }
    }

    for (const characteristicUuid of importantCharacteristics) {
        if (
            !activeDevices.find((device: any) =>
                device[3].find((characteristic: any) => characteristic.uuid === characteristicUuid)
            )
        ) {
            return false;
        }
    }

    return true;
}

function emitData(
    classInstance: Bluetooth,
    localName: any,
    service: string,
    characteristic: string,
    data: any
) {
    classInstance.emit(
        "data",
        localName,
        services.get(service) || service,
        characteristics.get(characteristic) || characteristic,
        data
    );
}

/*
 * Helper functions
 */

function log(message: string) {
    bluetooth.emit("log", message);
}

function error(message: string) {
    bluetooth.emit("logError", message);
}

export { Bluetooth };
