"use strict";

import { characteristics, services } from "../libs/common";

import noble, { Characteristic, Peripheral, Service } from "@abandonware/noble";
import { EventEmitter } from "events";

let main: Bluetooth = undefined;

type ActiveDevice = [string, Peripheral, Service[], Characteristic[]];
let activeDevices: ActiveDevice[] = [];
let allowReconnect = true;
let discoveredDevices: Map<string, Peripheral> = new Map();
let isScanning = false;
let isConnecting = false;
let scanCycleTimeout: NodeJS.Timeout | null = null;

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

            const discoveredDevices = new Map<string, Peripheral>();

            const onDiscover = (peripheral: Peripheral) => {
                if (
                    peripheral.advertisement.localName &&
                    (peripheral.advertisement.localName.startsWith("HaritoraXW-") ||
                        peripheral.advertisement.localName.startsWith("HaritoraX2-"))
                ) {
                    discoveredDevices.set(peripheral.advertisement.localName, peripheral);
                }
            };

            noble.on("discover", onDiscover);
            await noble.startScanningAsync([], true);

            await new Promise<void>((resolve) => {
                setTimeout(resolve, 3000);
            });

            await noble.stopScanningAsync();
            noble.removeListener("discover", onDiscover);

            return discoveredDevices.size > 0 ? ["HaritoraX Wireless"] : null;
        } catch (err) {
            error(`Error getting available devices: ${err}`);
            try {
                await noble.stopScanningAsync();
            } catch (stopErr) {
                // Ignore stop scanning errors
            }
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
            this.emit("connected");
            log("Connected to bluetooth");

            // cycle to keep discovering devices
            this.startDiscoveryCycle();
        } catch (err) {
            error(`Error starting Bluetooth connection: ${err}`, true);
        }
    }

    private async startDiscoveryCycle() {
        if (!allowReconnect) return;

        try {
            if (scanCycleTimeout) {
                clearTimeout(scanCycleTimeout);
                scanCycleTimeout = null;
            }

            if (isScanning || isConnecting) {
                log("Skipping discovery cycle - already scanning or connecting");
                this.scheduleNextDiscoveryCycle();
                return;
            }

            log("Starting 5-second discovery scan...");
            isScanning = true;
            discoveredDevices.clear();
            const onDiscover = (peripheral: Peripheral) => {
                const {
                    advertisement: { localName },
                } = peripheral;
                if (!localName || (!localName.startsWith("HaritoraX2") && !localName.startsWith("HaritoraXW-"))) return;

                const deviceExists = activeDevices.some((device) => device[0] === localName && device[1].state === "connected");
                if (deviceExists) return;

                if (!discoveredDevices.has(localName)) {
                    discoveredDevices.set(localName, peripheral);
                    log(`Discovered device: ${localName}`);
                }
            };

            noble.on("discover", onDiscover);

            await noble.startScanningAsync([], true);

            // scan for 5 seconds
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 5000);
            });

            await noble.stopScanningAsync();
            noble.removeListener("discover", onDiscover);
            isScanning = false;

            log(`Scan complete. Found ${discoveredDevices.size} new devices`);

            if (discoveredDevices.size > 0) {
                await this.connectToDiscoveredDevices();
            }

            this.scheduleNextDiscoveryCycle();
        } catch (err) {
            error(`Error in discovery cycle: ${err}`);
            isScanning = false;
            isConnecting = false;

            try {
                await noble.stopScanningAsync();
            } catch (err) {
                error(`Error stopping scanning: ${err}`);
            }

            this.scheduleNextDiscoveryCycle();
        }
    }

    private async connectToDiscoveredDevices() {
        if (!allowReconnect || discoveredDevices.size === 0) return;

        isConnecting = true;
        log(`Connecting to ${discoveredDevices.size} discovered devices...`);

        for (const [localName, peripheral] of discoveredDevices) {
            if (!allowReconnect) break;

            try {
                log(`Attempting to connect to ${localName}...`);
                await this.connectToDevice(localName, peripheral);

                // add delay between connections to prevent overwhelming the adapter(?)
                await new Promise((resolve) => setTimeout(resolve, 500));
            } catch (err) {
                error(`Failed to connect to ${localName}: ${err}`);
            }
        }

        isConnecting = false;
        discoveredDevices.clear();
    }

    private async connectToDevice(localName: string, peripheral: Peripheral) {
        const deviceExists = activeDevices.some((device) => device[0] === localName || device[1] === peripheral);
        if (deviceExists) {
            log(`Device ${localName} already connected, skipping`);
            return;
        }

        updateActiveDevices(localName, peripheral, [], []);

        try {
            const connectPromise = peripheral.connectAsync();
            const timeoutPromise = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("Connection timeout")), 10000)
            );

            await Promise.race([connectPromise, timeoutPromise]);
            log(`Connected to ${localName}, starting service discovery...`);

            await new Promise((resolve) => setTimeout(resolve, 500));
            const discoverPromise = peripheral.discoverAllServicesAndCharacteristicsAsync();
            const discoverTimeoutPromise = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("Service discovery timeout")), 15000)
            );

            const { services, characteristics } = await Promise.race([discoverPromise, discoverTimeoutPromise]);
            log(`Found ${services.length} services and ${characteristics.length} characteristics for ${localName}`);
            characteristics.forEach((characteristic: Characteristic) => {
                // find the service that contains this characteristic
                const service = services.find((s: Service) => s.characteristics.includes(characteristic));
                if (!service) {
                    error(`Could not find service for characteristic ${characteristic.uuid}`);
                    return;
                }

                characteristic.on("data", (data: any, isNotification: any) => {
                    emitData(localName, service.uuid, characteristic.uuid, data);
                });

                // subscribe to notifications if the characteristic supports it
                if (characteristic.properties.includes("notify") || characteristic.properties.includes("indicate")) {
                    characteristic.subscribeAsync().catch((err: any) => {
                        error(`Error subscribing to characteristic ${characteristic.uuid}: ${err}`);
                    });
                }
            });

            updateActiveDevices(localName, peripheral, services, characteristics);

            peripheral.on("disconnect", () => {
                log(`Disconnected from ${localName}`);
                this.emit("disconnect", localName);
                const index = activeDevices.findIndex((device) => device[1] === peripheral);
                if (index !== -1) {
                    activeDevices.splice(index, 1);
                }
            });

            log(`Successfully connected to ${localName}`);
            this.emit("connect", localName);
        } catch (err) {
            error(`Error connecting to ${localName}: ${err}`);

            try {
                if (peripheral.state === "connected" || peripheral.state === "connecting") {
                    peripheral.disconnect();
                }
            } catch (err) {
                error(`Error disconnecting from ${localName}: ${err}`);
            }

            const index = activeDevices.findIndex((device) => device[1] === peripheral);
            if (index !== -1) {
                activeDevices.splice(index, 1);
            }

            throw err;
        }
    }

    private scheduleNextDiscoveryCycle() {
        if (!allowReconnect) return;

        // schedule next discovery cycle (5 seconds scan + 2.5 seconds buffer)
        scanCycleTimeout = setTimeout(() => {
            this.startDiscoveryCycle();
        }, 7500);
    }

    stopConnection() {
        try {
            if (scanCycleTimeout) {
                clearTimeout(scanCycleTimeout);
                scanCycleTimeout = null;
            }

            isScanning = false;
            isConnecting = false;
            discoveredDevices.clear();

            noble.stopScanning();
            noble.removeAllListeners("discover");

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
