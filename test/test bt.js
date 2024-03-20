import { HaritoraXWireless } from "../src/index.js";

let device = new HaritoraXWireless(true);
device.startConnection("bluetooth");

setInterval(() => {
    console.log("Active trackers for BT:", device.getActiveTrackers());
}, 5000);

setInterval(async () => {
    try {
        console.log("Active trackers for BT:", device.getActiveTrackers());
        console.log("Device info:", await device.getDeviceInfo("HaritoraXW-"));
        console.log("Device battery:", await device.getBatteryInfo("HaritoraXW-"));
    } catch (error) {
        console.error("Error getting device data:", error);
    }
}, 3000);

/*setTimeout(() => {
    console.log("Stopping connection");
    device.stopConnection("bluetooth");
    return;
}, 10000);

device.on("imu", (tracker, rotation, gravity, ankle) => {
    console.log(`IMU event fired, tracker: ${tracker}, rotation: ${rotation.x}, ${rotation.y}, ${rotation.z}, gravity: ${gravity.x}, ${gravity.y}, ${gravity.z}, ankle: ${ankle}`);
});

setTimeout(() => {
    device.setAllTrackerSettings(50, 2, [''], false);
}, 2000)

setTimeout(() => {
    device.setTrackerSettings("rightAnkle", 100, 1, ['accel', 'gyro'], true);
}, 8000);*/