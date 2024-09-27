"use strict";

import { services, characteristics } from "../libs/common";

import noble, { Peripheral, Service, Characteristic, _state } from "@abandonware/noble";
import { EventEmitter } from "events";

let main: Bluetooth = undefined;

type ActiveDevice = [string, Peripheral, Service[], Characteristic[]];
let activeDevices: ActiveDevice[] = [];

let allowReconnect = true;

export default class Bluetooth extends EventEmitter {
    constructor() {
        super();
        noble.on("discover", this.onDiscover.bind(this));
        main = this;
        log(`Initialized Bluetooth module.`);
    }

    async isDeviceAvailable() {
        return new Promise<Boolean>((resolve) => {
            if (noble._state === "poweredOn") {
                resolve(true);
            } else {
                const timeout = setTimeout(() => {
                    resolve(false);
                }, 3000);

                noble.on("stateChange", (state) => {
                    clearTimeout(timeout);
                    if (state === "poweredOn") {
                        resolve(true);
                    } else {
                        resolve(false);
                    }
                });
            }
        });
    }

    async getAvailableDevices() {
        return new Promise<string[]>((resolve) => {
            let found = false;
            let availableDevices = [];

            noble.on("discover", (peripheral) => {
                if (peripheral.advertisement.localName && peripheral.advertisement.localName.startsWith("HaritoraXW-")) {
                    availableDevices.push("HaritoraX Wireless");
                    found = true;
                    noble.removeAllListeners();
                    noble.stopScanning();
                    resolve(availableDevices);
                }
            });

            noble.on("stateChange", (state) => {
                if (state === "poweredOn" && !found) {
                    noble.startScanning([], true);

                    setTimeout(() => {
                        if (!found) {
                            noble.stopScanning();
                            noble.removeAllListeners();
                            resolve(null);
                        }
                    }, 3000);
                } else if (noble._state !== "poweredOn") {
                    noble.removeAllListeners();
                    resolve(null);
                }
            });

            // Fail-safe if noble never initializes properly (no "stateChange" event fired)
            setTimeout(() => {
                noble.stopScanning();
                noble.removeAllListeners();
                resolve(null);
            }, 3500);
        });
    }

    startConnection() {
        const startScanning = () => {
            try {
                allowReconnect = true;
                noble.startScanning([], true);
                this.emit("connected");
            } catch (err) {
                error(`Error starting bluetooth scanning: ${err}`, true);
            }
        };

        log("Connected to bluetooth");

        if (noble._state === "poweredOn") {
            return startScanning();
        } else {
            noble.on("stateChange", (state) => {
                if (state === "poweredOn") {
                    clearTimeout(connectionTimeout);
                    return startScanning();
                }
            });

            // Fail-safe if noble never initializes properly (no "stateChange" event fired)
            const connectionTimeout = setTimeout(() => {
                noble.stopScanning();
                noble.removeAllListeners();
                error("Bluetooth initialization failed (timeout)", true);
            }, 3500);
        }
    }

    private async onDiscover(peripheral: Peripheral) {
        const {
            advertisement: { localName },
        } = peripheral;
        if (!localName || !localName.startsWith("HaritoraXW-")) return;

        const deviceExists = activeDevices.some((device) => device[0] === localName || device[1] === peripheral);
        if (deviceExists) return;

        log(`Found device: ${localName}`);

        updateActiveDevices(localName, peripheral, [], []);

        try {
            await connectPeripheral(peripheral);

            const { services, characteristics } = await discoverServicesAndCharacteristics(peripheral);
            updateActiveDevices(localName, peripheral, services, characteristics);

            log(`(bluetooth) Connected to ${localName}`);
            this.emit("connect", localName);
        } catch (err) {
            error(`Error during discovery/connection process: ${err}`, true);
        }

        peripheral.on("disconnect", () => {
            log(`(bluetooth) Disconnected from ${localName}`);
            this.emit("disconnect", localName);
            const index = activeDevices.findIndex((device) => device[1] === peripheral);
            if (index !== -1) {
                activeDevices.splice(index, 1);
            }

            if (!allowReconnect) return;
            setTimeout(() => {
                noble.startScanning([], true);
            }, 3000);
        });
    }

    stopConnection() {
        try {
            noble.stopScanning();
            activeDevices.forEach(([id, device]) => {
                log(`Disconnecting from BT device ${id}`);
                device.disconnect();
            });
            activeDevices = [];
            allowReconnect = false;
            this.emit("disconnected");
            log("Disconnected from bluetooth");
        } catch (err) {
            error(`Error while closing bluetooth connection: ${err}`, true);
        }
    }

    async read(localName: string, service: string, characteristic: string): Promise<ArrayBufferLike> {
        const device = await getDevice(localName);
        const serviceInstance = getService(device, service);
        const characteristicInstance = getCharacteristic(serviceInstance, characteristic);

        return readCharacteristic(characteristicInstance);
    }

    async write(localName: string, service: string, characteristic: string, data: any): Promise<void> {
        const device = await getDevice(localName);
        const serviceInstance = getService(device, service);
        const characteristicInstance = getCharacteristic(serviceInstance, characteristic);

        await writeCharacteristic(characteristicInstance, data);
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

    getDeviceInfo(localName: string) {
        for (let device of activeDevices) {
            if (device[0] === localName) {
                return device;
            }
        }
        return null;
    }
}

/*
 * startConnection() helper functions
 */

async function connectPeripheral(peripheral: Peripheral): Promise<void> {
    return new Promise((resolve, reject) => {
        peripheral.connect((err) => {
            if (err) reject(`Error connecting to ${peripheral.advertisement.localName}: ${err}`);
            else resolve();
        });
    });
}

async function discoverServicesAndCharacteristics(peripheral: Peripheral): Promise<any> {
    const services = await discoverServices(peripheral);
    const characteristics = await Promise.all(
        services.map((service) => discoverCharacteristics(peripheral.advertisement.localName, service))
    );

    return { services, characteristics: characteristics.flat() };
}

async function discoverServices(peripheral: Peripheral): Promise<Service[]> {
    return new Promise((resolve, reject) => {
        peripheral.discoverServices(null, (err, services) => {
            if (err) reject(`Error discovering services: ${err}`);
            else resolve(services);
        });
    });
}

async function discoverCharacteristics(localName: string, service: Service) {
    return new Promise((resolve, reject) => {
        service.discoverCharacteristics([], (err, characteristics) => {
            if (err) {
                reject(`Error discovering characteristics for service ${service.uuid}: ${err}`);
                return;
            }
            characteristics.forEach((characteristic) => {
                characteristic.on("data", (data) => {
                    emitData(localName, service.uuid, characteristic.uuid, data);
                });
                characteristic.subscribe((err) => {
                    if (err) error(`Error subscribing to characteristic ${characteristic.uuid}: ${err}`);
                });
            });
            resolve(characteristics);
        });
    });
}

function updateActiveDevices(localName: string, peripheral: Peripheral, services: Service[], characteristics: Characteristic[]) {
    const deviceIndex = activeDevices.findIndex((device) => device[0] === localName);
    const deviceData: ActiveDevice = [localName, peripheral, services, characteristics];
    if (deviceIndex !== -1) activeDevices[deviceIndex] = deviceData;
    else activeDevices.push(deviceData);
}

/*
 * read() and write() helper functions
 */

async function readCharacteristic(characteristicInstance: Characteristic): Promise<ArrayBufferLike> {
    return new Promise((resolve, reject) => {
        characteristicInstance.read((err: any, data: any) => {
            if (err) {
                error(`Error reading characteristic ${characteristicInstance.uuid}: ${err}`);
                reject(err);
                return;
            }
            resolve(new Uint8Array(data).buffer);
        });
    });
}

async function writeCharacteristic(characteristicInstance: Characteristic, data: any): Promise<void> {
    return new Promise((resolve, reject) => {
        characteristicInstance.write(data, false, (err) => {
            if (err) {
                error(`Error writing to characteristic ${characteristicInstance.uuid}: ${err}`);
                reject(err);
                return;
            }
            log(`Wrote data to characteristic ${characteristicInstance.uuid}`);
            resolve();
        });
    });
}

async function getDevice(localName: string): Promise<ActiveDevice> {
    const device = activeDevices.find((device: ActiveDevice) => device[0] === localName);
    if (!device) error(`Device ${localName} not found, list: ${activeDevices}`, true);

    return device;
}

function getService(device: ActiveDevice, service: string): Service {
    const serviceInstance = device[2].find((s) => s.uuid === service);
    if (!serviceInstance) error(`Service ${service} not found for ${device[0]}, service list: ${device[2]}`, true);
    return serviceInstance;
}

function getCharacteristic(service: Service, characteristic: string): Characteristic {
    const characteristicInstance = service.characteristics.find((c) => c.uuid === characteristic);
    if (!characteristicInstance)
        error(
            `Characteristic ${characteristic} not found for ${service.uuid}, characteristic list: ${service.characteristics}`,
            true
        );
    return characteristicInstance;
}

/*
 * General helper functions
 */

function emitData(localName: string, service: string, characteristic: string, data: any) {
    main.emit("data", localName, services.get(service) || service, characteristics.get(characteristic) || characteristic, data);
    main.emit(
        "dataRaw",
        localName,
        services.get(service) || service,
        characteristics.get(characteristic) || characteristic,
        data
    );
}

function log(message: string) {
    main.emit("log", message);
}

function error(message: string, exceptional = false) {
    main.emit("logError", { message, exceptional });
}

export { Bluetooth };
