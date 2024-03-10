import { HaritoraXWireless } from "../src/index.js";

let device = new HaritoraXWireless(true);
device.startConnection("bluetooth");

/*setTimeout(() => {
    console.log("Stopping connection");
    device.stopConnection("bluetooth");
}, 5000);

device.on("imu", (tracker, rotation, gravity, ankle) => {
    console.log(`IMU event fired, tracker: ${tracker}, rotation: ${rotation}, gravity: ${gravity}, ankle: ${ankle}`);
});

setTimeout(() => {
    device.setAllTrackerSettings(50, 2, [''], false);
}, 2000)

setTimeout(() => {
    device.setTrackerSettings("rightAnkle", 100, 1, ['accel', 'gyro'], true);
}, 8000);*/