import { HaritoraXWireless } from "../src/index.js";

let device = new HaritoraXWireless(2);
device.startConnection("gx6", ["COM4", "COM5", "COM6"]);

device.on("imu", (tracker, rotation, gravity, ankle) => {
    //console.log(`IMU event fired, tracker: ${tracker}, rotation: ${rotation}, gravity: ${gravity}, ankle: ${ankle}`);
});

device.on("connect", (trackerName) => {
    console.log(`Connected to tracker ${trackerName}`);
    console.log(`Active trackers for GX6:`, device.getActiveTrackers());
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
    //device.setTrackerSettings("rightAnkle", 50, 2, [''], false);
    console.log(`Tracker settings map:`, device.getTrackerSettings("rightAnkle"));
    console.log(`Tracker raw hex settings map:`, device.getTrackerSettingsRaw("rightAnkle"));
    console.log(`Tracker buttons map:`, device.getTrackerButtons("rightAnkle"));
    console.log(`Tracker battery map:`, device.getTrackerBattery("rightAnkle"));
}, 5000);

/*setTimeout(() => {
    console.log("Stopping connection");
    device.stopConnection("gx6");
}, 5000);

setTimeout(() => {
    device.setAllTrackerSettings(2, 50, [''], false);
}, 2000)

setTimeout(() => {
    device.setTrackerSettings("rightAnkle", 1, 100, ['accel', 'gyro'], true);
}, 8000);*/