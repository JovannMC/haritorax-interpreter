# HaritoraX Interpreter

![Showcase of the package output with debug logs on, showing the data such as tracker settings, info, and interpreted IMU data via the GX6 dongle](showcase.png)

A node.js package that enables communication with the HaritoraX FBT trackers to read/write data to the trackers. No HaritoraConfigurator software needed (mostly)!

Check out the Haritora-GX(6/2) proof-of-concept repository here: https://github.com/JovannMC/haritora-gx-poc
-  A new proof-of-concept repo will be made soon, including all the information I've found about the trackers while developing this package!

## Installation

`npm install haritorax-interpreter`

## Documentation

Will write actual documentation at some point, for now refer to the source code, examples, and JSDoc comments. You may also see how it's used in [SlimeTora](https://github.com/OCSYT/SlimeTora)!

## Linux-specific instructions

For Linux users, you (or your users) need to do some setup depending on the connection mode so the package can communicate with the trackers:

### Bluetooth Classic (SPP)/COM/Serial port

- Run the following commands in your terminal:
  - `sudo usermod -a -G dialout $USER`
  - `sudo usermod -a -G tty $USER`
  - `sudo usermod -a -G uucp $USER` (for Arch-based distros)
- Restart your computer

### Bluetooth (LE)

> See https://github.com/chrvadala/node-ble/tree/main?tab=readme-ov-file#provide-permissions for more info

- Create a new dbus rule (e.g. `/etc/dbus-1/system.d/node-ble.conf`)
- Insert the following as the contents, changing `%userid%` with your user

```
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
  "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <policy user="%userid%">
   <allow own="org.bluez"/>
    <allow send_destination="org.bluez"/>
    <allow send_interface="org.bluez.GattCharacteristic1"/>
    <allow send_interface="org.bluez.GattDescriptor1"/>
    <allow send_interface="org.freedesktop.DBus.ObjectManager"/>
    <allow send_interface="org.freedesktop.DBus.Properties"/>
  </policy>
</busconfig>
```

- Restart your computer

## Supported devices

| Device             | Supported | Elbow/Hip support |
|--------------------|-----------|-------------------|
| HaritoraX Wireless |     Y     |         Y         |
| HaritoraX 1.1B     |     Y     |         Y         |
| HaritoraX 1.1      |     Y     |         Y         |
| HaritoraX 1.0      |     Y     |         Y         |
| Haritora           |     ?     |         ?         |

| Communication mode        | Supported |
|---------------------------|-----------|
| Bluetooth (Low Energy)    |     Y     |
| Bluetooth Classic (COM)   |     Y     |
| GX6 Communication Dongle  |     Y     |
| GX2 Communication Dongle  |     Y     |

## Example
```js
import { HaritoraX } from "haritorax-interpreter";

// connect to haritorax wireless, enable debug logs, allow printing of processIMUData() logs (lots of spam), print raw unprocessed data (more spam!)
let device = new HaritoraX("wireless", true, true, true);
// start connecting to dongles via GX dongles (COM connection), with the ports COM4, COM5, COM6, and COM7
device.startConnection("com", ["COM4", "COM5", "COM6", "COM7"]);

device.on("imu", (trackerName, rotation, gravity, ankle) => {
    // IMU data received, do stuff
});

setTimeout(() => {
    // apply the following settings to the rightAnkle tracker:
    // sensor mode: 1 (magnetometer enabled)
    // posture data transfer rate: 100FPS
    // sensor auto correction mode: accelerometer and gyroscope
    // ankle motion detection: enabled
    device.setTrackerSettings("rightAnkle", 1, 100, ['accel', 'gyro'], true);
}, 2000)

setTimeout(() => {
    device.stopConnection("com");
}, 10000)
```

## Projects using package

- [SlimeTora](https://github.com/OCSYT/SlimeTora) - A program that connects any of the HaritoraX trackers to the SlimeVR server, supporting Bluetooth (classic), Bluetooth (low energy), and the GX(6/2) communication dongles for all the HaritoraX tracker models!

Let me know if you want to be featured here, if you are using this package in any project!

## License

This package is licensed under the [MIT](https://opensource.org/license/mit/) License - see the [LICENSE](LICENSE) file for details.

## Acknowledgements

- [SlimeTora](https://github.com/OCSYT/SlimeTora/) - BracketProto - original inspiration for project, code for turning gravity into acceleration values
- [SlimeVR](https://github.com/SlimeVR) - SlimeVR contributors - the inspiration for SlimeTora, which then inspired this project
- [haritorax-slimevr-bridge](https://github.com/sim1222/haritorax-slimevr-bridge) - sim1222 - math for decoding the IMU packet data
- [Shiftall Discord](https://discord.gg/vqXmAFy5RC) - community - helping with testing the package (via [SlimeTora](https://github.com/OCSYT/SlimeTora/))
