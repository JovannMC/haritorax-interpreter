const { HaritoraX11b } = require("../dist/index.js");

let device = new HaritoraX11b(2);

const fs = require("fs");
/*
// read from data.txt and submit each line
fs.readFile("data.txt", "utf8", function (err, data) {
    if (err) {
        return console.log(err);
    }
    let lines = data.split("\n");
    for (let i = 0; i < lines.length; i++) {
        console.log(`Processing line ${i} - ${lines[i]}`);
        console.log(decodeIMUPacket(lines[i], "HaritoraX11b"));
    }
});


function decodeIMUPacket(data, trackerName) {
    try {
        const positions = [0, 44, 47, 52, 68, 87, 90, 100, data.length];
        const sections = positions.map((pos, i) =>
            data.slice(positions[i], positions[i + 1])
        );

        const buffer = sections.map((section) =>
            Buffer.from(section, "base64")
        );

        const devicesData = buffer.map((deviceBuffer, index) => {
            try {
                const rotationX = deviceBuffer.readInt16LE(0);
                const rotationY = deviceBuffer.readInt16LE(2);
                const rotationZ = deviceBuffer.readInt16LE(4);
                const rotationW = deviceBuffer.readInt16LE(6);

                const gravityRawX = deviceBuffer.readInt16LE(8);
                const gravityRawY = deviceBuffer.readInt16LE(10);
                const gravityRawZ = deviceBuffer.readInt16LE(12);

                let ankle =
                    deviceBuffer.length > 14
                        ? deviceBuffer.readInt16LE(14)
                        : undefined;

                const rotation = {
                    x: (rotationX / 180.0) * 0.01,
                    y: (rotationY / 180.0) * 0.01,
                    z: (rotationZ / 180.0) * 0.01 * -1.0,
                    w: (rotationW / 180.0) * 0.01 * -1.0,
                };
                trackerRotation[trackerName] = rotation;

                const gravityRaw = {
                    x: gravityRawX / 256.0,
                    y: gravityRawY / 256.0,
                    z: gravityRawZ / 256.0,
                };
                trackerAccel[trackerName] = gravityRaw;

                const rc = [rotation.w, rotation.x, rotation.y, rotation.z];
                const r = [rc[0], -rc[1], -rc[2], -rc[3]];
                const p = [0.0, 0.0, 0.0, 9.8];

                const hrp = [
                    r[0] * p[0] - r[1] * p[1] - r[2] * p[2] - r[3] * p[3],
                    r[0] * p[1] + r[1] * p[0] + r[2] * p[3] - r[3] * p[2],
                    r[0] * p[2] - r[1] * p[3] + r[2] * p[0] + r[3] * p[1],
                    r[0] * p[3] + r[1] * p[2] - r[2] * p[1] + r[3] * p[0],
                ];

                const hFinal = [
                    hrp[0] * rc[0] -
                        hrp[1] * rc[1] -
                        hrp[2] * rc[2] -
                        hrp[3] * rc[3],
                    hrp[0] * rc[1] +
                        hrp[1] * rc[0] +
                        hrp[2] * rc[3] -
                        hrp[3] * rc[2],
                    hrp[0] * rc[2] -
                        hrp[1] * rc[3] +
                        hrp[2] * rc[0] +
                        hrp[3] * rc[1],
                    hrp[0] * rc[3] +
                        hrp[1] * rc[2] -
                        hrp[2] * rc[1] +
                        hrp[3] * rc[0],
                ];

                const gravity = {
                    x: gravityRaw.x - hFinal[1] * -1.2,
                    y: gravityRaw.y - hFinal[2] * -1.2,
                    z: gravityRaw.z - hFinal[3] * 1.2,
                };

                if (elapsedTime >= DRIFT_INTERVAL) {
                    if (!calibrated[trackerName]) {
                        calibrated[trackerName] = {
                            pitch: driftValues[trackerName].pitch,
                            roll: driftValues[trackerName].roll,
                            yaw: driftValues[trackerName].yaw,
                        };
                    }
                }

                if (elapsedTime < DRIFT_INTERVAL) {
                    if (!driftValues[trackerName]) {
                        driftValues[trackerName] = {
                            pitch: 0,
                            roll: 0,
                            yaw: 0,
                        };
                    }

                    const rotationDifference = calculateRotationDifference(
                        new Quaternion(
                            initialRotations[trackerName].w,
                            initialRotations[trackerName].x,
                            initialRotations[trackerName].y,
                            initialRotations[trackerName].z
                        ).toEuler("XYZ"),
                        new Quaternion(
                            rotation.w,
                            rotation.x,
                            rotation.y,
                            rotation.z
                        ).toEuler("XYZ")
                    );

                    const prevMagnitude = Math.sqrt(
                        driftValues[trackerName].pitch ** 2 +
                            driftValues[trackerName].roll ** 2 +
                            driftValues[trackerName].yaw ** 2
                    );
                    const currMagnitude = Math.sqrt(
                        rotationDifference.pitch ** 2 +
                            rotationDifference.roll ** 2 +
                            rotationDifference.yaw ** 2
                    );

                    if (currMagnitude > prevMagnitude) {
                        driftValues[trackerName] = rotationDifference;
                        log(driftValues[trackerName]);
                    }
                }

                if (elapsedTime >= DRIFT_INTERVAL && calibrated) {
                    const driftCorrection = {
                        pitch:
                            (calibrated[trackerName].pitch *
                                (elapsedTime / DRIFT_INTERVAL)) %
                            (2 * Math.PI),
                        roll:
                            (calibrated[trackerName].roll *
                                (elapsedTime / DRIFT_INTERVAL)) %
                            (2 * Math.PI),
                        yaw:
                            (calibrated[trackerName].yaw *
                                (elapsedTime / DRIFT_INTERVAL)) %
                            (2 * Math.PI),
                    };

                    const rotQuat = new Quaternion([
                        rotation.w,
                        rotation.x,
                        rotation.y,
                        rotation.z,
                    ]);

                    const rotationDriftCorrected = RotateAround(
                        rotQuat,
                        trackerAccel[trackerName],
                        driftCorrection.yaw
                    );

                    log("Applied drift fix");

                    return {
                        rotation: {
                            x: rotationDriftCorrected.x,
                            y: rotationDriftCorrected.y,
                            z: rotationDriftCorrected.z,
                            w: rotationDriftCorrected.w,
                        },
                        gravity,
                        ankle,
                        magStatus,
                    };
                }

                return { rotation, gravity, ankle, magStatus };
            } catch (e) {
                console.error(e);
            }
        });
    } catch (e) {
        console.error(e);
    }
}
*/

const data = "avGw47EuBh7NAKX35wQ9A0gBDhpZOhMACAF3CZf+3fxY/uI/6wCU/zoJ7P9lA547BReU/+sAbQki1z8xAwDEANj/2P/P9fr5S8BN/+oATgAxAPX1";
const positions = [0, 44, 47, 52, 68, 87, 90, 100, data.length];

const sections = positions.map((pos, i) => data.slice(positions[i], positions[i + 1]));

sections.forEach((section, index) => {
    if (section[0] === "/") {
        sections[index] = section.slice(1);
    }
    if (section === "") {
        sections.splice(index, 1);
    }
});

sections.forEach((section, index) => {
    const buffer = Buffer.from(section, "base64");
    const hex = buffer.toString("hex");

    const uints = [];
    for (let i = 0; i < buffer.length; i += 2) {
        if (i + 1 < buffer.length) {
            uints.push(buffer.readInt16LE(1));
        }
    }

    console.log(`Section ${index + 1}:`);
    console.log(`Base64: ${section}`);
    console.log(`Hex: ${hex}`);
    console.log(`16-bit Little Endian Integers: ${uints.join(", ")}`);
});