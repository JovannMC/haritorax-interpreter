# HaritoraX Interpreter

A node.js package that enables communication with the HaritoraX FBT trackers to read & write data to them. No HaritoraConfigurator / Shiftall VR Manager software needed!

Check out the Haritora-GX(6/2) POC if you want some more info: <https://github.com/JovannMC/haritora-gx-poc>

## Installation

`npm install haritorax-interpreter`

or

`pnpm install haritorax-interpreter`

or

`(insert whatever package manager, lol)`

## Quick start

The package is split so you can import only what you need and most dependencies are optional:

```ts
import { createHaritoraX } from "haritorax-interpreter";
import { createSerialConnection } from "haritorax-interpreter/connections/serial";

const serial = createSerialConnection();
const app = createHaritoraX({ connections: [serial], logLevel: "info" });

const endpoints = await app.discover();
for (const endpoint of endpoints) await app.connect(endpoint.id);

app.on("imu", (sample) => console.log(sample.deviceId, sample.rotation));
```

Bluetooth LE is used by using `createBleConnection` from `haritorax-interpreter/connections/ble`.

### Serial options

GX2 and GX6 dongles are detected by VID/PID. Wired SPP detection is opt-in:

```ts
const serial = createSerialConnection({ includeWired: true });
```

If you prefer, you can specify serial port paths explicitly instead, GX(6/2) dongles or wired SPP devices:

```ts
const serial = createSerialConnection({
    serialPorts: ["COM14", "/dev/ttyACM0", "/dev/rfcomm0"],
});
```

On Linux, you can use optionally use `autoBindWired: true` to check paired HaritoraX Wired Bluetooth devices, resolve their SPP channel with `sdptool`, and attempt `rfcomm bind` for you, instead of doing it yourself. This requires `bluetoothctl`, `sdptool`, and `rfcomm`.

If you want to do it manually instead, find the paired device and resolve its SPP channel:

```bash
# look for a "HaritoraX" device and note its MAC address
bluetoothctl devices Paired

# make sure it says "Connected: yes"
bluetoothctl info <MAC>
# e.g. bluetoothctl info 00:11:22:33:44:55

# find the "Serial Port" profile and note the Channel number
sdptool browse <MAC>
# e.g. sdptool browse 00:11:22:33:44:55
```

Then bind it to an RFCOMM device:

```bash
sudo rfcomm bind /dev/rfcomm0 <MAC> <channel>
# e.g. sudo rfcomm bind /dev/rfcomm0 00:11:22:33:44:55 1
```

The device will then appear as `/dev/rfcomm0` and be detected automatically by the package.

## Linux-specific instructions

For Linux users, you (or your users) need to do some setup depending on the connection mode so the package can communicate with the trackers:

### Serial ports / Bluetooth (SPP)

- Run the following commands in your terminal:
  - `sudo usermod -a -G dialout $USER`
  - `sudo usermod -a -G uucp $USER` (for Arch-based distros)
- Restart your computer

### Bluetooth (LE)

BLE on Linux uses [noble](https://github.com/stoprocent/noble)'s BlueZ D-Bus binding through the optional `dbus-next` dependency. On most distributions just make sure BlueZ is running, Bluetooth is enabled, and your user has access to the adapter.

If discovery fails with a D-Bus or permission error, check your distribution's BlueZ/polkit configuration and system logs.

## Supported devices

| Device             | Supported | Additional trackers (e.g. elbow/hip) | Extensions |
| ------------------ | --------- | ------------------------------------ | ---------- |
| HaritoraX 2 Pro    | ?         | ?                                    | -          |
| HaritoraX 2        | Y         | Y                                    | Y          |
| HaritoraX Wireless | Y         | Y                                    | -          |
| HaritoraX 1.1B     | Y         | Y                                    | -          |
| HaritoraX 1.1      | Y         | Y                                    | -          |
| HaritoraX 1.0      | Y         | Y                                    | -          |
| Haritora           | N         | N                                    | -          |

| Communication mode       | Supported |
| ------------------------ | --------- |
| Bluetooth (Low Energy)   | Y         |
| Bluetooth (SPP)          | Y         |
| GX6 Communication Dongle | Y         |
| GX2 Communication Dongle | Y         |

## Projects using package

- [SlimeTora](https://github.com/OCSYT/SlimeTora) - A program that connects any of the HaritoraX trackers to the SlimeVR server, supporting Bluetooth (SPP), Bluetooth (LE), and the GX(6/2) communication dongles for all the HaritoraX tracker models!

Let me know if you are using this package if you want to be featured here!

## License

This package is licensed under the [MIT](https://opensource.org/license/mit/) License - see the [LICENSE](LICENSE) file for details.

## Acknowledgements

- [SlimeTora](https://github.com/OCSYT/SlimeTora/) - BracketProto - original inspiration for project, code for turning gravity into acceleration values
- [SlimeVR](https://github.com/SlimeVR) - SlimeVR contributors - the inspiration for SlimeTora, which then inspired this project
- [haritorax-slimevr-bridge](https://github.com/sim1222/haritorax-slimevr-bridge) - sim1222 - math for decoding the IMU packet data
- [Shiftall Discord](https://discord.gg/vqXmAFy5RC) - community - helping with testing the package (via [SlimeTora](https://github.com/OCSYT/SlimeTora/))
