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

let activeDevices = [];
let activeServices = [];
let activeCharacteristics = [];

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

    onDiscover(peripheral) {
        const { advertisement: { localName } } = peripheral;
        if (localName && localName.startsWith("HaritoraXW-") && !activeDevices.includes(peripheral)) {
            console.log(`Found device: ${localName}`);
            activeDevices.push(peripheral);

            peripheral.connect(error => {
                if (error) {
                    console.error(`Error connecting to ${localName}:`, error);
                    return;
                }
                console.log(`Connected to ${localName}`);
                this.emit("connected", peripheral);
                
                peripheral.discoverServices(null, (error, services) => {
                    if (error) {
                        console.error("Error discovering services:", error);
                        return;
                    }
                    //console.log("Discovered services:", services);
                
                    services.forEach(service => {
                        activeServices.push(service);
                        service.discoverCharacteristics([], (error, characteristics) => {
                            if (error) {
                                console.error(`Error discovering characteristics of service ${service.uuid}:`, error);
                                return;
                            }
                            //console.log(`Discovered characteristics of service ${service.uuid}:`, characteristics);
                
                            characteristics.forEach(characteristic => {
                                activeCharacteristics.push(characteristic);
                                characteristic.on("data", (data) => {
                                    emitData(this, localName, service.uuid, characteristic.uuid, data);
                                });
                                characteristic.subscribe(error => {
                                    if (error) {
                                        console.error(`Error subscribing to characteristic ${characteristic.uuid} of service ${service.uuid}:`, error);
                                    }
                                });
                            });
                        });
                    });
                });

            });

            peripheral.on("disconnect", () => {
                if (!allowReconnect) return;
                console.log(`Disconnected from ${localName}`);
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
        console.log("Disconnected from bluetooth");
        noble.stopScanning();
        for (let device of activeDevices) {
            device.disconnect();
        }
        activeDevices = [];
        allowReconnect = false;
        
        this.emit("disconnected");
    }

    readData(localName, serviceId, characteristicId) {
        return new Promise((resolve, reject) => {
            const device = this.getDeviceInfo(localName);
            if (device) {
                console.log("Device found");
                for (let service of activeServices) {
                    if (service.uuid === serviceId) {
                        for (let characteristic of service.characteristics) {
                            if (characteristic.uuid === characteristicId) {
                                console.log(`Reading characteristic ${characteristic.uuid} of service ${service.uuid}...`);
                                characteristic.read((error, data) => {
                                    if (error) {
                                        console.error(`Error reading characteristic ${characteristic.uuid} of service ${service.uuid}:`, error);
                                        reject(error);
                                    } else {
                                        console.log(`Read characteristic ${characteristic.uuid} of service ${service.uuid}:`, data);
                                        resolve(data);
                                    }
                                });
                                return;
                            }
                        }
                    }
                }
            }
            reject(new Error("Device not found"));
        });
    }

    // TODO make sure this actually works (github copilot written lol)
    writeData(localName, service, characteristic, data) {
        const device = this.getDeviceInfo(localName);
        if (device) {
            for (let service of activeServices) {
                if (service.uuid === service) {
                    for (let characteristic of service.characteristics) {
                        if (characteristic.uuid === characteristic) {
                            characteristic.write(data, true, (error) => {
                                if (error) {
                                    console.error(`Error writing characteristic ${characteristic.uuid} of service ${service.uuid}:`, error);
                                }
                            });
                        }
                    }
                }
            }
        }
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

    getDeviceInfo(localName) {
        for (let device of activeDevices) {
            if (device.advertisement.localName === localName) {
                return device;
            }
        }
        return null;
    }
}

function emitData(classInstance, localName, service, characteristic, data) {
    classInstance.emit("data", localName, services.get(service), characteristics.get(characteristic), data);
}

export { Bluetooth };