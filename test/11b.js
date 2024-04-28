const { HaritoraX11b } = require("../dist/index.js");

let device = new HaritoraX11b(2, true);

const fs = require("fs");

// read from data.txt and submit each line
fs.readFile("data.txt", "utf8", function (err, data) {
    if (err) {
        return console.log(err);
    }
    let lines = data.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const trackerNames = [
            "leftknee",
            "rightknee",
            "chest",
            "hip",
            "rightankle",
            "leftankle",
        ];

        const bytesPerTracker = 14;
        const base64CharsPerByte = 4 / 3;
        const base64CharsPerTracker = bytesPerTracker * base64CharsPerByte;

        trackerNames.forEach((trackerName, index) => {
            const start = index * base64CharsPerTracker;
            const end = start + base64CharsPerTracker;
            const trackerData = lines[i].substring(start, end);
            device.parseData(trackerData, trackerName);
        });
    }
});