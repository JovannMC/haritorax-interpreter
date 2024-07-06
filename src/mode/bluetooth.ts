"use strict";

import noble, { Peripheral, Service, Characteristic } from "@abandonware/noble";
import { EventEmitter } from "events";

let main: Bluetooth = undefined;

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
    constructor() {
        super();
        noble.on("discover", this.onDiscover.bind(this));
        main = this;
        log(`Initialized Bluetooth module.`);
    }

    startConnection() {
        const startScanning = () => {
            try {
                noble.startScanning([], true);
                this.emit("connected");
                return true;
            } catch (err) {
                error(`Error starting scanning of BT devices:\n${err}`);
                return false;
            }
        };

        log("Connected to bluetooth");

        if (noble._state === "poweredOn") {
            return startScanning();
        } else {
            noble.on("stateChange", (state) => {
                if (state === "poweredOn") {
                    return startScanning();
                }
            });

            return true;
        }
    }

    async onDiscover(peripheral: Peripheral) {
        const {
            advertisement: { localName },
        } = peripheral;
        if (!localName || !localName.startsWith("HaritoraX")) return;

        const deviceExists = activeDevices.some(
            (device) => device[0] === localName || device[1] === peripheral
        );
        if (deviceExists) return;

        log(`Found device: ${localName}`);

        updateActiveDevices(localName, peripheral, [], []);

        try {
            await connectPeripheral(peripheral);
            log(`(bluetooth) Connected to ${localName}`);
            this.emit("connect", peripheral);

            const { services, characteristics } = await discoverServicesAndCharacteristics(
                peripheral
            );

            updateActiveDevices(localName, peripheral, services, characteristics);
        } catch (err) {
            error(`Error during discovery or connection process: ${err}`);
        }

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
            error(`Error while closing bluetooth connection: ${err}`);
            return false;
        }
        return true;
    }

    async read(localName: string, service: string, characteristic: string): Promise<ArrayBuffer> {
        const device = await getDevice(localName);
        const serviceInstance = getService(device, service);
        const characteristicInstance = getCharacteristic(serviceInstance, characteristic);

        return readCharacteristic(characteristicInstance);
    }

    async write(
        localName: string,
        service: string,
        characteristic: string,
        data: any
    ): Promise<void> {
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

    getDeviceInfo(localName: any) {
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
        services.map((service) =>
            discoverCharacteristics(peripheral.advertisement.localName, service)
        )
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
                    emitData(main, localName, service.uuid, characteristic.uuid, data);
                });
                characteristic.subscribe((err) => {
                    if (err)
                        error(`Error subscribing to characteristic ${characteristic.uuid}: ${err}`);
                });
            });
            resolve(characteristics);
        });
    });
}

function updateActiveDevices(
    localName: string,
    peripheral: Peripheral,
    services: Service[],
    characteristics: Characteristic[]
) {
    const deviceIndex = activeDevices.findIndex((device) => device[0] === localName);
    const deviceData: ActiveDevice = [localName, peripheral, services, characteristics];
    if (deviceIndex !== -1) activeDevices[deviceIndex] = deviceData;
    else activeDevices.push(deviceData);
}

/*
 * read() and write() helper functions
 */

async function readCharacteristic(characteristicInstance: Characteristic): Promise<ArrayBuffer> {
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

async function writeCharacteristic(
    characteristicInstance: Characteristic,
    data: any
): Promise<void> {
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
    if (!device) throw new Error(`Device ${localName} not found, list: ${activeDevices}`);

    while (!(await areAllBLEDiscovered(localName))) {
        log(`Waiting for all services and characteristics to be discovered for ${localName}...`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    return device;
}

function getService(device: ActiveDevice, service: string): Service {
    const serviceInstance = device[2].find((s) => s.uuid === service);
    if (!serviceInstance) throw new Error(`Service ${service} not found for ${device[0]}, service list: ${device[2]}`);
    return serviceInstance;
}

function getCharacteristic(service: Service, characteristic: string): Characteristic {
    const characteristicInstance = service.characteristics.find((c) => c.uuid === characteristic);
    if (!characteristicInstance) throw new Error(`Characteristic ${characteristic} not found for ${service.uuid}, characteristic list: ${service.characteristics}`);
    return characteristicInstance;
}

/*
 * General helper functions
 */

const importantServices = ["ef84369a90a911eda1eb0242ac120002", "180f"];
const importantCharacteristics = [
    "2a19",
    "ef84420290a911eda1eb0242ac120002",
    "ef8443f690a911eda1eb0242ac120002",
    "ef8445c290a911eda1eb0242ac120002",
    "ef84c30090a911eda1eb0242ac120002",
    "ef84c30590a911eda1eb0242ac120002",
];

async function areAllBLEDiscovered(trackerName: string): Promise<boolean> {
    // Find the device entry for the specified trackerName
    const device = activeDevices.find((device: any) => device[0] === trackerName);

    // If the device is not found, return false
    if (!device) return false;

    // Destructure the device to get services and characteristics
    const [, , services, characteristics] = device;

    // Check if all important services are discovered
    for (const serviceUuid of importantServices) {
        if (!services.find((service: any) => service.uuid === serviceUuid)) {
            return false;
        }
    }

    // Check if all important characteristics are discovered
    for (const characteristicUuid of importantCharacteristics) {
        if (!characteristics.find((characteristic: any) => characteristic.uuid === characteristicUuid)) {
            return false;
        }
    }

    // If all checks pass, return true
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

function log(message: string) {
    main.emit("log", message);
}

function error(message: string) {
    main.emit("logError", message);
}

export { Bluetooth };
