import readline from "readline";
import { COM } from "../dist/mode/com.js";

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

rl.question("Enter the COM ports you want to use (separated by spaces): ", (answer) => {
    const comPorts = answer.split(" ").filter((port) => port.trim() !== "");
    const com = new COM("wireless", 2000, true);
    com.startConnection(comPorts);

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
        writeToPort(comPorts[0], `o0:00000110107000`);
        writeToPort(comPorts[0], `o1:00000110107000`);
    }, 100);

    rl.close();
});
