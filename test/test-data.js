const fs = require("fs");
const { COM } = require("../dist/mode/com.js");

let device = new COM("wireless")

// read from data.txt and submit each line
fs.readFile("data.txt", "utf8", function (err, data) {
    if (err) return console.log(err);

    let lines = data.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const data = lines[i];
        device.processData(data, "CUSTOM");
    }
});