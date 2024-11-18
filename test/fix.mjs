import { COM } from "../dist/mode/com.js";

const com = new COM("wireless", 2000, true);
com.startConnection(["COM4"]);

function writeToPort(port, rawData) {
    const ports = com.getActivePorts();
    const data = `\n${rawData}\n`;

    if (!ports[port]) {
        console.error(`Port ${port} not found in active ports.`, true);
        return;
    }

    ports[port].write(data, (err) => {
        if (err) {
            console.error(`Error writing data to serial port ${port}: ${err}`);
        } else {
            console.log(`Data written to serial port ${port}: ${rawData.toString().replace(/\r\n/g, " ")}`);
        }
    });
}

setInterval(() => {
    writeToPort("COM4", `o0:00000110107000`);
}, 100);
