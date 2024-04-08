"use strict";

import noble from "@abandonware/noble";
import { EventEmitter } from "events";

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
    // Sensor Service
    ["00002a1900001000800000805f9b34fb", "Battery"],
    ["00002a2800001000800000805f9b34fb", "SoftwareRevision"],
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

let activeDevices: any[] = [];
let activeServices: any[] = [];
let activeCharacteristics: any[] = [];

let allowReconnect = true;

export default class Bluetooth extends EventEmitter {
    constructor() {
        super();
        noble.on("discover", this.onDiscover.bind(this));
    }

    startConnection() {
        console.log("Connected to bluetooth");
        this.emit("connected");

        try {
            noble.startScanning([], true);
        } catch (error) {
            console.error(`Error starting scanning:\n${error}`);
        }
    }

    onDiscover(peripheral: {
        connect?: any;
        discoverServices?: any;
        on?: any;
        advertisement?: any;
    }) {
        const {
            advertisement: { localName },
        } = peripheral;
        if (
            localName &&
            localName.startsWith("HaritoraX") &&
            !activeDevices.includes(peripheral)
        ) {
            console.log(`(haritorax-interpreter) - Found device: ${localName}`);
            // I do not have any device other than the wireless device, so I cannot test this
            if (localName.startsWith("HaritoraX-"))
                console.log(
                    "(haritorax-interpreter) - HaritoraX (1.0/1.1/1.1b) detected. Device is not fully supported and you may experience issues."
                );
            activeDevices.push(peripheral);

            peripheral.connect((error: any) => {
                if (error) {
                    console.error(
                        `(haritorax-interpreter) - Error connecting to ${localName}:`,
                        error
                    );
                    return;
                }
                console.log(
                    `(haritorax-interpreter) - Connected to ${localName}`
                );
                this.emit("connect", peripheral);

                peripheral.discoverServices(
                    null,
                    (error: any, services: any[]) => {
                        if (error) {
                            console.error(
                                "(haritorax-interpreter) - Error discovering services:",
                                error
                            );
                            return;
                        }
                        //console.log("(haritorax-interpreter) - Discovered services:", services);

                        services.forEach(
                            (service: {
                                discoverCharacteristics: (
                                    arg0: any[],
                                    arg1: (
                                        error: any,
                                        characteristics: any
                                    ) => void
                                ) => void;
                                uuid: any;
                            }) => {
                                activeServices.push(service);
                                service.discoverCharacteristics(
                                    [],
                                    (error: any, characteristics: any[]) => {
                                        if (error) {
                                            console.error(
                                                `(haritorax-interpreter) - Error discovering characteristics of service ${service.uuid}:`,
                                                error
                                            );
                                            return;
                                        }
                                        //console.log(`(haritorax-interpreter) - Discovered characteristics of service ${service.uuid}:`, characteristics);

                                        characteristics.forEach(
                                            (characteristic: {
                                                on: (
                                                    arg0: string,
                                                    arg1: (data: any) => void
                                                ) => void;
                                                uuid: any;
                                                subscribe: (
                                                    arg0: (error: any) => void
                                                ) => void;
                                            }) => {
                                                activeCharacteristics.push(
                                                    characteristic
                                                );
                                                characteristic.on(
                                                    "data",
                                                    (data: any) => {
                                                        emitData(
                                                            this,
                                                            localName,
                                                            service.uuid,
                                                            characteristic.uuid,
                                                            data
                                                        );
                                                    }
                                                );
                                                characteristic.subscribe(
                                                    (error: any) => {
                                                        if (error) {
                                                            console.error(
                                                                `(haritorax-interpreter) - Error subscribing to characteristic ${characteristic.uuid} of service ${service.uuid}:`,
                                                                error
                                                            );
                                                        }
                                                    }
                                                );
                                            }
                                        );
                                    }
                                );
                            }
                        );
                    }
                );
            });

            peripheral.on("disconnect", () => {
                if (!allowReconnect) return;
                console.log(
                    `(haritorax-interpreter) - Disconnected from ${localName}`
                );
                this.emit("disconnect", peripheral);
                const index = activeDevices.indexOf(peripheral);
                if (index !== -1) {
                    activeDevices.splice(index, 1);
                }

                // search again
                setTimeout(() => {
                    noble.startScanning([], true);
                }, 3000);
            });
        }
    }

    stopConnection() {
        console.log("(haritorax-interpreter) - Disconnected from bluetooth");
        noble.stopScanning();
        for (let device of activeDevices) {
            device.disconnect();
        }
        activeDevices = [];
        allowReconnect = false;

        this.emit("disconnected");
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

    getActiveServices() {
        return activeServices;
    }

    getActiveCharacteristics() {
        return activeCharacteristics;
    }

    getAllowReconnect() {
        return allowReconnect;
    }

    getActiveTrackers() {
        return activeDevices.map((device) => device.advertisement.localName);
    }

    getDeviceInfo(localName: any) {
        for (let device of activeDevices) {
            if (device.advertisement.localName === localName) {
                return device;
            }
        }
        return null;
    }
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
        services.get(service),
        characteristics.get(characteristic),
        data
    );
}

export { Bluetooth };