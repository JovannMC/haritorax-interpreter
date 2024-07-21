const { HaritoraX } = require("../dist/index.js");

let mode = process.argv[2] || "com";
let device = new HaritoraX("wireless", true, false);

if (mode === "bt" || mode === "bluetooth") {
    device.startConnection("bluetooth");

    setInterval(async () => {
        console.log("Active trackers for BT:", device.getActiveTrackers());
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
    device.startConnection("com", true);

    device.on("connect", (trackerName) => {
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
        console.log(`Tracker raw hex settings map:`, device.getTrackerSettingsRaw("rightAnkle"));
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
