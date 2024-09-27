"use strict";

import { services, characteristics } from "../libs/common";

import { EventEmitter } from "events";
import { createBluetooth, Adapter, Device, GattCharacteristic, GattService } from "node-ble";
const { bluetooth, destroy } = createBluetooth();

let main: BluetoothLinux = undefined;
let ble: Adapter = null;

let allowReconnect = true;

type ActiveDevice = [string, Device, GattService[], GattCharacteristic[]];
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
        if (!ble) ble = await bluetooth.defaultAdapter();
        if (!ble.isPowered) {
            error("Bluetooth adapter is not powered on.", true);
            return;
        }

        await ble.startDiscovery();

        const devices = await ble.devices();
        log(`aaa ${devices.join(", ")}`);

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

                if (!device.isConnected) {
                    device.connect();
                } else {
                    log(`Already connected to ${deviceName}`);
                    // force emit connect event
                    process.nextTick(() => {
                        device.emit("connect");
                    });
                }

                device.on("connect", async () => {
                    log(`(bluetooth/linux) Connected to ${deviceName}`);
                    this.emit("connect", deviceName);

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
                });

                device.on("disconnect", () => {
                    log(`(bluetooth/linux) Disconnected from ${deviceName}`);
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

            await ble.stopDiscovery();
            destroy();

            this.emit("disconnected");
            log("Stopped Bluetooth (Linux) connection.");
        } catch (err) {
            log(`Error stopping Bluetooth (Linux) connection: ${err}`);
        }
    }

    async read(localName: string, service: string, characteristic: string): Promise<ArrayBufferLike> {
        const device = await getDevice(localName);
        const serviceInstance = await getService(device, service);
        const characteristicInstance = await getCharacteristic(serviceInstance, characteristic);

        return await characteristicInstance.readValue();
    }

    async write(localName: string, service: string, characteristic: string, data: any): Promise<void> {
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
    const gatt = await device[1].gatt();
    const serviceInstance = (await gatt.getPrimaryService(service)) as GattService;
    if (!serviceInstance) error(`Service ${service} not found for ${device[0]}`, true);
    return serviceInstance;
}

async function getCharacteristic(service: GattService, characteristic: string): Promise<GattCharacteristic> {
    const characteristicInstance = (await service.getCharacteristic(characteristic)) as GattCharacteristic;
    if (!characteristicInstance) error(`Characteristic ${characteristic} not found for ${service.toString()}.`, true);
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
    console.error(message);
    main.emit("logError", { message, exceptional });
}
