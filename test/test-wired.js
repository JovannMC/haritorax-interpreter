const fs = require("fs");
const { HaritoraX } = require("../dist/index.js");

let device = new HaritoraX("wired", true, false, false, true);

device.startConnection("com", [""]);

// read from data.txt and submit each line
fs.readFile("data.txt", "utf8", function (err, data) {
    if (err) return console.log(err);

    let lines = data.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const data = lines[i];
        const splitData = data.toString().split(/:(.+)/);
        const identifier = splitData[0].toLowerCase();
        const portData = splitData[1];

        device.emitEvent("data", null, null, null, identifier, portData);
    }
});

device.on("connect", (trackerName) => {
    console.log(`Connected to tracker ${trackerName}`);
    console.log(`Active trackers for COM:`, device.getActiveTrackers());
});

/*setInterval(async () => {
    try {
        console.log("Active trackers for GX:", device.getActiveTrackers());
        console.log("Device info:", await device.getDeviceInfo("rightAnkle"));
        console.log("Device battery:", await device.getBatteryInfo("rightAnkle"));
        console.log("Device magnetometer:", await device.getTrackerMag("rightAnkle"));
    } catch (error) {
        console.error("Error getting device data:", error);
    }
}, 3000);

setTimeout(() => {
    //device.setAllTrackerSettings(50, 2, [''], false);
    console.log(`Tracker settings map:`, device.getTrackerSettings("rightAnkle"));
    console.log(`Tracker buttons map:`, device.getTrackerButtons("rightAnkle"));
    console.log(`Tracker battery map:`, device.getBatteryInfo("rightAnkle"));
}, 5000);

setTimeout(() => {
    console.log("Stopping connection");
    device.stopConnection("gx");
    }, 5000);

    setTimeout(() => {
        device.setAllTrackerSettings(2, 50, [''], false);
    }, 2000)

    setTimeout(() => {
        device.setTrackerSettings("rightAnkle", 1, 100, ['accel', 'gyro'], true);
    }, 8000);*/
