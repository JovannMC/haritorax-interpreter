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

        // Assuming `lines[i]` contains the base64 encoded string for all trackers
        const data = lines[i]; // The base64 string
        const buffer = Buffer.from(data, 'base64');

        // Ensure the buffer length is as expected: 14 bytes * 6 trackers = 84 bytes
        if (buffer.length === 84) {
            trackerNames.forEach((trackerName, index) => {
                const start = index * 14; // 14 bytes per tracker
                const trackerBuffer = buffer.slice(start, start + 14);
                
                // Now `trackerBuffer` contains the 14 bytes for the current tracker
                // You can then decode and process each tracker's data from `trackerBuffer`
                device.parseData(trackerBuffer, trackerName);
            });
        } else {
            console.error("Unexpected data length:", buffer.length);
        }
    }
});
