const SerialPort = require("serialport");
const readline = require("readline");
const fs = require("fs");
const process = require("process");

SerialPort.list().then((ports) => {
    console.log("Available ports:");
    ports.forEach((port) => {
        console.log(port.path);
    });
});

let rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

rl.question("Enter the port you want to use: ", (port) => {
    const serial = new SerialPort({
        path: port,
        baudRate: 500000,
    });
    serial.on("open", () => {
        console.log("Port opened");
    });

    serial.on("data", (data) => {
        console.log(data.toString());

        // write data to file
        fs.appendFile("rawdata.txt", data.toString(), (err) => {
            if (err) {
                console.error(err);
            }
        });
    });
    rl.close();
});
