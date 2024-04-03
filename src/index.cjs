'use strict';

var buffer = require('buffer');
var events = require('events');
var Quaternion = require('quaternion');
var serialport = require('serialport');
var noble = require('@abandonware/noble');

const BAUD_RATE = 500000; // from the haritora_setting.json in the HaritoraConfigurator

const trackerAssignment = new Map([
    // tracker part, [tracker id, port, port id]
    ["DONGLE", [0, "", ""]],
    ["hip", [6, "", ""]],
    ["chest", [1, "", ""]],
    ["rightKnee",  [4, "", ""]],
    ["rightAnkle", [5, "", ""]],
    ["leftKnee", [2, ""], ""],
    ["leftAnkle", [3, ""], ""]
]);

const deviceInformation = new Map([
    // deviceName, [version, model, serial]
    ["DONGLE", ["", "", ""]],
    ["rightKnee", ["", "", ""]],
    ["rightAnkle", ["", "", ""]],
    ["hip", ["", "", ""]],
    ["chest", ["", "", ""]],
    ["leftKnee", ["", "", ""]],
    ["leftAnkle", ["", "", ""]]
]);

// Stores the ports that are currently active as objects for access later
let activePorts = {};
let trackersAssigned = false;

class GX6 extends events.EventEmitter {
    constructor() {
        super();
    }
    
    startConnection(portNames) {
        portNames.forEach(port => {
            const serial = new serialport.SerialPort({
                path: port,
                baudRate: BAUD_RATE
            });
            const parser = serial.pipe(new serialport.ReadlineParser({ delimiter: "\n" }));
            activePorts[port] = serial;
            
            serial.on("open", () => {
                this.emit("connected", port);
            });

            parser.on("data", data => {
                const splitData = data.toString().split(/:(.+)/);
                const identifier = splitData[0].toLowerCase();
                const portId = identifier.match(/\d/) ? identifier.match(/\d/)[0] : "DONGLE";
                const portData = splitData[1];

                if (!trackersAssigned) {
                    for (let [key, value] of trackerAssignment.entries()) {
                        if (value[1] === "") {
                            if (identifier.startsWith("r")) {
                                const trackerId = parseInt(portData.charAt(4));
                                if (value[0] == trackerId) {
                                    trackerAssignment.set(key, [trackerId, port, portId]);
                                    //console.log(`Setting ${key} to port ${port} with port ID ${portId}`);
                                }
                            } else if (identifier.startsWith("i")) {
                                const info = JSON.parse(portData);
                                const version = info["version"];
                                const model = info["model"];
                                const serial = info["serial no"];
                                
                                deviceInformation.set(key, [version, model, serial]);
                            }
                        }
                    }

                    if (Array.from(trackerAssignment.values()).every(value => value[1] !== "")) {
                        trackersAssigned = true;
                        //console.log("All trackers have been assigned: ", Array.from(trackerAssignment.entries()));
                    }
                }

                let trackerName = null;
                for (let [key, value] of trackerAssignment.entries()) {
                    if (value[1] === port && value[2] === portId) {
                        trackerName = key;
                        break;
                    }
                }

                this.emit("data", trackerName, port, portId, identifier, portData);
            });

            serial.on("close", () => {
                this.emit("disconnected", port);
            });
        });
    }

    stopConnection() {
        for (let port in activePorts) {
            if (activePorts[port].isOpen) {
                activePorts[port].close();
                activePorts[port].destroy();
            }
        }
        this.emit("disconnected");
    }

    getTrackerAssignment() {
        return Array.from(trackerAssignment.entries());
    }

    getTrackers() {
        return Array.from(trackerAssignment.keys());
    }

    getTrackerId(tracker) {
        const port = trackerAssignment.get(tracker)[0];
        if (port) {
            return port;
        }
        return null;
    }
    
    getTrackerPort(tracker) {
        const port = trackerAssignment.get(tracker)[1];
        if (port) {
            return port;
        }
        return null;
    }

    getTrackerPortId(tracker) {
        const portId = trackerAssignment.get(tracker)[2];
        if (portId) {
            return portId;
        }
        return null;
    }

    getPartFromId(trackerId) {
        for (let [key, value] of trackerAssignment.entries()) {
            if (value[0] == trackerId) {
                return key;
            }
        }
    }

    getPartFromInfo(port, portId) {
        for (let [key, value] of trackerAssignment.entries()) {
            if (value[1] == port && value[2] == portId) {
                return key;
            }
        }
    }

    getDeviceInformation(deviceName) {
        //console.log(deviceInformation);
        return deviceInformation.get(deviceName);
    }

    getActivePorts() {
        return activePorts;
    }
}

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

let activeDevices$1 = [];
let activeServices = [];
let activeCharacteristics = [];

let allowReconnect = true;

class Bluetooth extends events.EventEmitter {
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
        if (localName && localName.startsWith("HaritoraXW-") && !activeDevices$1.includes(peripheral)) {
            console.log(`Found device: ${localName}`);
            activeDevices$1.push(peripheral);

            peripheral.connect(error => {
                if (error) {
                    console.error(`Error connecting to ${localName}:`, error);
                    return;
                }
                console.log(`Connected to ${localName}`);
                this.emit("connect", peripheral);
                
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
                this.emit("disconnect", peripheral);
                const index = activeDevices$1.indexOf(peripheral);
                if (index !== -1) {
                    activeDevices$1.splice(index, 1);
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
        for (let device of activeDevices$1) {
            device.disconnect();
        }
        activeDevices$1 = [];
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
        return activeDevices$1;
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
        return activeDevices$1.map(device => device.advertisement.localName);
    }

    getDeviceInfo(localName) {
        for (let device of activeDevices$1) {
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

let debug = 0;

const gx6 = new GX6();
const bluetooth = new Bluetooth();
let gx6Enabled = false;
let bluetoothEnabled = false;
let haritora;

const SENSOR_MODE_1 = "1";
const SENSOR_MODE_2 = "0";
const FPS_MODE_100 = "1";
const FPS_MODE_50 = "0";

const trackerButtons = new Map([
    // trackerName, [mainButton, subButton]
    ["rightKnee", [0, 0]],
    ["rightAnkle", [0, 0]],
    ["hip", [0, 0]],
    ["chest", [0, 0]],
    ["leftKnee", [0, 0]],
    ["leftAnkle", [0, 0]]
]);

const trackerSettingsRaw = new Map([
    // trackerName, raw hex value
    ["rightKnee", ""],
    ["rightAnkle", ""],
    ["hip", ""],
    ["chest", ""],
    ["leftKnee", ""],
    ["leftAnkle", ""]
]);

const trackerSettings = new Map([
    // trackerName, [sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection]
    ["rightKnee", [2, "50", [], false]],
    ["rightAnkle", [2, "50", [], false]],
    ["hip", [2, "50", [], false]],
    ["chest", [2, "50", [], false]],
    ["leftKnee", [2, "50", [], false]],
    ["leftAnkle", [2, "50", [], false]]
]);

const trackerBattery = new Map([
    // trackerName, [batteryRemaining, batteryVoltage, chargeStatus]
    ["rightKnee", [0, 0, ""]],
    ["rightAnkle", [0, 0, ""]],
    ["hip", [0, 0, ""]],
    ["chest", [0, 0, ""]],
    ["leftKnee", [0, 0, ""]],
    ["leftAnkle", [0, 0, ""]]
]);

let activeDevices = [];

// JSDoc comments for events

/**
 * The "imu" event which provides info about the tracker's IMU data.
 * Support: GX6, Bluetooth
 * 
 * @event this#imu
 * @type {object}
 * @property {string} trackerName - The name of the tracker. Possible values: "rightKnee", "rightAnkle", "hip", "chest", "leftKnee", "leftAnkle".
 * @property {object} rotation - The rotation data of the tracker.
 * @property {number} rotation.x - The x component of the rotation.
 * @property {number} rotation.y - The y component of the rotation.
 * @property {number} rotation.z - The z component of the rotation.
 * @property {number} rotation.w - The w component of the rotation.
 * @property {object} gravity - The gravity data of the tracker.
 * @property {number} gravity.x - The x component of the gravity.
 * @property {number} gravity.y - The y component of the gravity.
 * @property {number} gravity.z - The z component of the gravity.
 * @property {number|null} ankle - The ankle motion data of the tracker if enabled. Null if disabled.
**/

/** 
 * The "tracker" event which provides info about the tracker's other data.
 * Support: GX6
 * 
 * @event this#tracker
 * @type {object}
 * @property {string} trackerName - The name of the tracker. (rightKnee, rightAnkle, hip, chest, leftKnee, leftAnkle)
 * @property {string} data - The data received from the tracker.
**/

/** 
 * The "settings" event which provides info about the tracker settings.
 * Support: GX6, Bluetooth (untested)
 * 
 * @event this#settings
 * @type {object}
 * @property {string} trackerName - The name of the tracker.
 * @property {number} sensorMode - The sensor mode, which controls whether magnetometer is used (1 or 2).
 * @property {number} fpsMode - The posture data transfer rate/FPS (50 or 100).
 * @property {Array<string>} sensorAutoCorrection - The sensor auto correction mode, multiple or none can be used (accel, gyro, mag).
 * @property {boolean} ankleMotionDetection - Whether ankle motion detection is enabled. (true or false)
**/

/**
 * The "button" event which provides info about the tracker's button data.
 * Support: GX6, Bluetooth (partial)
 * 
 * @event this#button
 * @type {object}
 * @property {string} trackerName - The name of the tracker. (rightKnee, rightAnkle, hip, chest, leftKnee, leftAnkle)
 * @property {number} mainButton - Amount of times the main button was pressed.
 * @property {number} subButton - Amount of times the sub button was pressed.
 * @property {boolean} isOn - Whether the tracker is turning on/is on (true) or turning off/is off (false).
**/

/**
 * The "battery" event which provides info about the tracker's battery data.
 * Support: GX6, Bluetooth (partial)
 * 
 * @event this#battery
 * @type {object}
 * @property {string} trackerName - The name of the tracker. (rightKnee, rightAnkle, hip, chest, leftKnee, leftAnkle)
 * @property {number} batteryRemaining - The remaining battery percentage of the tracker.
 * @property {number} batteryVoltage - The voltage of the tracker's battery.
 * @property {string} chargeStatus - The charge status of the tracker. (discharging, charging(?), charged(?))
**/

/**
 * The "info" event which provides info about the tracker or dongle.
 * Support: GX6, Bluetooth
 *
 * @event this#info
 * @type {object}
 * @property {string} name - The name of the device.
 * @property {string} version - The version of the device.
 * @property {string} model - The model of the device.
 * @property {string} serial - The serial number of the device.
**/

/**
 * The "connect" event which provides the name of the tracker that has connected.
 * Support: GX6, Bluetooth
 *
 * @event this#connect
 * @type {string}
 * @property {string} trackerName - The name of the tracker.
**/

/**
 * The "disconnect" event which provides the name of the tracker that has disconnected.
 * Support: GX6, Bluetooth
 * 
 * @event this#disconnect
 * @type {string}
 * @property {string} trackerName - The name of the tracker.
**/



/**
 * The HaritoraXWireless class.
 * 
 * This class represents a HaritoraX wireless device. It provides methods to start/stop a connection,
 * set settings for all/individual trackers, and emits events for: IMU data, tracker data, button data, battery data, and settings data.
 * 
 * @param {boolean} debugMode - Enable logging of debug messages depending on verbosity. (0 = none, 1 = debug, 2 = debug w/ function info)
 * 
 * @example
 * let device = new HaritoraXWireless(true);
**/
class HaritoraXWireless extends events.EventEmitter {
    constructor(debugMode = 0) {
        super();
        debug = debugMode;
        haritora = this;
    }

    /**
     * Starts the connection to the trackers with the specified mode.
     * 
     * @param {string} connectionMode - Connect to the trackers with the specified mode (GX6 or bluetooth).
     * @param {array} portNames - The port names to connect to. (GX6 only)
     * 
     * @example
     * device.startConnection("gx6");
    **/
    startConnection(connectionMode, portNames) {
        if (connectionMode === "gx6") {
            gx6.startConnection(portNames);
            gx6Enabled = true;
        } else if (connectionMode === "bluetooth") {
            bluetooth.startConnection();
            bluetoothEnabled = true;
        }
    }


    /**
     * Stops the connection to the trackers with the specified mode.
     * 
     * @param {string} connectionMode - Disconnect from the trackers with the specified mode (gx6 or bluetooth).
     * 
     * @example
     * device.stopConnection("gx6");
    **/
    stopConnection(connectionMode) {
        if (connectionMode === "gx6") {
            gx6.stopConnection();
            gx6Enabled = false;
        } else if (connectionMode === "bluetooth") {
            bluetooth.stopConnection();
            bluetoothEnabled = false;
        }
    }

    // TODO: set tracker settings for bluetooth

    /**
     * Sets the tracker settings for a specific tracker.
     * Support: GX6
     * 
     * @param {string} trackerName - The name of the tracker to apply settings to (rightKnee, rightAnkle, hip, chest, leftKnee, leftAnkle).
     * @param {number} sensorMode - The sensor mode, which controls whether magnetometer is used (1 or 2).
     * @param {number} fpsMode - The posture data transfer rate/FPS (50 or 100).
     * @param {string} sensorAutoCorrection - The sensor auto correction mode, multiple or none can be used (accel, gyro, mag).
     * @param {boolean} ankleMotionDetection - Whether ankle motion detection is enabled. (true or false)
     * @returns {boolean} - Whether the settings were successfully sent to the tracker.
     * @fires this#settings
     * 
     * @example
     * trackers.setTrackerSettings("rightAnkle", 100, 1, ['accel', 'gyro'], true);
    **/ 

    setTrackerSettings(trackerName, sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection) {
        const TRACKERS_GROUP_ONE = ["rightKnee", "hip", "leftKnee"];
        const TRACKERS_GROUP_TWO = ["rightAnkle", "chest", "leftAnkle"];

        if (bluetoothEnabled) {
            log("Setting tracker settings for bluetooth is not supported yet.");
            return false;
        } else {
            log(`Setting tracker settings for ${trackerName}...`);
            const sensorModeBit = sensorMode === 1 ? SENSOR_MODE_1 : SENSOR_MODE_2; // Default to mode 2
            const postureDataRateBit = fpsMode === 100 ? FPS_MODE_100 : FPS_MODE_50; // Default to 50 FPS
            const ankleMotionDetectionBit = ankleMotionDetection ? "1" : "0"; // Default to false
            let sensorAutoCorrectionBit = 0;
            if (sensorAutoCorrection.includes("accel")) sensorAutoCorrectionBit |= 0x01;
            if (sensorAutoCorrection.includes("gyro")) sensorAutoCorrectionBit |= 0x02;
            if (sensorAutoCorrection.includes("mag")) sensorAutoCorrectionBit |= 0x04;

            let hexValue = `00000${postureDataRateBit}${sensorModeBit}010${sensorAutoCorrectionBit}00${ankleMotionDetectionBit}`;
            let trackerSettingsBuffer = null;

            if (TRACKERS_GROUP_ONE.includes(trackerName)) {
                trackerSettingsBuffer = this.getTrackerSettingsBuffer(trackerName, hexValue, 1);
            } else if (TRACKERS_GROUP_TWO.includes(trackerName)) {
                trackerSettingsBuffer = this.getTrackerSettingsBuffer(trackerName, hexValue, -1);
            } else {
                log(`Invalid tracker name: ${trackerName}`);
                return;
            }

            log(`Setting the following settings onto tracker ${trackerName}:
Sensor mode: ${sensorMode}
FPS mode: ${fpsMode}
Sensor auto correction: ${sensorAutoCorrection}
Ankle motion detection: ${ankleMotionDetection}
Raw hex data calculated to be sent: ${hexValue}`);

            trackerSettings.set(trackerName, [sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection]);
            
            try {
                log(`Sending tracker settings to ${trackerName}: ${trackerSettingsBuffer.toString()}`);
                let ports = gx6.getActivePorts();
                let trackerPort = gx6.getTrackerPort(trackerName);

                ports[trackerPort].write(trackerSettingsBuffer, (err) => {
                    if (err) {
                        console.error(`${trackerName} - Error writing data to serial port ${trackerPort}:`, err);
                    } else {
                        trackerSettingsRaw.set(trackerName, hexValue);
                        log(`${trackerName} - Data written to serial port ${trackerPort}: ${trackerSettingsBuffer.toString()}`);
                    }
                });
            } catch (error) {
                console.error(`Error sending tracker settings:\n${error.message}`);
                return false;
            }
        }

        this.emit("settings", trackerName, sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection);
        return true;
    }

    getTrackerSettingsBuffer(trackerName, hexValue, direction) {
        const entries = Array.from(trackerSettingsRaw.entries());
        const currentIndex = entries.findIndex(([key]) => key === trackerName);
    
        if (currentIndex !== -1 && currentIndex + direction >= 0 && currentIndex + direction < entries.length) {
            const adjacentKey = entries[currentIndex + direction][0];
            let adjacentValue = trackerSettingsRaw.get(adjacentKey);
            return buffer.Buffer.from(`o0:${direction === 1 ? hexValue : adjacentValue}\r\no1:${direction === 1 ? adjacentValue : hexValue}\r\n`, "utf-8");
        }
    
        log(`${trackerName} - Calculated hex value: ${hexValue}`);
        return null;
    }

    
    /**
     * Sets the tracker settings for all connected trackers
     * Support: GX6
     *
     * @param {number} fpsMode - The posture data transfer rate/FPS (50 or 100).
     * @param {number} sensorMode - The sensor mode, which controls whether magnetometer is used (1 or 2).
     * @param {string} sensorAutoCorrection - The sensor auto correction mode, multiple or none can be used (accel, gyro, mag).
     * @param {boolean} ankleMotionDetection - Whether ankle motion detection is enabled. (true or false)
     * @returns {boolean} - Whether the settings were successfully sent to all trackers.
     * @fires this#settings
     * 
     * @example
     * trackers.setAllTrackerSettings(50, 2, ['mag'], false);
    **/

    setAllTrackerSettings(sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection) {
        if (bluetoothEnabled) {
            log("Setting all tracker settings for bluetooth is not supported yet.");
            return false;
        } else if (gx6Enabled) {
            try {
                const sensorModeBit = sensorMode === 1 ? SENSOR_MODE_1 : SENSOR_MODE_2; // Default to mode 2
                const postureDataRateBit = fpsMode === 100 ? FPS_MODE_100 : FPS_MODE_50; // Default to 50 FPS
                const ankleMotionDetectionBit = ankleMotionDetection ? "1" : "0"; // Default to false
                let sensorAutoCorrectionBit = 0;
                if (sensorAutoCorrection.includes("accel")) sensorAutoCorrectionBit |= 0x01;
                if (sensorAutoCorrection.includes("gyro")) sensorAutoCorrectionBit |= 0x02;
                if (sensorAutoCorrection.includes("mag")) sensorAutoCorrectionBit |= 0x04;

                const hexValue = `00000${postureDataRateBit}${sensorModeBit}010${sensorAutoCorrectionBit}00${ankleMotionDetectionBit}`;
                const trackerSettingsBuffer = buffer.Buffer.from("o0:" + hexValue + "\r\n" + "o1:" + hexValue + "\r\n", "utf-8");

                log(`Setting the following settings onto all connected trackers:
Connected trackers: ${activeDevices}
Sensor mode: ${sensorMode}
FPS mode: ${fpsMode}
Sensor auto correction: ${sensorAutoCorrection}
Ankle motion detection: ${ankleMotionDetection}
Raw hex data calculated to be sent: ${hexValue}`);

                for (let trackerName of trackerSettingsRaw.keys()) {
                    let ports = gx6.getActivePorts();
                    let trackerPort = gx6.getTrackerPort(trackerName);

                    ports[trackerPort].write(trackerSettingsBuffer, (err) => {
                        if (err) {
                            console.error(`${trackerName} - Error writing data to serial port ${trackerPort}:`, err);
                        } else {
                            trackerSettingsRaw.set(trackerName, hexValue);
                            log(`${trackerName} - Data written to serial port ${trackerPort}: ${trackerSettingsBuffer.toString()}`);
                        }
                    });
                }
            } catch (error) {
                console.error(`Error sending tracker settings:\n ${error}`);
                return false;
            }
        } else {
            log("No connection mode is enabled");
            return false;
        }

        for (let trackerName of trackerSettingsRaw.keys()) {
            this.emit("settings", trackerName, sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection);
            trackerSettings.set(trackerName, [sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection]);
        }
        return true;
    }

    /**
     * Returns device info for the specified tracker or dongle.
     * Support: GX6, Bluetooth
     * 
     * @function getDeviceInfo
     * @returns {object} - The device info (version, model, serial)
     * @fires this#info
    **/

    async getDeviceInfo(trackerName) {
        // GX6
        const VERSION_INDEX = 0;
        const MODEL_INDEX = 1;
        const SERIAL_INDEX = 2;

        // Bluetooth
        const SERVICE_UUID = "180a";
        const VERSION_UUID = "2a28";
        const MODEL_UUID = "2a24";
        const SERIAL_UUID = "2a25";
        const TIMEOUT = 3000;

        // Global
        let serial = null;
        let model = null;
        let version = null;
        
        if (trackerName === "(DONGLE)" || gx6Enabled) {
            serial = gx6.getDeviceInformation(trackerName)[SERIAL_INDEX];
            model = gx6.getDeviceInformation(trackerName)[MODEL_INDEX];
            version = gx6.getDeviceInformation(trackerName)[VERSION_INDEX];
        } else if (bluetoothEnabled) {
            let trackerObject = bluetooth.getActiveDevices().find(device => device.advertisement.localName === trackerName);
            if (!trackerObject) {
                log(`Tracker ${trackerName} not found`);
                return null;
            }

            const readPromises = [];

            for (let service of trackerObject.services) {
                if (service.uuid !== SERVICE_UUID) continue;
                for (let characteristic of service.characteristics) {
                    const promise = new Promise((resolve, reject) => {
                        characteristic.read((err, data) => {
                            if (err) {
                                reject(`Error reading characteristic for ${trackerName}: ${err}`);
                            } else {
                                switch (characteristic.uuid) {
                                case VERSION_UUID:
                                    version = data.toString("utf-8");
                                    break;
                                case MODEL_UUID:
                                    model = data.toString("utf-8");
                                    break;
                                case SERIAL_UUID:
                                    serial = data.toString("utf-8");
                                    break;
                                }
                                resolve();
                            }
                        });
                    
                        setTimeout(() => reject(`Read operation for ${trackerName} timed out`), TIMEOUT);
                    });
                    readPromises.push(promise);
                }
            }

            try {
                await Promise.all(readPromises);
            } catch (error) {
                console.error(error);
            }
        }

        log(`Tracker ${trackerName} info: ${version}, ${model}, ${serial}`);
        this.emit("info", trackerName, version, model, serial);
        return { version, model, serial };
    }

    /**
     * Get battery info from the trackers.
     * Support: GX6, Bluetooth
     * 
     * @function getBatteryInfo
     * @returns {object} - The battery info (batteryRemaining, batteryVoltage, chargeStatus)
     * @fires this#battery
    **/

    async getBatteryInfo(trackerName) {
        try {
            if (trackerBattery.has(trackerName)) {
                let [batteryRemaining, batteryVoltage, chargeStatus] = trackerBattery.get(trackerName);
                log(`Tracker ${trackerName} battery remaining: ${batteryRemaining}%`);
                log(`Tracker ${trackerName} battery voltage: ${batteryVoltage}`);
                log(`Tracker ${trackerName} charge status: ${chargeStatus}`);
                this.emit("battery", trackerName, batteryRemaining, batteryVoltage, chargeStatus);
                return { batteryRemaining, batteryVoltage, chargeStatus };
            } else {
                if (gx6Enabled) {
                    log(`Tracker ${trackerName} battery info not found`);
                    return null;
                } else if (bluetoothEnabled) {
                    let trackerObject = bluetooth.getActiveDevices().find(device => device.advertisement.localName === trackerName);
                    if (!trackerObject) {
                        log(`Tracker ${trackerName} not found`);
                        return null;
                    }
                    let batteryCharacteristic = trackerObject.services.find(service => service.uuid === "180f").characteristics.find(characteristic => characteristic.uuid === "2a19");

                    batteryCharacteristic.read((err, data) => {
                        if (err) {
                            console.error(`Error reading battery characteristic for ${trackerName}: ${err}`);
                        } else {
                            let batteryRemaining = data[0];
                            log(`Tracker ${trackerName} battery remaining: ${batteryRemaining}%`);
                            this.emit("battery", trackerName, batteryRemaining, null, null);
                        }
                    });
                }
            }
        } catch (error) {
            console.error(`Error getting battery info for ${trackerName}:`, error);
        }
    }

    /**
     * Get the active trackers.
     * Support: GX6, Bluetooth
     * 
     * @function getActiveTrackers
     * @returns {array} - The active trackers.
    **/

    getActiveTrackers() {
        if (gx6Enabled) {
            return activeDevices;
        } else if (bluetoothEnabled) {
            return bluetooth.getActiveTrackers();
        } else {
            return null;
        }
    }

    /**
     * Get the tracker's settings.
     * Support: GX6
     * 
     * @function getTrackerSettings
     * @param {string} trackerName 
     * @returns {Object} - The tracker settings (sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection)
    **/
    getTrackerSettings(trackerName) {
        try {
            if (trackerSettings.has(trackerName)) {
                let [sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection] = trackerSettings.get(trackerName);
                log(`Tracker ${trackerName} settings:
Sensor mode: ${sensorMode}
FPS mode: ${fpsMode}
Sensor auto correction: ${sensorAutoCorrection}
Ankle motion detection: ${ankleMotionDetection}`);
                return { sensorMode, fpsMode, sensorAutoCorrection, ankleMotionDetection };
            } else {
                log(`Tracker ${trackerName} settings not found`);
                return null;
            }
        } catch (error) {
            console.error(`Error getting tracker settings for ${trackerName}:`, error);
            return null;
        }
    } 
    

    /**
     * Get the tracker's (raw hex) settings
     * Support: GX6
     * 
     * @function getTrackerSettingsRaw
     * @param {string} trackerName 
     * @returns {Map} - The tracker settings map
    **/
    getTrackerSettingsRaw(trackerName) {
        try {
            if (trackerSettingsRaw.has(trackerName)) {
                let hexValue = trackerSettingsRaw.get(trackerName);
                log(`Tracker ${trackerName} raw hex settings: ${hexValue}`);
                return hexValue;
            } else {
                log(`Tracker ${trackerName} raw hex settings not found`);
                return null;
            }
        } catch (error) {
            console.error(`Error getting tracker settings for ${trackerName}:`, error);
            return null;
        }
    }

    /**
    * Get the tracker's battery info.
    * Support: GX6
    * 
    * @function getTrackerBattery
    * @param {string} trackerName 
    * @returns {Map} - The tracker settings map
    **/
    getTrackerBattery(trackerName) {
        try {
            if (trackerBattery.has(trackerName)) {
                let [batteryRemaining, batteryVoltage, chargeStatus] = trackerBattery.get(trackerName);
                log(`Tracker ${trackerName} battery remaining: ${batteryRemaining}%`);
                log(`Tracker ${trackerName} battery voltage: ${batteryVoltage}`);
                log(`Tracker ${trackerName} charge status: ${chargeStatus}`);
                return { batteryRemaining, batteryVoltage, chargeStatus };
            } else {
                log(`Tracker ${trackerName} battery info not found`);
                return null;
            }
        } catch (error) {
            console.error(`Error getting battery info for ${trackerName}:`, error);
            return null;
        }
    }

    /**
     * Get the tracker's buttons.
     * Support: GX6, Bluetooth
     * 
     * @function getTrackerButtons
     * @param {string} trackerName 
     * @returns {Map} - The tracker button map
    **/
    getTrackerButtons(trackerName) {
        try {
            if (trackerButtons.has(trackerName)) {
                let [mainButton, subButton] = trackerButtons.get(trackerName);
                log(`Tracker ${trackerName} main button: ${mainButton}`);
                log(`Tracker ${trackerName} sub button: ${subButton}`);
                return { mainButton, subButton };
            } else {
                log(`Tracker ${trackerName} buttons not found`);
                return null;
            }
        } catch (error) {
            console.error(`Error getting tracker buttons for ${trackerName}:`, error);
            return null;
        }
    }

    /**
     * Check whether the connection mode is active or not.
     * Support: GX6, Bluetooth
     * 
     * @function getConnectionModeActive
     * @param {string} connectionMode 
     * @returns {boolean} - Whether the connection mode is active or not
    **/
    getConnectionModeActive(connectionMode) {
        if (connectionMode === "gx6") {
            return gx6Enabled;
        } else if (connectionMode === "bluetooth") {
            return bluetoothEnabled;
        } else {
            return null;
        }
    }
}

gx6.on("data", (trackerName, port, portId, identifier, portData) => {
    switch (identifier[0]) {
    case "x":
        processIMUData(portData, trackerName);
        break;
    case "a":
        processTrackerData(portData, trackerName);
        break;
    case "r":
        processButtonData(portData, trackerName);
        break;
    case "v":
        processBatteryData(portData, trackerName);
        break;
    case "o":
        processTrackerSettings(portData, trackerName);
        break;
    case "i":
        // Handled by GX6 class
        break;
    default:
        log(`${port} - Unknown data from ${trackerName}: ${portData}`);
    }
});

// TODO: magnetometer, add settings
bluetooth.on("data", (localName, service, characteristic, data) => {
    if (service === "Device Information") return;

    switch (characteristic) {
    case "Sensor":
        processIMUData(data, localName);
        break;
    case "MainButton":
    case "SecondaryButton":
        processButtonData(data, localName, characteristic);
        break;
    case "BatteryLevel":
        processBatteryData(data, localName);
        break;
    /*case "Settings":
        // TODO - Process settings data, probably will need to be manually read and set
        //processTrackerSettings(data, localName);
        break;*/
    default:
        log(`Unknown data from ${localName}: ${data} - ${characteristic} - ${service}`);
        log(`Data in utf-8: ${buffer.Buffer.from(data, "base64").toString("utf-8")}`);
        log(`Data in hex: ${buffer.Buffer.from(data, "base64").toString("hex")}`);
        log(`Data in base64: ${buffer.Buffer.from(data, "base64").toString("base64")}`);
    }
});

bluetooth.on("connect", peripheral => {
    haritora.emit("connect", peripheral.advertisement.localName);
    log(`Connected to ${peripheral.advertisement.localName}`);
});

bluetooth.on("disconnect", peripheral => {
    haritora.emit("disconnect", peripheral.advertisement.localName);
    log(`Disconnected from ${peripheral.advertisement.localName}`);
});



/**
 * Processes the IMU data received from the tracker by the dongle.
 * The data contains the information about the rotation, gravity, and ankle motion (if enabled) of the tracker.
 * Support: GX6, Bluetooth
 *
 * @function processIMUData
 * 
 * @param {string} data - The data to process.
 * @param {string} trackerName - The name of the tracker.
 * @fires haritora#imu
**/

function processIMUData(data, trackerName) {
    // If tracker isn't in activeDevices, add it and emit "connect" event
    if (trackerName && !activeDevices.includes(trackerName)) {
        activeDevices.push(trackerName);
        haritora.emit("connect", trackerName);
    }

    // Check if the data is valid
    if (!data || !data.length === 24) {
        log(`Invalid IMU packet for tracker ${trackerName}: ${data}`);
        return false;
    }

    // Decode and log the data
    try {
        const { rotation, gravity, ankle } = decodeIMUPacket(data, trackerName);
        
        log(`Tracker ${trackerName} rotation: (${rotation.x.toFixed(5)}, ${rotation.y.toFixed(5)}, ${rotation.z.toFixed(5)}, ${rotation.w.toFixed(5)})`);
        log(`Tracker ${trackerName} gravity: (${gravity.x.toFixed(5)}, ${gravity.y.toFixed(5)}, ${gravity.z.toFixed(5)})`);
        if (ankle) log(`Tracker ${trackerName} ankle: ${ankle}`);

        haritora.emit("imu", trackerName, rotation, gravity, ankle);
    } catch (err) {
        console.error(`Error decoding tracker ${trackerName} IMU packet data:`, err);
    }
}


/**
 * The logic to decode the IMU packet received by the dongle. 
 * Thanks to sim1222 and BracketProto's project for helping with the math and acceleration/drift code respectively :p
 * @see {@link https://github.com/sim1222/haritorax-slimevr-bridge/}
 * @see {@link https://github.com/OCSYT/SlimeTora/}
**/

const DRIFT_INTERVAL = 15000;
let initialRotations = {};
let startTimes = {};
let calibrated = {};
let driftValues = {};
let trackerRotation = {};
let trackerAccel = {};

function decodeIMUPacket(data, trackerName) {
    try {
        if (data.length < 14) {
            throw new Error("Too few bytes to decode IMU packet");
        }

        const elapsedTime = Date.now() - startTimes[trackerName];

        const buffer$1 = buffer.Buffer.from(data, "base64");
        const rotationX = buffer$1.readInt16LE(0);
        const rotationY = buffer$1.readInt16LE(2);
        const rotationZ = buffer$1.readInt16LE(4);
        const rotationW = buffer$1.readInt16LE(6);

        const gravityRawX = buffer$1.readInt16LE(8);
        const gravityRawY = buffer$1.readInt16LE(10);
        const gravityRawZ = buffer$1.readInt16LE(12);

        let ankle = null;
        if (data.slice(-2) !== "==" && data.length > 14){
            ankle = buffer$1.readInt16LE(14);
        }
        

        const rotation = {
            x: rotationX / 180.0 * 0.01,
            y: rotationY / 180.0 * 0.01,
            z: rotationZ / 180.0 * 0.01 * -1.0,
            w: rotationW / 180.0 * 0.01 * -1.0
        };
        trackerRotation[trackerName] = rotation;

        const gravityRaw = {
            x: gravityRawX / 256.0,
            y: gravityRawY / 256.0,
            z: gravityRawZ / 256.0
        };
        trackerAccel[trackerName] = gravityRaw;

        const rc = [rotation.w, rotation.x, rotation.y, rotation.z];
        const r = [rc[0], -rc[1], -rc[2], -rc[3]];
        const p = [0.0, 0.0, 0.0, 9.8];

        const hrp = [
            r[0] * p[0] - r[1] * p[1] - r[2] * p[2] - r[3] * p[3],
            r[0] * p[1] + r[1] * p[0] + r[2] * p[3] - r[3] * p[2],
            r[0] * p[2] - r[1] * p[3] + r[2] * p[0] + r[3] * p[1],
            r[0] * p[3] + r[1] * p[2] - r[2] * p[1] + r[3] * p[0],
        ];

        const hFinal = [
            hrp[0] * rc[0] - hrp[1] * rc[1] - hrp[2] * rc[2] - hrp[3] * rc[3],
            hrp[0] * rc[1] + hrp[1] * rc[0] + hrp[2] * rc[3] - hrp[3] * rc[2],
            hrp[0] * rc[2] - hrp[1] * rc[3] + hrp[2] * rc[0] + hrp[3] * rc[1],
            hrp[0] * rc[3] + hrp[1] * rc[2] - hrp[2] * rc[1] + hrp[3] * rc[0],
        ];

        const gravity = {
            x: gravityRaw.x - hFinal[1] * -1.2,
            y: gravityRaw.y - hFinal[2] * -1.2,
            z: gravityRaw.z - hFinal[3] * 1.2,
        };

        if (elapsedTime >= DRIFT_INTERVAL) {
            if (!calibrated[trackerName]) {
                calibrated[trackerName] = {
                    pitch: driftValues[trackerName].pitch,
                    roll: driftValues[trackerName].roll,
                    yaw: driftValues[trackerName].yaw
                };
            }
        }

        if (elapsedTime < DRIFT_INTERVAL) {
            if (!driftValues[trackerName]) {
                driftValues[trackerName] = { pitch: 0, roll: 0, yaw: 0 };
            }
    
            const rotationDifference = calculateRotationDifference(
                new Quaternion(initialRotations[trackerName].w, initialRotations[trackerName].x, initialRotations[trackerName].y, initialRotations[trackerName].z).toEuler("XYZ"),
                new Quaternion(rotation.w, rotation.x, rotation.y, rotation.z).toEuler("XYZ")
            );
    
            const prevMagnitude = Math.sqrt(driftValues[trackerName].pitch ** 2 + driftValues[trackerName].roll ** 2 + driftValues[trackerName].yaw ** 2);
            const currMagnitude = Math.sqrt(rotationDifference.pitch ** 2 + rotationDifference.roll ** 2 + rotationDifference.yaw ** 2);
    
            if (currMagnitude > prevMagnitude) {
                driftValues[trackerName] = rotationDifference;
                log(driftValues[trackerName]);
            }
        }
    
    
        if (elapsedTime >= DRIFT_INTERVAL && calibrated) {
            const driftCorrection = {
                pitch: calibrated[trackerName].pitch * (elapsedTime / DRIFT_INTERVAL) % (2 * Math.PI),
                roll: calibrated[trackerName].roll * (elapsedTime / DRIFT_INTERVAL) % (2 * Math.PI),
                yaw: calibrated[trackerName].yaw * (elapsedTime / DRIFT_INTERVAL) % (2 * Math.PI),
            };
    
            const rotQuat = new Quaternion([rotation.w, rotation.x, rotation.y, rotation.z]);
    
            const rotationDriftCorrected = RotateAround(rotQuat, trackerAccel[trackerName], driftCorrection.yaw);
    
            log("Applied fix");
            log(rotation);
            log(rotationDriftCorrected, driftCorrection.yaw);
    
            return [rotationDriftCorrected, gravity, ankle];
        }

        return { rotation, gravity, ankle };
    } catch (error) {
        throw new Error("Error decoding IMU packet: " + error.message);
    }
}

function RotateAround(quat, vector, angle) {
    // Create a copy of the input quaternion
    var initialQuaternion = new Quaternion(quat.w, quat.x, quat.y, quat.z);

    // Create a rotation quaternion
    var rotationQuaternion = Quaternion.fromAxisAngle([vector.x, vector.y, vector.z], angle);

    // Apply the rotation to the copy of the input quaternion
    initialQuaternion = initialQuaternion.mul(rotationQuaternion).normalize();

    // Return the resulting quaternion as a dictionary
    return {
        x: initialQuaternion.x,
        y: initialQuaternion.y,
        z: initialQuaternion.z,
        w: initialQuaternion.w
    };
}


function calculateRotationDifference(prevRotation, currentRotation) {
    const pitchDifferenceRad = currentRotation[0] - prevRotation[0];
    const rollDifferenceRad = currentRotation[1] - prevRotation[1];
    const yawDifferenceRad = currentRotation[2] - prevRotation[2];

    return { pitch: pitchDifferenceRad, roll: rollDifferenceRad, yaw: yawDifferenceRad };
}


/**
 * Processes other tracker data received from the tracker by the dongle.
 * Read function comments for more information.
 * Support: GX6
 * 
 * @function processTrackerData
 * @param {string} data - The data to process.
 * @param {string} trackerName - The name of the tracker.
 * @fires haritora#tracker
**/

function processTrackerData(data, trackerName) {
    /* 
    * Currently unsure what other data a0/a1 could represent other than trying to find the trackers, I see other values for it too reporting every second (mag info?).
    * This could also be used to report calibration data when running the calibration through the software.
    */
    
    if (data === "7f7f7f7f7f7f") {
        //log(`Searching for tracker ${trackerName}...`);
        if (activeDevices.includes(trackerName)) activeDevices.splice(activeDevices.indexOf(trackerName), 1);
        haritora.emit("disconnect", trackerName);
    } else {
        log(`Tracker ${trackerName} other data processed: ${data}`);
    }

    // TODO - Find out what the other data represents, then add to emitted event
    haritora.emit("tracker", trackerName, data);
}


/**
 * Processes the button data received from the tracker by the dongle.
 * The data contains the information about the main and sub buttons on the tracker.
 * Support: GX6, Bluetooth
 * 
 * @function processButtonData
 * @param {string} data - The data to process.
 * @param {string} trackerName - The name of the tracker.
 * @param {string} characteristic - The characteristic of the data, if bluetooth trackers. (MainButton, SecondaryButton)
 * @fires haritora#button
**/

function processButtonData(data, trackerName, characteristic) {
    const MAIN_BUTTON_INDEX = 0;
    const SUB_BUTTON_INDEX = 1;
    const TRACKER_OFF = false;
    const TRACKER_ON = true;

    let currentButtons = trackerButtons.get(trackerName) || [0, 0];
    let buttonState = null;

    try {
        if (bluetoothEnabled) {
            if (characteristic === "MainButton") {
                currentButtons[MAIN_BUTTON_INDEX] += 1;
            } else if (characteristic === "SecondaryButton") {
                currentButtons[SUB_BUTTON_INDEX] += 1;
            }
            buttonState = TRACKER_ON; // Tracker is always on when connected via bluetooth, because need to be connected to read button data
        } else if (gx6Enabled) {
            currentButtons[MAIN_BUTTON_INDEX] = parseInt(data[6], 16);
            currentButtons[SUB_BUTTON_INDEX] = parseInt(data[9], 16);

            if (data[0] === "0" || data[7] === "f" || data[8] === "f" || data[10] === "f" || data[11] === "f") {
                log(`Tracker ${trackerName} is off/turning off...`);
                log(`Raw data: ${data}`);
                buttonState = TRACKER_OFF;
            } else {
                log(`Tracker ${trackerName} is on/turning on...`);
                log(`Raw data: ${data}`);
                buttonState = TRACKER_ON;
            }
        }
    } catch (err) {
        console.error(`Error processing button data for ${trackerName}: ${err}`);
        return false;
    }

    trackerButtons.set(trackerName, currentButtons);
    haritora.emit("button", trackerName, currentButtons[MAIN_BUTTON_INDEX], currentButtons[SUB_BUTTON_INDEX], buttonState);

    log(`Tracker ${trackerName} main button: ${currentButtons[MAIN_BUTTON_INDEX]}`);
    log(`Tracker ${trackerName} sub button: ${currentButtons[SUB_BUTTON_INDEX]}`);
    return true;
}


/**
 * Processes the battery data received from the tracker by the dongle.
 * It contains the information about the battery percentage, voltage, and charge status of the tracker.
 * Support: GX6, Bluetooth (partial)
 * 
 * @function processBatteryData
 * @param {string} data - The data to process.
 * @param {string} trackerName - The name of the tracker.
 * @fires haritora#battery
**/

function processBatteryData(data, trackerName) {
    const BATTERY_REMAINING_INDEX = 0;
    const BATTERY_VOLTAGE_INDEX = 1;
    const CHARGE_STATUS_INDEX = 2;
    let batteryData = [null, null, null];

    if (bluetoothEnabled) {
        try {
            let batteryRemainingHex = buffer.Buffer.from(data, "base64").toString("hex");
            batteryData[0] = parseInt(batteryRemainingHex, 16);
            log(`Tracker ${trackerName} battery remaining: ${batteryData[BATTERY_REMAINING_INDEX]}%`);
        } catch {
            console.error(`Error converting battery data to hex for ${trackerName}: ${data}`);
        }
    } else if (gx6Enabled) {
        try {
            const batteryInfo = JSON.parse(data);
            log(`Tracker ${trackerName} remaining: ${batteryInfo["battery remaining"]}%`);
            log(`Tracker ${trackerName} voltage: ${batteryInfo["battery voltage"]}`);
            log(`Tracker ${trackerName} Status: ${batteryInfo["charge status"]}`);
            batteryData[BATTERY_REMAINING_INDEX] = batteryInfo["battery remaining"];
            batteryData[BATTERY_VOLTAGE_INDEX] = batteryInfo["battery voltage"];
            batteryData[CHARGE_STATUS_INDEX] = batteryInfo["charge status"];
        } catch (err) {
            console.error(`Error parsing battery data JSON for ${trackerName}: ${err}`);
        }
    }

    trackerBattery.set(trackerName, batteryData);
    haritora.emit("battery", trackerName, ...batteryData);
}


/**
 * Processes the tracker settings data received from the dongle by the tracker.
 * Support: GX6
 * 
 * @function processTrackerSettings
 * @param {string} data - The data to process.
 * @param {string} trackerName - The name of the tracker.
 * @fires haritora#settings
**/

function processTrackerSettings(data, trackerName) {
    const SENSOR_MODE_INDEX = 6;
    const POSTURE_DATA_RATE_INDEX = 5;
    const SENSOR_AUTO_CORRECTION_INDEX = 10;
    const ANKLE_MOTION_DETECTION_INDEX = 13;
    try {
        const sensorMode = parseInt(data[SENSOR_MODE_INDEX]);
        const postureDataRate = parseInt(data[POSTURE_DATA_RATE_INDEX]);
        const sensorAutoCorrection = parseInt(data[SENSOR_AUTO_CORRECTION_INDEX]);
        const ankleMotionDetection = parseInt(data[ANKLE_MOTION_DETECTION_INDEX]);

        const sensorModeText = sensorMode === 0 ? "2" : "1";
        const postureDataRateText = postureDataRate === 0 ? "50" : "100";
        const ankleMotionDetectionText = ankleMotionDetection === 0 ? "false" : "true";

        const sensorAutoCorrectionComponents = [];
        if (sensorAutoCorrection & 1) sensorAutoCorrectionComponents.push("Accel");
        if (sensorAutoCorrection & 2) sensorAutoCorrectionComponents.push("Gyro");
        if (sensorAutoCorrection & 4) sensorAutoCorrectionComponents.push("Mag");

        const sensorAutoCorrectionText = sensorAutoCorrectionComponents.join(", ");

        log(`Tracker ${trackerName} settings:`);
        log(`Sensor Mode: ${sensorModeText}`);
        log(`Posture Data Transfer Rate: ${postureDataRateText}`);
        log(`Sensor Auto Correction: ${sensorAutoCorrectionText}`);
        log(`Ankle Motion Detection: ${ankleMotionDetectionText}`);
        log(`Raw data: ${data}`);

        if (!trackerSettingsRaw.has(trackerName) || trackerSettingsRaw.get(trackerName) !== data) {
            trackerSettingsRaw.set(trackerName, data);
            trackerSettings.set(trackerName, [sensorModeText, postureDataRateText, sensorAutoCorrectionComponents, ankleMotionDetectionText]);
            haritora.emit("settings", trackerName, sensorModeText, postureDataRateText, sensorAutoCorrectionComponents, ankleMotionDetectionText);
        }
    } catch (error) {
        console.error(`Error processing tracker settings for ${trackerName}:`, error);
    }
}


function log(message) {
    if (debug === 1) {
        console.log(message);
    } else if (debug === 2) {
        const stack = new Error().stack;
        const callerLine = stack.split("\n")[2];
        const callerName = callerLine.match(/at (\S+)/)[1];
        const lineNumber = callerLine.match(/:(\d+):/)[1];
        console.log(`${callerName} (line ${lineNumber}) || ${message}`);
    }
}

exports.HaritoraXWireless = HaritoraXWireless;
