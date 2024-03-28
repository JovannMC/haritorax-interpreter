# HaritoraX Interpreter

![Showcase of the package output with debug logs on, showing the data such as tracker settings, info, and interpreted IMU data via the GX6 dongle](showcase.png)

A node.js package that allows you to communicate and interact with the HaritoraX FBT trackers to interpret the data how you want it. No HaritoraConfigurator software needed!

Check out the Haritora-GX6 proof-of-concept repository here: https://github.com/JovannMC/haritora-gx6-poc

## Installation

`npm install haritorax-interpreter`

## Documentation

Will write actual documentation at some point, for now refer to the source code, JSDoc comments, and example below.

## Supported devices

| Device             | Supported | Elbow/Hip support |
|--------------------|-----------|-------------------|
| HaritoraX Wireless |     Y     |         X         |
| HaritoraX 1.1B     |     X     |         X         |
| HaritoraX 1.1      |     X     |         X         |
| HaritoraX 1.0      |     X     |         X         |
| Haritora           |     X     |         X         |

| Communication mode        | Supported |
|---------------------------|-----------|
| Bluetooth                 |     *     |
| GX6 Communication Dongle  |     Y     |
| GX2 Communication Dongle  |     X     |

**\* partial support**

## Example
```js
import { HaritoraXWireless } from "haritorax-interpreter";

let device = new HaritoraXWireless(2); // enable debug mode w/ function info
device.startConnection("gx6", ["COM4", "COM5", "COM6"]); // start connecting to dongles via GX6, with the ports COM4, COM5, and COM6

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
    device.stopConnection("gx6");
}, 10000)
```

## Projects using package

- [SlimeTora](https://github.com/OCSYT/SlimeTora) - A program that connects the HaritoraX Wireless trackers to the SlimeVR server, supporting Bluetooth and the GX6 communication dongle

Let me know if you want to be featured here, if you are using this package in any project!

## License

This package is licensed under the [MIT](https://opensource.org/license/mit/) License - see the [LICENSE](LICENSE) file for details.

## Acknowledgements

- [haritorax-slimevr-bridge](https://github.com/sim1222/haritorax-slimevr-bridge) - sim1222 - math for decoding the IMU packet data
- [SlimeTora](https://github.com/OCSYT/SlimeTora/) - BracketProto - code for fixing drifting from incorrect acceleration (gravity) values
- [ShiftAll Discord](https://discord.gg/vqXmAFy5RC) - ommunity - helping with testing the package