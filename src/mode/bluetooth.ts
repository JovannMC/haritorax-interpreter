"use strict";

import { characteristics, services } from "../libs/common";
import noble, { Characteristic, Peripheral, Service } from "@stoprocent/noble";
import { EventEmitter } from "events";

let main: Bluetooth = undefined;

type ActiveDevice = [string, Peripheral, Service[], Characteristic[]];
let activeDevices: ActiveDevice[] = [];
let allowReconnect = true;
let connectingDevices: Set<string> = new Set();

export default class Bluetooth extends EventEmitter {
    constructor() {
        super();
        main = this;
        log(`Initialized Bluetooth module.`);
    }

    async isDeviceAvailable(): Promise<boolean> {
        try {
            if (noble.state === "poweredOn") return true;

            return new Promise<boolean>((resolve) => {
                const timeout = setTimeout(() => {
                    noble.removeAllListeners("stateChange");
                    resolve(false);
                }, 3000);

                noble.on("stateChange", (state) => {
                    clearTimeout(timeout);
                    noble.removeAllListeners("stateChange");
                    resolve(state === "poweredOn");
                });
            });
        } catch (err) {
            error(`Error checking device availability: ${err}`);
            return false;
        }
    }

    async getAvailableDevices(): Promise<string[] | null> {
        try {
            // Wait for Bluetooth to be powered on
            if (noble.state !== "poweredOn") {
                await new Promise<void>((resolve) => {
                    const timeout = setTimeout(() => {
                        noble.removeAllListeners("stateChange");
                        resolve();
                    }, 3000);

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

            const deviceFound = await new Promise<boolean>((resolve) => {
                const scanTimeout = setTimeout(() => {
                    noble.removeAllListeners("discover");
                    resolve(false);
                }, 3000);

                noble.on("discover", (peripheral) => {
                    const { localName } = peripheral.advertisement;
                    if (localName && (localName.startsWith("HaritoraXW-") || localName.startsWith("HaritoraX2-"))) {
                        clearTimeout(scanTimeout);
                        noble.removeAllListeners("discover");
                        resolve(true);
                    }
                });
            });

            await noble.stopScanningAsync();
            return deviceFound ? ["HaritoraX Wireless"] : null;
        } catch (err) {
            error(`Error getting available devices: ${err}`);
            try {
                await noble.stopScanningAsync();
            } catch (stopErr) {
                error(`Error stopping scan after failure: ${stopErr}`);
            }
            return null;
        }
    }

    async startConnection(): Promise<void> {
        try {
            log("Starting Bluetooth connection...");

            // wait for Bluetooth to be powered on
            if (noble.state !== "poweredOn") {
                await new Promise<void>((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        noble.removeAllListeners("stateChange");
                        reject(new Error("Bluetooth initialization timeout"));
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

            noble.on("discover", (peripheral) => {
                // add delay to prevent overwhelming the adapter
                setTimeout(() => {
                    this.handleDeviceDiscovery(peripheral);
                }, 500);
            });

            await noble.startScanningAsync([], true);

            this.emit("connected");
            log("Bluetooth connection started - scanning for devices");
        } catch (err) {
            error(`Error starting Bluetooth connection: ${err}`, true);
            throw err;
        }
    }

    private async handleDeviceDiscovery(peripheral: Peripheral): Promise<void> {
        const { localName } = peripheral.advertisement;

        // filter for HaritoraX devices only
        if (!localName || (!localName.startsWith("HaritoraX2-") && !localName.startsWith("HaritoraXW-"))) {
            return;
        }

        const isAlreadyConnected = activeDevices.some((device) => device[0] === localName && device[1].state === "connected");
        const isCurrentlyConnecting = connectingDevices.has(localName);
        if (isAlreadyConnected || isCurrentlyConnecting) return;

        log(`Discovered device: ${localName}`);

        try {
            await this.connectToDevice(localName, peripheral);
        } catch (err) {
            error(`Failed to connect to ${localName}: ${err}`);
        }
    }

    private async connectToDevice(localName: string, peripheral: Peripheral): Promise<void> {
        connectingDevices.add(localName);

        updateActiveDevices(localName, peripheral, [], []);

        try {
            log(`Connecting to ${localName}...`);
            await peripheral.connectAsync();
            log(`Connected to ${localName}, discovering services...`);

            // Brief delay before service discovery
            await new Promise((resolve) => setTimeout(resolve, 1000));

            const { services, characteristics } = await peripheral.discoverAllServicesAndCharacteristicsAsync();
            log(`Discovered ${services.length} services and ${characteristics.length} characteristics for ${localName}`);

            // set up characteristic listeners and notifications
            characteristics.forEach((characteristic) => {
                const service = services.find((s) => s.characteristics.includes(characteristic));
                if (!service) {
                    error(`Could not find service for characteristic ${characteristic.uuid}`);
                    return;
                }

                characteristic.on("data", (data, _isNotification) => {
                    emitData(localName, service.uuid, characteristic.uuid, data);
                });

                // subscribe to notifications if supported
                if (characteristic.properties.includes("notify") || characteristic.properties.includes("indicate")) {
                    characteristic.subscribeAsync().catch((err) => {
                        error(`Error subscribing to characteristic ${characteristic.uuid}: ${err}`);
                    });
                }
            });

            // Update device with full service/characteristic info
            updateActiveDevices(localName, peripheral, services, characteristics);

            // Set up disconnect handler
            peripheral.on("disconnect", () => {
                log(`Device ${localName} disconnected`);
                this.emit("disconnect", localName);

                const index = activeDevices.findIndex((device) => device[1] === peripheral);
                if (index !== -1) {
                    activeDevices.splice(index, 1);
                }
                if (allowReconnect) {
                    setTimeout(async () => {
                        try {
                            if (noble.state === "poweredOn") {
                                await noble.startScanningAsync([], true);
                            }
                        } catch (err) {
                            error(`Error restarting scan after disconnect: ${err}`);
                        }
                    }, 3000);
                }
            });
            log(`Successfully connected to ${localName}`);
            this.emit("connect", localName);

            connectingDevices.delete(localName);
        } catch (err) {
            error(`Error connecting to ${localName}: ${err}`);

            connectingDevices.delete(localName);

            try {
                if (peripheral.state === "connected" || peripheral.state === "connecting") {
                    await peripheral.disconnectAsync();
                }
            } catch (disconnectErr) {
                error(`Error disconnecting after failed connection: ${disconnectErr}`);
            }

            const index = activeDevices.findIndex((device) => device[1] === peripheral);
            if (index !== -1) {
                activeDevices.splice(index, 1);
            }

            throw err;
        }
    }

    async stopConnection(): Promise<void> {
        try {
            log("Stopping Bluetooth connection...");

            allowReconnect = false;

            connectingDevices.clear();

            await noble.stopScanningAsync();
            noble.removeAllListeners("discover");
            noble.removeAllListeners("stateChange");

            activeDevices.forEach(([localName, peripheral]) => {
                log(`Disconnecting from ${localName}`);
                try {
                    peripheral.removeAllListeners();
                    if (peripheral.state === "connected") {
                        peripheral.disconnect();
                    }
                } catch (err) {
                    error(`Error disconnecting from ${localName}: ${err}`);
                }
            });

            activeDevices = [];
            this.emit("disconnected");
            log("Bluetooth connection stopped");
        } catch (err) {
            error(`Error stopping Bluetooth connection: ${err}`, true);
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

    getActiveDevices(): ActiveDevice[] {
        return activeDevices;
    }

    getAllowReconnect(): boolean {
        return allowReconnect;
    }

    getActiveTrackers(): string[] {
        return activeDevices.map((device) => device[0]);
    }

    getServiceUUID(name: string): string | null {
        for (const [uuid, serviceName] of services) {
            if (serviceName === name) return uuid;
        }
        return null;
    }

    getCharacteristicUUID(name: string): string | null {
        for (const [uuid, characteristicName] of characteristics) {
            if (characteristicName === name) return uuid;
        }
        return null;
    }

    getDeviceInfo(localName: string): ActiveDevice | null {
        return activeDevices.find((device) => device[0] === localName) || null;
    }
}

/*
 * Helper Functions
 */

function emitData(localName: string, serviceUuid: string, characteristicUuid: string, data: Buffer): void {
    const serviceName = services.get(serviceUuid) || serviceUuid;
    const characteristicName = characteristics.get(characteristicUuid) || characteristicUuid;

    main.emit("data", localName, serviceName, characteristicName, data);
    main.emit("dataRaw", localName, serviceName, characteristicName, data);
}

function log(message: string, bypass = false): void {
    const finalMessage = `(Bluetooth) ${message}`;
    console.log(finalMessage);
    main.emit("log", finalMessage, bypass);
}

function error(message: string, exceptional = false): void {
    const finalError = `(Bluetooth) ${message}`;
    console.error(finalError);
    main.emit("logError", { message: finalError, exceptional });
}

function updateActiveDevices(
    localName: string,
    peripheral: Peripheral,
    services: Service[],
    characteristics: Characteristic[],
): void {
    const deviceIndex = activeDevices.findIndex((device) => device[0] === localName);
    const deviceData: ActiveDevice = [localName, peripheral, services, characteristics];

    if (deviceIndex !== -1) {
        activeDevices[deviceIndex] = deviceData;
    } else {
        activeDevices.push(deviceData);
    }
}

async function getDevice(localName: string): Promise<ActiveDevice> {
    const normalizedLocalName = localName.replace("-ext", "");
    const device = activeDevices.find((device) => device[0] === normalizedLocalName);

    if (!device) {
        const errorMsg = `Device ${normalizedLocalName} not found in active devices: ${activeDevices
            .map((d) => d[0])
            .join(", ")}`;
        error(errorMsg, true);
        throw new Error(errorMsg);
    }

    return device;
}

function getService(device: ActiveDevice, serviceUuid: string): Service {
    const serviceInstance = device[2].find((s) => s.uuid === serviceUuid);

    if (!serviceInstance) {
        const errorMsg = `Service ${serviceUuid} not found for ${device[0]}`;
        error(errorMsg, true);
        throw new Error(errorMsg);
    }

    return serviceInstance;
}

function getCharacteristic(service: Service, characteristicUuid: string): Characteristic {
    const characteristicInstance = service.characteristics.find((c) => c.uuid === characteristicUuid);

    if (!characteristicInstance) {
        const errorMsg = `Characteristic ${characteristicUuid} not found for service ${service.uuid}`;
        error(errorMsg, true);
        throw new Error(errorMsg);
    }

    return characteristicInstance;
}

export { Bluetooth };
