import { HaritoraXWireless, setTrackerSettings, setAllTrackerSettings } from "haritorax-interpreter";

let trackers = new HaritoraXWireless();
trackers.startConnection("gx6");
console.log(`Trackers: ${trackers.getTrackers()}`);
console.log(`Trackers in port COM3: ${trackers.getTrackersInPort("COM3")}`);
console.log(`Body part of tracker 1 in port COM5: ${trackers.getPartFromInfo(1, "COM5")}`);
console.log(`getTrackerInfo: ${trackers.getTrackerInfo("rightKnee")}`);
console.log(`Active ports: ${trackers.getActivePorts()}`);
/*setTimeout(() => {
    console.log("Stopping connection");
    trackers.stopConnection("gx6");
}, 5000);*/

setTimeout(() => {
    setAllTrackerSettings(50, 2, [''], false);
}, 2000)

setTimeout(() => {
    setTrackerSettings("rightAnkle", 100, 1, ['Accel', 'Gyro'], true);
}, 8000);