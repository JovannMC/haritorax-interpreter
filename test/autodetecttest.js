const fs = require("fs");
const path = require("path");

// holy crap i have no idea what i'm doing with this
// pls help me
const getPairedDevicesWindowsTest = () => {
    return new Promise((resolve, reject) => {
        console.log("Reading test data for paired Bluetooth devices...");
        const devicesFile = path.join(__dirname, "devices.txt");
        const devices2File = path.join(__dirname, "devices2.txt");

        try {
            // Step 1: Find the line starting with "Haritora" and extract the ID
            const bluetoothData = fs.readFileSync(devicesFile, { encoding: "utf8" }).replace(/^\uFEFF/, '');
            console.log(`Test data for first command: \n${bluetoothData}`);

            // Split and sanitize lines
            const bluetoothLines = bluetoothData.split("\n").map(line => line.trim());
            const sanitizedLines = bluetoothLines.map(line => line.replace(/[^\x20-\x7E]/g, ''));

            // Debugging lines
            sanitizedLines.forEach((line, index) => console.log(`Line ${index}: "${line}"`));

            // Find the line that contains "Haritora"
            const haritoraLine = sanitizedLines.find(line => line.includes("Haritora"));

            if (!haritoraLine) {
                console.error("No Haritora device found. Dumping sanitized lines:");
                sanitizedLines.forEach((line, index) => console.log(`Line ${index}: "${line}"`));
                return resolve([]);
            }

            console.log(`Found Haritora line: ${haritoraLine}`);

            // Extract the ID after "BLUETOOTHDEVICE_"
            const idMatch = haritoraLine.match(/BLUETOOTHDEVICE_([A-F0-9]+)/);
            if (!idMatch) {
                console.error("No Bluetooth device ID found in Haritora line.");
                return resolve([]);
            }

            const deviceId = idMatch[1];
            console.log(`Extracted device ID: ${deviceId}`);

            // Step 2: Look for the line containing the extracted ID in the serial ports data
            console.log("Reading test data for serial ports...");
            const serialData = fs.readFileSync(devices2File, { encoding: "utf8" }).replace(/^\uFEFF/, '');
            console.log(`Test data for second command: \n${serialData}`);

            const serialLines = serialData.split("\n").map(line => line.trim());
            const sanitizedSerialLines = serialLines.map(line => line.replace(/[^\x20-\x7E]/g, ''));

            const serialLine = sanitizedSerialLines.find(line => line.includes(deviceId));

            if (!serialLine) {
                console.error("No serial port found matching the device ID.");
                return resolve([]);
            }

            console.log(`Found serial line: ${serialLine}`);

            // Extract the COM port from the start of the line
            const comPortMatch = serialLine.match(/^(COM\d+)/);
            if (!comPortMatch) {
                console.error("No COM port found in serial line.");
                return resolve([]);
            }

            const comPort = comPortMatch[1];
            console.log(`Extracted COM port: ${comPort}`);

            // Step 3: Construct the result
            const detectedDevice = {
                name: haritoraLine.split(/\s{2,}/)[0], // Extract the name from the Haritora line
                address: deviceId,
                comPort: comPort,
            };

            console.log(`Detected device: ${JSON.stringify(detectedDevice, null, 2)}`);
            resolve([detectedDevice]);
        } catch (err) {
            console.error(`Error: ${err.message}`);
            reject(err);
        }
    });
};

getPairedDevicesWindowsTest().then((result) => {
    console.log("Final detected devices:", result);
}).catch((error) => {
    console.error("Error during detection:", error);
});
