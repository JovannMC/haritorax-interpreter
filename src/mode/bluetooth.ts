"use strict";

import { characteristics, services } from "../libs/common";

import noble, { Characteristic, Peripheral, Service } from "@abandonware/noble";
import { EventEmitter } from "events";

let main: Bluetooth = undefined;

type ActiveDevice = [string, Peripheral, Service[], Characteristic[]];
let activeDevices: ActiveDevice[] = [];
let allowReconnect = true;

// TODO: stop scanning while connecting for certain adapters
// https://github.com/abandonware/noble?tab=readme-ov-file#adapter-specific-known-issues

export default class Bluetooth extends EventEmitter {
    constructor() {
        super();
        main = this;
        log(`Initialized Bluetooth module.`);
    }
    async isDeviceAvailable() {
        try {
            if (noble._state === "poweredOn") return true;

            return new Promise<boolean>((resolve) => {
                const timeout = setTimeout(() => resolve(false), 3000);

                noble.on("stateChange", (state) => {
                    clearTimeout(timeout);
                    noble.removeAllListeners("stateChange");
                    resolve(state === "poweredOn");
                });
            });
        } catch (err) {
            return false;
        }
    }

    async getAvailableDevices() {
        try {
            if (noble._state !== "poweredOn") {
                await new Promise<void>((resolve) => {
                    const timeout = setTimeout(() => resolve(), 3000);
                    noble.on("stateChange", (state) => {
                        if (state === "poweredOn") {
                            clearTimeout(timeout);
                            noble.removeAllListeners("stateChange");
                            resolve();
                        }
                    });
                });
            }

            await noble.startScanningAsync([], true);

            const scanTimeout = setTimeout(async () => {
                await noble.stopScanningAsync();
            }, 3000);

            const peripheral = await new Promise<any>((resolve) => {
                noble.on("discover", (peripheral) => {
                    if (
                        peripheral.advertisement.localName &&
                        (peripheral.advertisement.localName.startsWith("HaritoraXW-") ||
                            peripheral.advertisement.localName.startsWith("HaritoraX2-"))
                    ) {
                        clearTimeout(scanTimeout);
                        noble.removeAllListeners("discover");
                        resolve(peripheral);
                    }
                });

                setTimeout(() => {
                    noble.removeAllListeners("discover");
                    resolve(null);
                }, 3000);
            });

            await noble.stopScanningAsync();
            return peripheral ? ["HaritoraX Wireless"] : null;
        } catch (err) {
            error(`Error getting available devices: ${err}`);
            await noble.stopScanningAsync().catch(() => {});
            return null;
        }
    }

    async startConnection() {
        try {
            log("Starting Bluetooth connection...");

            if (noble._state !== "poweredOn") {
                await new Promise<void>((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        noble.removeAllListeners("stateChange");
                        reject(new Error("Bluetooth initialization failed (timeout)"));
                    }, 5000);

                    noble.on("stateChange", (state) => {
                        if (state === "poweredOn") {
                            clearTimeout(timeout);
                            noble.removeAllListeners("stateChange");
                            resolve();
                        }
                    });
                });
            }

            allowReconnect = true;
            await noble.startScanningAsync([], true);
            this.emit("connected");

            log("Connected to bluetooth");

            noble.on("discover", (peripheral) => {
                // add delay to prevent overwhelming the adapter
                setTimeout(() => {
                    this.onDiscover(peripheral);
                }, 500);
            });
        } catch (err) {
            error(`Error starting Bluetooth connection: ${err}`, true);
        }
    }

    private async onDiscover(peripheral: Peripheral) {
        const {
            advertisement: { localName },
        } = peripheral;
        if (!localName || (!localName.startsWith("HaritoraX2") && !localName.startsWith("HaritoraXW-"))) return;

        const deviceExists = activeDevices.some((device) => device[0] === localName || device[1] === peripheral);
        if (deviceExists) return;

        log(`Found device: ${localName}`);

        updateActiveDevices(localName, peripheral, [], []);
        try {
            await peripheral.connectAsync();
            log(`Connected to ${localName}, waiting before service discovery...`);

            await new Promise((resolve) => setTimeout(resolve, 1000));

            const { services, characteristics } = await peripheral.discoverAllServicesAndCharacteristicsAsync();
            log(`Found ${services.length} services and ${characteristics.length} characteristics for ${localName}`);

            characteristics.forEach((characteristic) => {
                // find the service that contains this characteristic
                const service = services.find((s) => s.characteristics.includes(characteristic));
                if (!service) {
                    error(`Could not find service for characteristic ${characteristic.uuid}`);
                    return;
                }

                characteristic.on("data", (data, isNotification) => {
                    emitData(localName, service.uuid, characteristic.uuid, data);
                });

                // subscribe to notifications if the characteristic supports it
                if (characteristic.properties.includes("notify") || characteristic.properties.includes("indicate")) {
                    characteristic.subscribeAsync().catch((err) => {
                        error(`Error subscribing to characteristic ${characteristic.uuid}: ${err}`);
                    });
                }
            });

            updateActiveDevices(localName, peripheral, services, characteristics);

            log(`Connected to ${localName}`);
            this.emit("connect", localName);
        } catch (err) {
            error(`Error during Bluetooth discovery/connection process: ${err}`, true);
        }

        peripheral.on("disconnect", () => {
            log(`Disconnected from ${localName}`);
            this.emit("disconnect", localName);
            const index = activeDevices.findIndex((device) => device[1] === peripheral);
            if (index !== -1) {
                activeDevices.splice(index, 1);
            }
            if (!allowReconnect) return;
            setTimeout(() => {
                noble.startScanningAsync([], true);
            }, 3000);
        });
    }

    stopConnection() {
        try {
            noble.stopScanning();
            activeDevices.forEach(([id, device]) => {
                log(`Disconnecting from BT device ${id}`);

                try {
                    device.disconnect();
                } catch (err) {
                    error(`Error disconnecting from Bluetooth device ${id}: ${err}`, true);
                }
            });
            activeDevices = [];
            allowReconnect = false;
            this.emit("disconnected");
            log("Disconnected from bluetooth");
        } catch (err) {
            error(`Error while closing Bluetooth connection: ${err}`, true);
        }
    }
    async read(localName: string, service: string, characteristic: string): Promise<ArrayBufferLike> {
        const device = await getDevice(localName);
        const serviceInstance = getService(device, service);
        const characteristicInstance = getCharacteristic(serviceInstance, characteristic);

        return await characteristicInstance.readAsync();
    }

    async write(localName: string, service: string, characteristic: string, data: any): Promise<void> {
        const device = await getDevice(localName);
        const serviceInstance = getService(device, service);
        const characteristicInstance = getCharacteristic(serviceInstance, characteristic);

        const withoutResponse = characteristicInstance.properties.includes("writeWithoutResponse");
        return await characteristicInstance.writeAsync(data, withoutResponse);
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
    const finalMessage = `(Bluetooth) ${message}`;
    console.log(finalMessage);
    main.emit("log", finalMessage);
}

function error(message: string, exceptional = false) {
    const finalError = `(Bluetooth) ${message}`;
    console.error(finalError);
    main.emit("logError", { message: finalError, exceptional });
}

function updateActiveDevices(localName: string, peripheral: Peripheral, services: Service[], characteristics: Characteristic[]) {
    const deviceIndex = activeDevices.findIndex((device) => device[0] === localName);
    const deviceData: ActiveDevice = [localName, peripheral, services, characteristics];
    if (deviceIndex !== -1) activeDevices[deviceIndex] = deviceData;
    else activeDevices.push(deviceData);
}

async function getDevice(localName: string): Promise<ActiveDevice> {
    const normalizedLocalName = localName.replace("-ext", "");
    const device = activeDevices.find((device: ActiveDevice) => device[0] === normalizedLocalName);
    if (!device) error(`Device ${normalizedLocalName} not found, list: ${activeDevices}`, true);

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

export { Bluetooth };
