import { exec } from "child_process";

interface BluetoothDevice {
    name: string;
    address: string;
    comPort?: string;
}

const getPairedDevicesWindows = (): Promise<BluetoothDevice[]> => {
    return new Promise((resolve, reject) => {
        exec('powershell -Command "Get-PnpDevice -Class Bluetooth | Select-Object Name, DeviceID"', (error, stdout, _stderr) => {
            if (error) {
                reject(error);
                return;
            }

            const devices: BluetoothDevice[] = [];
            const lines = stdout.split("\n").filter((line) => line.trim() !== "" && !line.includes("Name"));

            lines.forEach((line) => {
                const match = line.trim().match(/^(.+?)\s{2,}(.+)$/);
                if (match) {
                    const name = match[1].trim();
                    const deviceId = match[2].trim();
                    const deviceIdShort = deviceId.match(/DEV_(\w+)/)?.[1];
                    if (name.startsWith("Haritora") && deviceIdShort) {
                        devices.push({ name, address: deviceIdShort });
                    }
                }
            });

            exec("wmic path Win32_SerialPort get DeviceID,PNPDeviceID", (error, stdout, _stderr) => {
                if (error) {
                    reject(error);
                    return;
                }

                const comPorts = stdout.split("\n").filter((line) => line.trim() !== "" && !line.includes("DeviceID"));

                comPorts.forEach((line) => {
                    const [comPort, pnpDeviceId] = line.trim().split(/\s{2,}/);
                    const deviceIdShort = pnpDeviceId.match(/&(\w+)_C/)?.[1];
                    const device = devices.find((d) => deviceIdShort && d.address.includes(deviceIdShort));
                    if (device) {
                        device.comPort = comPort;
                    }
                });

                resolve(devices);
            });
        });
    });
};

// TODO: unknown if this works properly lol (i don't have any BTSPP devices afaik)
const getPairedDevicesLinux = (): Promise<BluetoothDevice[]> => {
    return new Promise((resolve, reject) => {
        exec("bluetoothctl devices Paired", (error, stdout, _stderr) => {
            if (error) {
                reject(error);
                return;
            }

            const devices: BluetoothDevice[] = [];
            const lines = stdout.split("\n").filter((line) => line.trim() !== "");

            lines.forEach((line) => {
                const parts = line.split(" ");
                const address = parts[1];
                const name = parts.slice(2).join(" ");
                devices.push({ name, address });
            });

            exec("dmesg | grep tty", (error, stdout, _stderr) => {
                if (error) {
                    reject(error);
                    return;
                }

                const comPorts = stdout.split("\n").filter((line) => line.includes("tty"));

                comPorts.forEach((line) => {
                    const match = line.match(/tty[A-Za-z0-9]+/);
                    if (match) {
                        const comPort = match[0];
                        const device = devices.find((d) => line.includes(d.address));
                        if (device) {
                            device.comPort = `/dev/${comPort}`;
                        }
                    }
                });

                resolve(devices);
            });
        });
    });
};

const getPairedDevices = (): Promise<BluetoothDevice[]> => {
    const platform = process.platform;
    switch (platform) {
        case "win32":
            return getPairedDevicesWindows();
        case "linux":
            return getPairedDevicesLinux();
        default:
            return Promise.reject(new Error("Unsupported platform"));
    }
};

export { BluetoothDevice, getPairedDevices };
