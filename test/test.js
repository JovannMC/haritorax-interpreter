const { HaritoraX } = require("../dist/index.js");
require("../dist/libs/btspp.js");

let mode = process.argv[2] || "bluetooth";
let device = new HaritoraX("wireless", false, false, false, false);

if (mode === "bt" || mode === "bluetooth") {
    device.startConnection("bluetooth");

    device.on("connect", async (trackerName) => {
        console.log(`Connected to tracker ${trackerName}`);
    });

    device.on("mag", async (trackerName, magData) => {
        console.log(`Mag data for ${trackerName}:`, magData);
    });

    setInterval(async () => {
        console.log("Active trackers for BT:", device.getActiveTrackers());
        await device.fireTrackerMag("HaritoraX2-C1M8W0");
    }, 5000);

    /*setInterval(async () => {
        try {
            console.log("Active trackers for BT:", device.getActiveTrackers());
            console.log("Device settings:", await device.getTrackerSettings("HaritoraXW-(SERIAL)"));
        } catch (error) {
            console.error("Error getting device data:", error);
        }
    }, 3000);*/
} else {
    device.startConnection("com", ["COM3", "COM4", "COM5"]);

    device.on("connect", async (trackerName) => {
        console.log(`Connected to tracker ${trackerName}`);
        console.log(`Active trackers for COM:`, device.getActiveTrackers());
    });

    setInterval(async () => {
        try {
            console.log("Active trackers for COM:", device.getActiveTrackers());
        } catch (error) {
            console.error("Error getting device data:", error);
        }
    }, 3000);

    setTimeout(() => {
        //device.setTrackerSettings("rightAnkle", 50, 2, [''], false);
        console.log(`Tracker settings map:`, device.getTrackerSettings("rightAnkle"));
        console.log(`Tracker buttons map:`, device.getTrackerButtons("rightAnkle"));
    }, 5000);

    /*setTimeout(() => {
    console.log("Stopping connection");
    device.stopConnection("com");
    }, 5000);

    setTimeout(() => {
        device.setAllTrackerSettings(2, 50, [''], false);
    }, 2000)

    setTimeout(() => {
        device.setTrackerSettings("rightAnkle", 1, 100, ['accel', 'gyro'], true);
    }, 8000);*/
}
