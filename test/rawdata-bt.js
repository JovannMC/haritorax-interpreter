const fs = require('fs');
const noble = require('@abandonware/noble');

noble.on("discover", (peripheral) => {
    const { advertisement: { localName } } = peripheral;
    if (localName && localName.startsWith('HaritoraX')) {
        console.log(`Found device: ${localName}`);
        peripheral.connect((err) => {
            if (err) {
                console.error(`Error connecting to ${localName}: ${err}`);
                return;
            }
            console.log(`Connected to ${localName}`);
            peripheral.discoverAllServicesAndCharacteristics((err, services, characteristics) => {
                if (err) {
                    console.error(`Error discovering services and characteristics: ${err}`);
                    return;
                }
                const deviceInfo = {
                    deviceName: localName,
                    services: services.map(service => ({
                        uuid: service.uuid,
                        name: service.name,
                        characteristics: characteristics
                            .filter(c => c._serviceUuid === service.uuid)
                            .map(c => ({ uuid: c.uuid, name: c.name })),
                    })),
                };
                fs.writeFileSync(`${localName}.txt`, JSON.stringify(deviceInfo, null, 2));
                console.log(`Device information saved to ${localName}.txt`);

                characteristics.forEach((characteristic) => {
                    characteristic.read((err, data) => {
                        if (err) {
                            console.error(`Error reading data from characteristic ${characteristic.uuid}: ${err}`);
                            return;
                        }
                        const hexData = data.toString('hex');
                        const utf8Data = data.toString('utf8');
                        const base64Data = data.toString('base64');
                        let uint8Data;
                        if (data.length > 0) {
                            uint8Data = data.readUInt8(0);
                        }

                        console.log(`Data from characteristic ${characteristic.uuid}: ${hexData}`);
                        console.log(`Data in utf-8: ${utf8Data}`);
                        console.log(`Data in hex: ${hexData}`);
                        console.log(`Data in base64: ${base64Data}`);
                        if (uint8Data !== undefined) {
                            console.log(`Data as unsigned 8-bit integer: ${uint8Data}`);
                        }

                        fs.appendFileSync(`${localName}.txt`, `\nData from characteristic ${characteristic.uuid}: ${hexData}`);
                        fs.appendFileSync(`${localName}.txt`, `\nData in utf-8: ${utf8Data}`);
                        fs.appendFileSync(`${localName}.txt`, `\nData in hex: ${hexData}`);
                        fs.appendFileSync(`${localName}.txt`, `\nData in base64: ${base64Data}`);
                        if (uint8Data !== undefined) {
                            fs.appendFileSync(`${localName}.txt`, `\nData as unsigned 8-bit integer: ${uint8Data}`);
                        }
                    });
                });
            });
        });
    }
});

console.log("Scanning for HaritoraX devices...")
noble.startScanning([], true);