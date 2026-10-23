import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { decodeImu, magStatusFromByte } from "../dist/protocol/imu.js";
import { fromByteArray as encodeBase64, toByteArray as decodeBase64 } from "base64-js";
import { decodeSettings, modelFromFirmware, parseBattery, parseInfo } from "../dist/protocol/messages.js";

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

describe("IMU decoding matches v3", () => {
    it("has fixtures generated from the v3 decoder", () => {
        assert.ok(fixtures.length >= 12);
    });

    for (const [index, fixture] of fixtures.entries()) {
        it(`decodes fixture ${index} (${fixture.model})`, () => {
            const decoded = decodeImu(fixture.payload, fixture.model);
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

    it("reads an ankle angle only when the payload lacks double padding", () => {
        const sixteen = decodeBase64("QAV1/Is6EBngAaf/bAkCAA==");
        assert.equal(sixteen.length, 16);
        assert.equal(decodeImu(encodeBase64(sixteen), "wireless")?.ankleAngle, undefined);

        // A 14-byte slice ends in a single "=", which v3 treated as "has ankle".
        const fourteen = sixteen.slice(0, 14);
        const decoded = decodeImu(encodeBase64(fourteen), "wireless");
        assert.equal(decoded?.ankleAngle, (fourteen[12]! | (fourteen[13]! << 8)) >>> 0);
    });

    it("uses a supplied magnetometer byte when a leg packet was split", () => {
        const payload = "QAV1/Is6EBngAaf/bAkCAA==";
        assert.equal(decodeImu(payload, "x2", 3)?.magStatus, "great");
        assert.equal(decodeImu(payload, "x2", 0)?.magStatus, "veryBad");
        assert.equal(decodeImu(payload, "x2", 9)?.magStatus, "unknown");
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
