import { HaritoraXWireless } from "haritorax-interpreter";

let trackers = new HaritoraXWireless();
trackers.startConnection("gx6");

/*setTimeout(() => {
    console.log("Stopping connection");
    trackers.stopConnection("gx6");
}, 5000);*/

trackers.on("settings", (trackerName, sensorModeText, postureDataRateText, sensorAutoCorrectionComponents, ankleMotionDetectionText) => {
    // handle the event
    console.log("settings from event: " + trackerName, sensorModeText, postureDataRateText, sensorAutoCorrectionComponents, ankleMotionDetectionText);
});

setTimeout(() => {
    trackers.setAllTrackerSettings(50, 2, [''], false);
}, 2000)

setTimeout(() => {
    trackers.setTrackerSettings("rightAnkle", 100, 1, ['accel', 'gyro'], true);
}, 8000);