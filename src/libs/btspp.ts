import { exec } from "child_process";

interface BluetoothDevice {
    name: string;
    address: string;
    comPort?: string;
}

const getPairedDevicesWindows = (): Promise<BluetoothDevice[]> => {
    return new Promise((resolve, reject) => {
        exec("wmic path Win32_PnPEntity where \"Name like '%Bluetooth%'\" get Name,DeviceID", (error, stdout, _stderr) => {
            if (error) {
                reject(error);
                return;
            }

            const devices: BluetoothDevice[] = [];
            const lines = stdout.split("\n").filter((line) => line.trim() !== "" && !line.includes("Name"));

            lines.forEach((line) => {
                const [name, deviceId] = line.trim().split(/\s{2,}/);
                if (name && deviceId) {
                    devices.push({ name, address: deviceId });
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
                    const device = devices.find((d) => pnpDeviceId && d.address.includes(pnpDeviceId));
                    if (device) {
                        device.comPort = comPort;
                    }
                });

                resolve(devices);
            });
        });
    });
};

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

export { getPairedDevices, BluetoothDevice };
