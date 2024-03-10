"use strict";

import noble from "@abandonware/noble";
import { EventEmitter } from "events";

const services = new Map([
    ["1800", "Generic Access"],
    ["1801", "Generic Attribute"],
    ["180a", "Device Information"],
    ["180f", "Battery Service"],
    ["00dbec3a90aa11eda1eb0242ac120002", "Tracker Service"],
    ["ef84369a90a911eda1eb0242ac120002", "Setting Service"]
]);

const characteristics = new Map([
    ["00002a1900001000800000805f9b34fb", "Battery"],
    ["00002a2800001000800000805f9b34fb", "SoftwareRevision"],
    ["00dbf1c690aa11eda1eb0242ac120002", "Sensor"],
    ["00dbf30690aa11eda1eb0242ac120002", "Magnetometer"],
    ["00dbf45090aa11eda1eb0242ac120002", "MainButton"],
    ["00dbf58690aa11eda1eb0242ac120002", "SecondaryButton"],
    ["ef84420290a911eda1eb0242ac120002", "FpsSetting"],
    ["ef8443f690a911eda1eb0242ac120002", "TofSetting"],
    ["ef8445c290a911eda1eb0242ac120002", "SensorModeSetting"],
    ["ef84c30090a911eda1eb0242ac120002", "WirelessModeSetting"],
    ["ef84c30590a911eda1eb0242ac120002", "AutoCalibrationSetting"]
]);

let activeDevices = [];

// TODO - multiple trackers

export default class Bluetooth extends EventEmitter {
    constructor() {
        super();
        noble.on("discover", this.onDiscover.bind(this));
    }
    
    startConnection() {
        console.log("Connected to bluetooth");
        this.emit("connected");
        noble.startScanning([], true);
    }

    onDiscover(peripheral) {
        const { advertisement: { localName } } = peripheral;
        if (localName && localName.startsWith("HaritoraXW-") && !activeDevices.includes(peripheral)) {
            console.log(`Found device: ${localName}`);
    
            peripheral.connect(error => {
                if (error) {
                    console.error(`Error connecting to ${localName}:`, error);
                    return;
                }
                console.log(`Connected to ${localName}`);
                this.emit("connected", peripheral);
                activeDevices.push(peripheral);
    
                peripheral.discoverServices(null, (error, services) => {
                    if (error) {
                        console.error("Error discovering services:", error);
                        return;
                    }
                    //console.log("Discovered services:", services);
                
                    services.forEach(service => {
                        service.discoverCharacteristics(null, (error, characteristics) => {
                            if (error) {
                                console.error(`Error discovering characteristics of service ${service.uuid}:`, error);
                                return;
                            }
                            //console.log(`Discovered characteristics of service ${service.uuid}:`, characteristics);
                
                            characteristics.forEach(characteristic => {
                                characteristic.on("data", (data) => {
                                    emitData(this, localName, service.uuid, characteristic.uuid, data);
                                });
                                characteristic.subscribe(error => {
                                    if (error) {
                                        console.error(`Error subscribing to characteristic ${characteristic.uuid}:`, error);
                                    }
                                });
                            });
                        });
                    });
                });

            });

            peripheral.on("disconnect", () => {
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
        
        this.emit("disconnected");
    }

    getServices() {
        return services;
    }

    getCharacteristics() {
        return characteristics;
    }
}

function emitData(classInstance, localName, service, characteristic, data) {
    //console.log(`Data from ${services.get(service)} - ${characteristics.get(characteristic)}:`, data);
    classInstance.emit("data", localName, services.get(service), characteristics.get(characteristic), data);
}

export { Bluetooth };