"use strict";

import { services, characteristics } from "../libs/common";

import { EventEmitter } from "events";
import { createBluetooth, Adapter, Device, GattCharacteristic, GattService } from "node-ble";

let main: BluetoothLinux = undefined;
let ble: Adapter = null;
let bleDestroy: Function = null;

let allowReconnect = true;

type ActiveDevice = [string, Device];
let activeDevices: ActiveDevice[] = [];

export default class BluetoothLinux extends EventEmitter {
    constructor() {
        super();
        main = this;
        log(`Initialized Bluetooth module (Linux).`);
    }

    async isDeviceAvailable() {
        return await ble.isPowered();
    }

    async getAvailableDevices() {
        if (!ble) return null;

        if (!ble.isDiscovering) ble.startDiscovery();

        const devices = await ble.devices();
        for (let deviceUUID of devices) {
            const device = await ble.getDevice(deviceUUID);
            const name = await device.getName();
            if (name.startsWith("HaritoraXW-")) {
                log(`Found device: ${name}`);
                return true;
            }
        }

        // If we can't find any devices within 3.5s, stop discovery and return null
        setTimeout(() => {
            ble.stopDiscovery();
            return null;
        }, 3500);
    }

    async startConnection() {
        if (!ble) {
            const { bluetooth, destroy } = createBluetooth();

            try {
                ble = await bluetooth.defaultAdapter();
                bleDestroy = destroy;
            } catch (err) {
                error(`Bluetooth initialization failed: ${err}`, true);
                return;
            }
        }

        if (!ble.isPowered) {
            error("Bluetooth adapter is not powered on.", true);
            return;
        }

        try {
            await ble.startDiscovery();
        } catch (err) {
            error(`Error starting Bluetooth scanning: ${err}`);
        }

        const devices = await ble.devices();

        for (let deviceUUID of devices) {
            const device = await ble.getDevice(deviceUUID);
            let deviceName;

            try {
                deviceName = await device.getName();
            } catch (err) {
                // device name isn't advertised, skip this device
                continue;
            }

            if (deviceName.startsWith("HaritoraXW-")) {
                log(`Found device: ${deviceName}`);

                if (!(await device.isConnected())) {
                    device.connect();
                } else {
                    log(`Already connected to ${deviceName}`);
                    // force emit connect event
                    process.nextTick(() => {
                        device.emit("connect");
                    });
                }

                device.on("connect", async () => {
                    log(`Connected to ${deviceName}`);
                    this.emit("connect", deviceName);

                    activeDevices.push([deviceName, device]);

                    const timeout = new Promise<void>((_, reject) =>
                        setTimeout(() => reject(new Error("Operation timed out")), 10000)
                    );

                    const discoveryAndSubscription = (async () => {
                        try {
                            const gatt = await device.gatt();
                            const services = await gatt.services();

                            // Discover all services
                            for (let serviceUUID of services) {
                                const service = await gatt.getPrimaryService(serviceUUID);
                                const characteristics = await service.characteristics();

                                // Discover and subscribe to all characteristics
                                for (let characteristicUUID of characteristics) {
                                    try {
                                        const characteristic = await service.getCharacteristic(characteristicUUID);
                                        const flags = await characteristic.getFlags();
                                        if (!flags.includes("notify")) continue;

                                        await characteristic.startNotifications();
                                        characteristic.on("valuechanged", (data) => {
                                            const serviceCleaned = serviceUUID.replace(/-/g, "");
                                            const characteristicCleaned = characteristicUUID.replace(/-/g, "");
                                            emitData(deviceName, serviceCleaned, characteristicCleaned, data);
                                        });
                                    } catch (err) {
                                        error(`Error subscribing to ${characteristicUUID}: ${err}`);
                                        continue;
                                    }
                                }
                            }
                        } catch (err) {
                            error(`Error during Bluetooth discovery/connection process: ${err}`);
                        }
                    })();

                    try {
                        await Promise.race([discoveryAndSubscription, timeout]);
                    } catch (err) {
                        error(`Error during Bluetooth discovery/connection process: ${err}`);
                    }
                });

                device.on("disconnect", () => {
                    log(`Disconnected from ${deviceName}`);
                    this.emit("disconnect", deviceName);
                    const index = activeDevices.findIndex((device) => device[0] === deviceName);
                    if (index !== -1) {
                        activeDevices.splice(index, 1);
                    }

                    if (!allowReconnect) return;
                    setTimeout(() => {
                        ble.startDiscovery();
                    }, 3000);
                });
            }
        }
    }

    async stopConnection() {
        try {
            allowReconnect = false;

            if (ble) {
                try {
                    await ble.stopDiscovery();
                } catch (err) {
                    error(`Error stopping Bluetooth discovery: ${err}`);
                }

                for (let device of activeDevices) {
                    try {
                        await device[1].disconnect();
                        activeDevices = activeDevices.filter((activeDevice) => activeDevice[0] !== device[0]);
                    } catch (err) {
                        error(`Error disconnecting from Bluetooth device ${device[0]}: ${err}`);
                    }
                }

                bleDestroy();

                ble = null;
            }

            this.emit("disconnected");
            log("Stopped Bluetooth (Linux) connection.");
        } catch (err) {
            error(`Error stopping Bluetooth (Linux) connection: ${err}`, true);
        }
    }

    async read(localName: string, service: string, characteristic: string): Promise<ArrayBufferLike> {
        if (!ble) {
            error("Bluetooth adapter is not initialized.", true);
            return null;
        }

        try {
            const device = await getDevice(localName);
            const serviceInstance = await getService(device, service);
            const characteristicInstance = await getCharacteristic(serviceInstance, characteristic);

            const buffer = await characteristicInstance.readValue();

            // Convert the Buffer to an ArrayBuffer
            const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

            return arrayBuffer;
        } catch (err) {
            error(`Error reading characteristic ${characteristic}: ${err}`);
            throw err;
        }
    }

    async write(localName: string, service: string, characteristic: string, data: any): Promise<void> {
        if (!ble) {
            error("Bluetooth adapter is not initialized.", true);
            return null;
        }

        const device = await getDevice(localName);
        const serviceInstance = await getService(device, service);
        const characteristicInstance = await getCharacteristic(serviceInstance, characteristic);

        return await characteristicInstance.writeValueWithoutResponse(data);
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

async function getDevice(localName: string): Promise<ActiveDevice> {
    const device = activeDevices.find((device: ActiveDevice) => device[0] === localName);
    if (!device) error(`Device ${localName} not found, list: ${activeDevices}`, true);

    return device;
}

async function getService(device: ActiveDevice, service: string): Promise<GattService> {
    const fullServiceUUID = toFullUUID(service);
    const gatt = await device[1].gatt();

    try {
        const serviceInstance = (await gatt.getPrimaryService(fullServiceUUID)) as GattService;
        return serviceInstance;
    } catch (err) {
        error(`Service ${service} not found for ${device[0]}`, true);
        log(`Available services: ${await gatt.services()}`);
        return null;
    }
}

async function getCharacteristic(service: GattService, characteristic: string): Promise<GattCharacteristic> {
    const fullCharacteristicUUID = toFullUUID(characteristic);

    try {
        const characteristicInstance = (await service.getCharacteristic(fullCharacteristicUUID)) as GattCharacteristic;
        return characteristicInstance;
    } catch (err) {
        error(`Characteristic ${toFullUUID(characteristic)} not found for ${await service.toString()}`, true);
        log(`Available characteristics: ${await service.characteristics()}`);
        return null;
    }
}

/*
 * General helper functions
 */

function toFullUUID(originalUUID: string): string {
    if (originalUUID.length === 4) {
        return `0000${originalUUID}-0000-1000-8000-00805f9b34fb`;
    }
    return formatUUID(originalUUID);
}

function formatUUID(uuid: string): string {
    const cleanedUUID = uuid.replace(/-/g, "");

    if (cleanedUUID.length !== 32) {
        throw new Error(`Invalid UUID length: ${cleanedUUID.length}`);
    }

    return `${cleanedUUID.slice(0, 8)}-${cleanedUUID.slice(8, 12)}-${cleanedUUID.slice(12, 16)}-${cleanedUUID.slice(
        16,
        20
    )}-${cleanedUUID.slice(20)}`;
}

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
    const finalMessage = `(Bluetooth/Linux) ${message}`;
    console.log(finalMessage);
    main.emit("log", finalMessage);
}

function error(message: string, exceptional = false) {
    const finalError = `(Bluetooth/Linux) ${message}`;
    console.error(finalError);
    main.emit("logError", { message: finalError, exceptional });
}
