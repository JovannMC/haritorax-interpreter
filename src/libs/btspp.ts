import { exec } from "child_process";
import { EventEmitter } from "events";

let main: BTSPP;

interface BluetoothDevice {
    name: string;
    address: string;
    comPort?: string;
}

// auto detection for windows:
// https://github.com/MicrosoftDocs/windows-driver-docs/blob/staging/windows-driver-docs-pr/install/devpkey-device-busreporteddevicedesc.md
// https://stackoverflow.com/questions/69362886/get-devpkey-device-busreporteddevicedesc-from-win32-pnpentity-in-c-sharp

export default class BTSPP extends EventEmitter {
    constructor() {
        super();
        main = this;
    }

    // holy shit i don't know what i'm doing help
    getPairedDevicesWindows = (): Promise<BluetoothDevice[]> => {
        return new Promise((resolve, reject) => {
            log("Executing PowerShell command to get paired Bluetooth devices...");
            exec(
                'powershell -Command "Get-PnpDevice -Class Bluetooth | Select-Object Name, DeviceID"',
                (err, stdout, _stderr) => {
                    if (err) {
                        error(`Error executing PowerShell command: ${err.message}`, true);
                        reject(err);
                        return;
                    }

                    log(`PowerShell command output: \r\n${stdout}`);

                    // Step 1: Parse the Bluetooth devices
                    const devices: BluetoothDevice[] = [];
                    const lines = stdout
                        .split("\n")
                        .map((line) => line.replace(/[^\x20-\x7E]/g, "").trim()) // Sanitize and trim
                        .filter((line) => line !== "" && !line.includes("Name")); // Exclude empty and header lines

                    lines.forEach((line, index) => {
                        log(`Processing line ${index}: "${line}"`);
                        const match = line.match(/^(.+?)\s+(.+)$/);
                        if (match) {
                            const name = match[1].trim();
                            const deviceId = match[2].trim();
                            const deviceIdShort = deviceId.match(/(?:DEV_|BLUETOOTHDEVICE_)(\w+)/)?.[1];
                            log(`Found device - Name: ${name}, DeviceID: ${deviceId}, ShortID: ${deviceIdShort}`);
                            if (name.startsWith("Haritora") && deviceIdShort) {
                                devices.push({ name, address: deviceIdShort });
                                log(`Added device - Name: ${name}, Address: ${deviceIdShort}`);
                            }
                        } else {
                            log(`No match for line ${index}: "${line}"`);
                        }
                    });

                    // Step 2: Match devices with COM ports
                    log("Executing WMIC command to get serial ports...");
                    exec("wmic path Win32_SerialPort get DeviceID,PNPDeviceID", (err, stdout, _stderr) => {
                        if (err) {
                            error(`Error executing WMIC command: ${err.message}`, true);
                            reject(err);
                            return;
                        }

                        log(`WMIC command output: \r\n${stdout}`);

                        const comPorts = stdout
                            .split("\n")
                            .map((line) => line.replace(/[^\x20-\x7E]/g, "").trim()) // Sanitize and trim
                            .filter((line) => line !== "" && !line.includes("DeviceID")); // Exclude empty and header lines

                        comPorts.forEach((line, index) => {
                            log(`Processing COM port line ${index}: "${line}"`);
                            const match = line.match(/^(\w+)\s+(.+)$/);
                            if (match) {
                                const comPort = match[1];
                                const pnpDeviceId = match[2];
                                const deviceIdShort = pnpDeviceId.match(/&(\w+)_C/)?.[1];
                                log(`Extracted COM port: ${comPort}, PNPDeviceID: ${pnpDeviceId}, ShortID: ${deviceIdShort}`);

                                const device = devices.find((d) => deviceIdShort && d.address === deviceIdShort);
                                if (device) {
                                    device.comPort = comPort;
                                    log(
                                        `Matched device - Name: ${device.name}, Address: ${device.address}, COM Port: ${comPort}`,
                                    );
                                }
                            } else {
                                log(`No match for COM port line ${index}: "${line}"`);
                            }
                        });

                        resolve(devices);
                    });
                },
            );
        });
    };

    getPairedDevicesLinux = (): Promise<BluetoothDevice[]> => {
        return new Promise((resolve, reject) => {
            log("Executing bluetoothctl command to get paired Bluetooth devices...");
            exec("bluetoothctl devices Paired", (err, stdout, _stderr) => {
                if (err) {
                    error(`Error executing bluetoothctl command: ${err.message}`, true);
                    reject(err);
                    return;
                }

                log(`bluetoothctl command output: \r\n${stdout}`);

                const devices: BluetoothDevice[] = [];
                const lines = stdout.split("\n").filter((line) => line.trim() !== "");

                lines.forEach((line) => {
                    log(`Processing line: ${line}`);
                    const parts = line.split(" ");
                    const address = parts[1];
                    const name = parts.slice(2).join(" ");
                    devices.push({ name, address });
                    log(`Added device - Name: ${name}, Address: ${address}`);
                });

                log("Executing dmesg command to get serial ports...");
                exec("dmesg | grep tty", (err, stdout, _stderr) => {
                    if (err) {
                        error(`Error executing dmesg command: ${err.message}`, true);
                        reject(err);
                        return;
                    }

                    log(`dmesg command output: \r\n${stdout}`);

                    const comPorts = stdout.split("\n").filter((line) => line.includes("tty"));

                    comPorts.forEach((line) => {
                        log(`Processing COM port line: ${line}`);
                        const match = line.match(/tty[A-Za-z0-9]+/);
                        if (match) {
                            const comPort = match[0];
                            const device = devices.find((d) => line.includes(d.address));
                            if (device) {
                                device.comPort = `/dev/${comPort}`;
                                log(
                                    `Matched device - Name: ${device.name}, Address: ${device.address}, COM Port: /dev/${comPort}`,
                                );
                            }
                        }
                    });

                    resolve(devices);
                });
            });
        });
    };

    getPairedDevices = (): Promise<BluetoothDevice[] | null> => {
        const platform = process.platform;
        switch (platform) {
            case "win32":
                return this.getPairedDevicesWindows().catch((): Promise<BluetoothDevice[] | null> => {
                    error("Bluetooth is not available on this system", false);
                    return null;
                });
            case "linux":
                return this.getPairedDevicesLinux().catch((): Promise<BluetoothDevice[] | null> => {
                    error("Bluetooth is not available on this system", false);
                    return null;
                });
            default:
                return Promise.reject(new Error("Unsupported platform"));
        }
    };
}

/*
 * Helper functions
 */

function log(message: string) {
    console.log(message);
    main.emit("log", message);
}

function error(message: string, exceptional = false) {
    console.error(message);
    main.emit("logError", { message, exceptional });
}

export { BluetoothDevice, BTSPP };
