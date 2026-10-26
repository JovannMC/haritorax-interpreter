import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { decodeImu, decodeRange, magStatusFromByte, readImuStatusWord } from "../dist/protocol/codec/imu.js";
import { fromByteArray as encodeBase64, toByteArray as decodeBase64 } from "base64-js";
import { decodeSettings, modelFromFirmware, parseBattery, parseInfo } from "../dist/protocol/codec/messages.js";

interface Fixture {
    model: "wireless" | "x2" | "wired";
    payload: string;
    expected: {
        rotation: { x: number; y: number; z: number; w: number };
        acceleration: { x: number; y: number; z: number };
        magStatus?: string;
    };
}

const fixtures: Fixture[] = JSON.parse(readFileSync("test/fixtures/imu-wireless.json", "utf8")) as Fixture[];

function close(actual: number, expected: number): boolean {
    return Math.abs(actual - expected) < 1e-12;
}

// the fixtures are real frames (HXW from a dongle capture, HX2 from BLE), with the expected values worked out by a separate implementation of the same maths
describe("IMU decoding", () => {
    it("has captured fixtures for both trackers", () => {
        assert.ok(fixtures.length >= 12);
        assert.ok(fixtures.some((fixture) => fixture.model === "wireless"));
        assert.ok(fixtures.some((fixture) => fixture.model === "x2"));
    });

    it("keeps the captured fixtures at rest, so a tap or a move can't end up as an expected value", () => {
        for (const fixture of fixtures) {
            const decoded = decodeImu(fixture.payload, fixture.model);
            const { x, y, z } = decoded?.acceleration ?? { x: NaN, y: NaN, z: NaN };
            assert.ok(Math.hypot(x, y, z) < 1, `${fixture.model} fixture has ${Math.hypot(x, y, z)} m/s² of linear acceleration`);
        }
    });

    it("decodes unit quaternions", () => {
        for (const fixture of fixtures) {
            const { x, y, z, w } = decodeImu(fixture.payload, fixture.model)?.rotation ?? { x: NaN, y: NaN, z: NaN, w: NaN };
            assert.ok(Math.abs(Math.hypot(x, y, z, w) - 1) < 1e-3, `norm ${Math.hypot(x, y, z, w)}`);
        }
    });

    it("leaves no acceleration for a tracker lying still with gravity on one axis", () => {
        // identity orientation (the decoder flips the sign of w), 1 g on z. HX2 sends 2048 LSB per g, HXW and wired Q8 m/s²
        const frame = (accelZ: number) => {
            const bytes = new Uint8Array(14);
            const view = new DataView(bytes.buffer);
            view.setInt16(6, -16384, true);
            view.setInt16(12, accelZ, true);
            return encodeBase64(bytes);
        };

        for (const [model, accelZ] of [
            ["x2", 2048],
            ["wireless", 2510],
            ["wired", 2510],
        ] as const) {
            const acceleration = decodeImu(frame(accelZ), model)?.acceleration;
            assert.ok(Math.abs(acceleration?.x ?? NaN) < 1e-9, `${model} x`);
            assert.ok(Math.abs(acceleration?.y ?? NaN) < 1e-9, `${model} y`);
            assert.ok(Math.abs(acceleration?.z ?? NaN) < 0.01, `${model} z ${acceleration?.z}`);
        }
    });

    for (const [index, fixture] of fixtures.entries()) {
        it(`decodes fixture ${index} (${fixture.model})`, () => {
            const decoded = decodeImu(fixture.payload, fixture.model, readImuStatusWord(decodeBase64(fixture.payload)));
            assert.ok(decoded, "expected a decoded sample");

            for (const axis of ["x", "y", "z", "w"] as const) {
                assert.ok(
                    close(decoded.rotation[axis], fixture.expected.rotation[axis]),
                    `rotation.${axis}: ${decoded.rotation[axis]} != ${fixture.expected.rotation[axis]}`,
                );
            }

            for (const axis of ["x", "y", "z"] as const) {
                assert.ok(
                    close(decoded.acceleration[axis], fixture.expected.acceleration[axis]),
                    `acceleration.${axis}: ${decoded.acceleration[axis]} != ${fixture.expected.acceleration[axis]}`,
                );
            }

            assert.equal(decoded.magStatus, fixture.expected.magStatus);
        });
    }
});

describe("IMU packet quirks", () => {
    it("rejects a payload shorter than 14 bytes", () => {
        assert.equal(decodeImu(encodeBase64(new Uint8Array(10)), "wireless"), undefined);
    });

    it("does not take a range value from the padding of the payload", () => {
        // v3 treated a 14-byte payload (ends in a single "=") as having an ankle value, which was really acceleration
        const decoded = decodeImu(encodeBase64(decodeBase64("QAV1/Is6EBngAaf/bAkCAA==").slice(0, 14)), "wireless");
        assert.equal(decoded !== undefined && "ankleAngle" in decoded, false);
        assert.equal(decoded !== undefined && "range" in decoded, false);
    });

    it("decodes the range for each tracker", () => {
        // HX2: millimetres in bits 5-15 with a spread code below
        assert.equal(decodeRange("x2", (700 << 5) | 3), 700);
        assert.equal(decodeRange("x2", 0), 0);
        assert.equal(decodeRange("x2", 0xffff), undefined);

        // HXW and wired: signed millimetres, negative values are error codes
        assert.equal(decodeRange("wireless", 700), 700);
        assert.equal(decodeRange("wired", 700), 700);
        assert.equal(decodeRange("wireless", 0xfff9), undefined);
        assert.equal(decodeRange("wired", 0xff0b), undefined);
        assert.equal(decodeRange("wireless", 0xffff), undefined);

        assert.equal(decodeRange("x2", undefined), undefined);
    });

    it("decodes mag and tap from the status word for each IMU", () => {
        const payload = "QAV1/Is6EBngAaf/bAkCAA==";
        // IMU0: mag bits 0-1, tap bits 2-3, button press counts (bits 4-7) are ignored
        assert.equal(decodeImu(payload, "x2", 0x0003)?.magStatus, "great");
        assert.equal(decodeImu(payload, "x2", 0x0000)?.magStatus, "veryBad");
        assert.equal(decodeImu(payload, "x2", 0x0012)?.magStatus, "okay");
        assert.equal(decodeImu(payload, "x2", 0x0007)?.tap, 1);
        assert.equal(decodeImu(payload, "x2", 0x000f)?.tap, 3);
        assert.equal(decodeImu(payload, "x2", 0x0070)?.tap, 0);

        // IMU1 uses the same pattern shifted by 8 bits
        assert.equal(decodeImu(payload, "x2", 0x0b00, 1)?.magStatus, "great");
        assert.equal(decodeImu(payload, "x2", 0x0b00, 1)?.tap, 2);
        assert.equal(decodeImu(payload, "x2", 0x0b00, 0)?.magStatus, "veryBad");
    });

    it("does not guess mag for HX2 frames without a status word", () => {
        assert.equal(decodeImu("QAV1/Is6EBngAaf/bAkCAA==", "x2")?.magStatus, undefined);
        assert.equal(decodeImu("QAV1/Is6EBngAaf/bAkCAA==", "x2")?.tap, undefined);
    });

    it("maps wired mag bytes", () => {
        assert.equal(magStatusFromByte(0), "veryBad");
        assert.equal(magStatusFromByte(1), "bad");
        assert.equal(magStatusFromByte(2), "okay");
        assert.equal(magStatusFromByte(3), "great");
        assert.equal(magStatusFromByte(9), "unknown");
    });

    it("does not derive wired mag from the packet", () => {
        assert.equal(decodeImu("QAV1/Is6EBngAaf/bAkCAA==", "wired")?.magStatus, undefined);
    });
});

describe("base64", () => {
    it("round-trips", () => {
        const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
        assert.deepEqual(decodeBase64(encodeBase64(bytes)), bytes);
    });

    it("decodes a known payload", () => {
        assert.deepEqual([...decodeBase64("QAV1/Is6EBngAaf/bAkCAA==")].slice(0, 4), [0x40, 0x05, 0x75, 0xfc]);
    });
});

describe("messages", () => {
    it("parses tracker info, including the spaced field name", () => {
        assert.deepEqual(parseInfo('{"version":"1.0.22","model":"mc3s","serial no":"A2E987"}'), {
            version: "1.0.22",
            model: "mc3s",
            serialNumber: "A2E987",
            imuCount: undefined,
        });
    });

    it("parses HX2 info with imu_num", () => {
        assert.deepEqual(parseInfo('{"version":"0.0.1","model":"mc3s","imu_num":1,"serial no":"A00000"}'), {
            version: "0.0.1",
            model: "mc3s",
            serialNumber: "A00000",
            imuCount: 1,
        });
    });

    it("returns undefined for malformed info", () => {
        assert.equal(parseInfo("not json"), undefined);
        assert.equal(parseInfo('{"version":"1.0.0"}'), undefined);
    });

    it("maps firmware models case-insensitively", () => {
        assert.equal(modelFromFirmware("MC1"), "wired");
        assert.equal(modelFromFirmware("mc2"), "wired");
        assert.equal(modelFromFirmware("MC2"), "wired");
        assert.equal(modelFromFirmware("MC2B"), "wired");
        assert.equal(modelFromFirmware("mc3s"), "wireless");
        assert.equal(modelFromFirmware("MC4B"), "x2");
        assert.throws(() => modelFromFirmware("nope"), /Unknown firmware model/);
    });

    it("parses battery and normalises the charge status", () => {
        assert.deepEqual(parseBattery('{"battery voltage":4105,"battery remaining":94,"charge status":"Discharging"}'), {
            level: 94,
            voltage: 4105,
            chargeStatus: "discharging",
        });
    });

    it("decodes the settings bitstring", () => {
        // 100 FPS, sensor mode 1, accel correction only, ankle off
        assert.deepEqual(decodeSettings("00000110101000"), {
            sensorMode: 1,
            fpsMode: 100,
            sensorAutoCorrection: ["accel"],
            ankleMotionDetection: false,
        });
    });

    it("decodes 50 FPS, sensor mode 2 and every correction bit", () => {
        assert.deepEqual(decodeSettings("00000000107001"), {
            sensorMode: 2,
            fpsMode: 50,
            sensorAutoCorrection: ["accel", "gyro", "mag"],
            ankleMotionDetection: true,
        });
    });

    it("rejects a short settings string", () => {
        assert.equal(decodeSettings("0000"), undefined);
    });
});
