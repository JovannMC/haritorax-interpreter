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
            log("Executing PowerShell command to get serial ports with DEVPKEY_Device_BusReportedDeviceDesc...");

            // PowerShell command to get serial ports and their bus reported device descriptions
            const powershellCommand = `
                $devices = Get-PnpDevice -Class "Ports" | Where-Object { $_.DeviceID -match "^BTHENUM" -or $_.DeviceID -match "^USB" } | ForEach-Object {
                    $device = $_
                    Write-Host "Processing device: $($device.FriendlyName)" -ForegroundColor Yellow
                    $busReportedDesc = $null
                    try {
                        $busReportedDesc = (Get-PnpDeviceProperty -InputObject $device -KeyName "DEVPKEY_Device_BusReportedDeviceDesc").Data
                        Write-Host "Bus reported desc: $busReportedDesc" -ForegroundColor Cyan
                    } catch {
                        Write-Host "Failed to get bus reported desc: $($_.Exception.Message)" -ForegroundColor Red
                        $busReportedDesc = $null
                    }
                    
                    # Get COM port from friendly name
                    $comPort = $null
                    if ($device.FriendlyName -match "COM([0-9]+)") {
                        $comPort = "COM" + $matches[1]
                        Write-Host "Found COM port: $comPort" -ForegroundColor Green
                    } else {
                        Write-Host "No COM port found in: $($device.FriendlyName)" -ForegroundColor Magenta
                        Write-Host "Testing regex on: '$($device.FriendlyName)'" -ForegroundColor Red
                    }
                    
                    [PSCustomObject]@{
                        FriendlyName = $device.FriendlyName
                        DeviceID = $device.DeviceID
                        BusReportedDesc = $busReportedDesc
                        ComPort = $comPort
                    }
                }
                Write-Host "Total devices found: $($devices.Count)" -ForegroundColor White
                $filteredDevices = $devices | Where-Object { $_.ComPort -ne $null }
                Write-Host "Devices with COM ports: $($filteredDevices.Count)" -ForegroundColor White
                if ($filteredDevices.Count -gt 0) {
                    $filteredDevices | ConvertTo-Json
                } else {
                    Write-Host "No devices with COM ports found" -ForegroundColor Red
                    "[]"
                }
            `;

            exec(`powershell -Command "${powershellCommand}"`, (err, stdout, stderr) => {
                if (err) {
                    error(`Error executing PowerShell command: ${err.message}`, true);
                    reject(err);
                    return;
                }

                if (stderr) {
                    log(`PowerShell stderr: ${stderr}`);
                }

                log(`PowerShell command output: \r\n${stdout}`);

                try {
                    const devices: BluetoothDevice[] = [];
                    let parsedData;

                    // Handle both single object and array responses
                    if (stdout.trim()) {
                        // Extract JSON part (everything after the last colored output)
                        const lines = stdout.split("\n");
                        const jsonStart = lines.findIndex((line) => line.trim().startsWith("[") || line.trim().startsWith("{"));
                        const jsonOutput = jsonStart >= 0 ? lines.slice(jsonStart).join("\n").trim() : stdout.trim();

                        log(`Attempting to parse JSON: ${jsonOutput}`);

                        if (jsonOutput === "[]" || jsonOutput === "") {
                            log("No devices found or empty JSON array");
                            resolve(devices);
                            return;
                        }

                        parsedData = JSON.parse(jsonOutput);
                        if (!Array.isArray(parsedData)) {
                            parsedData = [parsedData];
                        }
                    } else {
                        log("No output from PowerShell command");
                        parsedData = [];
                    }

                    parsedData.forEach((device: any) => {
                        log(
                            `Processing device: ${device.FriendlyName}, COM: ${device.ComPort}, BusDesc: ${device.BusReportedDesc}`,
                        );

                        // Check if this is a HaritoraX device based on bus reported description or friendly name
                        const isHaritoraX =
                            (device.BusReportedDesc &&
                                (device.BusReportedDesc.includes("HaritoraX 1") ||
                                    device.BusReportedDesc.startsWith("HaritoraX 1"))) ||
                            (device.FriendlyName &&
                                (device.FriendlyName.includes("HaritoraX 1") || device.FriendlyName.startsWith("HaritoraX 1")));

                        if (isHaritoraX && device.ComPort) {
                            const deviceName = device.BusReportedDesc || device.FriendlyName;
                            const deviceId = device.DeviceID;

                            // Extract a unique identifier from the device ID
                            const addressMatch =
                                deviceId.match(/[&_]([A-F0-9]{12})[&_]/i) ||
                                deviceId.match(/[&_]([A-F0-9]{8})[&_]/i) ||
                                deviceId.match(/([A-F0-9]{8,12})/i);
                            const address = addressMatch ? addressMatch[1] : deviceId.substring(deviceId.length - 8);

                            devices.push({
                                name: deviceName,
                                address: address,
                                comPort: device.ComPort,
                            });

                            log(`Added HaritoraX device - Name: ${deviceName}, Address: ${address}, COM Port: ${device.ComPort}`);
                        }
                    });

                    resolve(devices);
                } catch (parseErr) {
                    error(`Error parsing PowerShell output: ${parseErr}`, true);
                    reject(parseErr);
                }
            });
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
                return this.getPairedDevicesWindows().catch((err): Promise<BluetoothDevice[] | null> => {
                    error(`Error getting paired devices on Windows: ${err.message}`, false);
                    return Promise.resolve(null);
                });
            case "linux":
                return this.getPairedDevicesLinux().catch((err): Promise<BluetoothDevice[] | null> => {
                    error(`Error getting paired devices on Linux: ${err.message}`, false);
                    return Promise.resolve(null);
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
