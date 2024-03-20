import { HaritoraXWireless } from "../src/index.js";

let device = new HaritoraXWireless(true);
device.startConnection("gx6");

device.on("imu", (tracker, rotation, gravity, ankle) => {
    //console.log(`IMU event fired, tracker: ${tracker}, rotation: ${rotation}, gravity: ${gravity}, ankle: ${ankle}`);
});

setInterval(async () => {
    try {
        console.log("Active trackers for GX6:", device.getActiveTrackers());
        console.log("Device info:", await device.getDeviceInfo("rightAnkle"));
        console.log("Device battery:", await device.getBatteryInfo("rightAnkle"));
    } catch (error) {
        console.error("Error getting device data:", error);
    }
}, 3000);

setTimeout(() => {
    device.setTrackerSettings("rightAnkle", 50, 2, [''], false);
}, 5000);

/*setTimeout(() => {
    console.log("Stopping connection");
    device.stopConnection("gx6");
}, 5000);

setTimeout(() => {
    device.setAllTrackerSettings(50, 2, [''], false);
}, 2000)

setTimeout(() => {
    device.setTrackerSettings("rightAnkle", 100, 1, ['accel', 'gyro'], true);
}, 8000);*/