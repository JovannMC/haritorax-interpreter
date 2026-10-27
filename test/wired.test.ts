import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fromByteArray as encodeBase64, toByteArray as decodeBase64 } from "base64-js";
import { createHaritoraX } from "../dist/index.js";
import type { Frame, ListOptions } from "../dist/connections/contract.js";
import { parseWiredButton, splitWiredImu, wiredPartsFor, wiredSettingsCommands } from "../dist/protocol/endpoint/wired.js";
import type { DisconnectReason, EndpointDescriptor, TrackerSettings, Unsubscribe } from "../dist/types.js";

const ENDPOINT = "/dev/rfcomm0";
const INFO = 'i:{"model":"MC2","version":"1.7.8","serial no":"0000003","comm":"BLT","comm_next":"BTSPP"}';
const INFO_MC2B = 'i:{"model":"MC2B","version":"1.7.10","serial no":"0000004","comm":"BLT","comm_next":"BTSPP"}';
const STATE_5 = 's:{"imu_mode":1,"imu_num":5,"magf_status":"01230","speed_mode":2,"dcal_flags":"04","detected":"04004C4C"}';
const STATE_6 = 's:{"imu_mode":1,"imu_num":6,"magf_status":"012301","speed_mode":2,"dcal_flags":"04","detected":"04004C6C"}';
const STATE_8 = 's:{"imu_mode":1,"imu_num":8,"magf_status":"01230123","speed_mode":2,"dcal_flags":"04","detected":"04004C6C"}';
const LEG = "QAV1/Is6EBngAaf/bAkCAA==";

function memoryConnection() {
    const dataHandlers = new Set<(frame: Frame) => void>();
    const lostHandlers = new Set<(endpointId: string, reason: DisconnectReason) => void>();
    const opened = new Set<string>();
    const writes: string[] = [];

    const connection = {
        kind: "serial" as const,
        opened,
        writes,

        list(_options?: ListOptions): Promise<EndpointDescriptor[]> {
            return Promise.resolve([
                { id: ENDPOINT, connection: "serial" as const, displayName: "HaritoraX Wired", model: "wired" as const },
            ]);
        },

        open(endpointId: string): Promise<void> {
            opened.add(endpointId);
            return Promise.resolve();
        },

        close(endpointId: string): Promise<void> {
            opened.delete(endpointId);
            return Promise.resolve();
        },

        write(endpointId: string, data: Uint8Array): Promise<void> {
            writes.push(`${endpointId}:${asciiText(data)}`);
            return Promise.resolve();
        },

        onData(handler: (frame: Frame) => void): Unsubscribe {
            dataHandlers.add(handler);
            return () => dataHandlers.delete(handler);
        },

        onLost(handler: (endpointId: string, reason: DisconnectReason) => void): Unsubscribe {
            lostHandlers.add(handler);
            return () => lostHandlers.delete(handler);
        },

        dispose(): Promise<void> {
            dataHandlers.clear();
            lostHandlers.clear();
            opened.clear();
            return Promise.resolve();
        },

        emitFrame(text: string): void {
            const data = asciiEncode(text);
            for (const handler of dataHandlers) handler({ endpointId: ENDPOINT, data });
        },
    };

    return connection;
}

function asciiEncode(text: string): Uint8Array {
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
    return bytes;
}

function asciiText(bytes: Uint8Array): string {
    let text = "";
    for (const byte of bytes) text += String.fromCharCode(byte);
    return text;
}

// range values are the raw 16-bit values the tracker sends for the left and right ankle
// seven float32 per IMU: quaternion i, j, k, real, then acceleration x, y, z, all for an identity-ish pose
function floatPayload(count: number): string {
    const bytes = new Uint8Array(count * 28);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < count; i++) {
        [0, 0, 0, 1, 0, 0, 1].forEach((value, j) => view.setFloat32(i * 28 + j * 4, value, true));
    }

    return encodeBase64(bytes);
}

function imuPayload(count: number, range?: [number, number]): string {
    const leg = decodeBase64(LEG).slice(0, 14);
    const bytes = new Uint8Array(count * 14 + (range ? 4 : 0));

    for (let index = 0; index < count; index++) bytes.set(leg, index * 14);
    if (range) {
        new DataView(bytes.buffer).setUint16(count * 14, range[0], true);
        new DataView(bytes.buffer).setUint16(count * 14 + 2, range[1], true);
    }

    return encodeBase64(bytes);
}

async function connected() {
    const serial = memoryConnection();
    const app = createHaritoraX({ connections: [serial], logLevel: "silent" });

    await app.discover();
    await app.connect(ENDPOINT);

    return { app, serial };
}

describe("wired device", () => {
    it("creates a device from a pending s: layout and info", async () => {
        const { app, serial } = await connected();

        const connectedEvents: string[] = [];
        app.on("device:connected", (event) =>
            connectedEvents.push(`${event.deviceId}:${event.model}:${event.slot}:${event.imuCount}`),
        );

        serial.emitFrame(STATE_6);
        serial.emitFrame(INFO);

        const device = app.getDevice("0000003");
        assert.ok(device);
        assert.equal(device.model, "wired");
        assert.equal(device.slot, "0");
        assert.equal(device.imuCount, 6);
        assert.deepEqual(
            device.trackers.map((tracker) => tracker.trackerId),
            ["0000003:0", "0000003:1", "0000003:2", "0000003:3", "0000003:4", "0000003:5"],
        );
        assert.deepEqual(
            device.trackers.map((tracker) => tracker.bodyPart),
            ["chest", "leftKnee", "leftAnkle", "rightKnee", "rightAnkle", "hip"],
        );
        assert.deepEqual(connectedEvents, ["0000003:wired:0:6"]);
        assert.equal(app.getBodyPart("0000003:2"), "leftAnkle");
        assert.deepEqual(
            device.trackers.map((tracker) => tracker.mag),
            ["veryBad", "bad", "okay", "great", "veryBad", "bad"],
        );
    });

    it("waits for s: before creating the device", async () => {
        const { app, serial } = await connected();

        serial.emitFrame(INFO);
        assert.equal(app.getDevice("0000003"), undefined);

        serial.emitFrame(STATE_5);

        const device = app.getDevice("0000003");
        assert.ok(device);
        assert.equal(device.imuCount, 5);
        assert.deepEqual(
            device.trackers.map((tracker) => tracker.bodyPart),
            ["chest", "leftKnee", "leftAnkle", "rightKnee", "rightAnkle"],
        );
    });

    it("maps MC2B to the wired model", async () => {
        const { app, serial } = await connected();

        serial.emitFrame(STATE_5);
        serial.emitFrame(INFO_MC2B);

        assert.equal(app.getDevice("0000004")?.model, "wired");
    });

    it("accepts a tracker count outside the known layouts", async () => {
        const { app, serial } = await connected();

        serial.emitFrame('s:{"imu_mode":1,"imu_num":4,"magf_status":"0000"}');
        serial.emitFrame(INFO);

        assert.equal(app.getDevice("0000003")?.imuCount, 4);
        assert.equal(app.getDevice("0000003")?.trackers.length, 4);
    });

    it("ignores a state with no trackers", async () => {
        const { app, serial } = await connected();

        serial.emitFrame('s:{"imu_mode":1,"imu_num":0,"magf_status":""}');
        serial.emitFrame(INFO);

        assert.equal(app.getDevice("0000003"), undefined);
    });

    it("emits single-role IMU samples for every tracker", async () => {
        const { app, serial } = await connected();

        serial.emitFrame(STATE_5);
        serial.emitFrame(INFO);

        const samples: Array<{ trackerId: string; bodyPart: string; role: string }> = [];
        app.on("imu", (sample) => samples.push(sample));

        serial.emitFrame(`X:${imuPayload(5)}`);

        assert.deepEqual(
            samples.map((sample) => sample.trackerId),
            ["0000003:0", "0000003:1", "0000003:2", "0000003:3", "0000003:4"],
        );
        assert.deepEqual(
            samples.map((sample) => sample.bodyPart),
            ["chest", "leftKnee", "leftAnkle", "rightKnee", "rightAnkle"],
        );
        assert.ok(samples.every((sample) => sample.role === "single"));
    });

    it("handles the 8-tracker h layout with ankle data", async () => {
        const { app, serial } = await connected();

        serial.emitFrame(STATE_8);
        serial.emitFrame(INFO);

        const device = app.getDevice("0000003");
        assert.ok(device);
        assert.equal(device.imuCount, 8);
        assert.deepEqual(
            device.trackers.map((tracker) => tracker.bodyPart),
            ["chest", "leftKnee", "leftAnkle", "rightKnee", "rightAnkle", "leftElbow", "rightElbow", "hip"],
        );

        const samples: string[] = [];
        app.on("imu", (sample) => samples.push(sample.trackerId));

        serial.emitFrame(`H:${imuPayload(8, [700, 1200])}`);

        assert.equal(samples.length, 8);
    });

    it("reads the range in millimetres from every frame letter that carries it", async () => {
        const { app, serial } = await connected();
        serial.emitFrame(STATE_5);
        serial.emitFrame(INFO);

        const ranges: Array<[string, number | undefined]> = [];
        app.on("imu", (sample) => ranges.push([sample.bodyPart, sample.range]));

        // 5 IMUs with range is still an "X" frame, only the length tells them apart
        serial.emitFrame(`X:${imuPayload(5, [700, 1200])}`);
        assert.deepEqual(
            ranges.filter(([, range]) => range !== undefined),
            [
                ["leftAnkle", 700],
                ["rightAnkle", 1200],
            ],
        );

        // an error code (negative value) is no reading, and so is a frame without range
        ranges.length = 0;
        serial.emitFrame(`X:${imuPayload(5, [0xff0b, 0xffff])}`);
        serial.emitFrame(`X:${imuPayload(5)}`);
        assert.ok(ranges.every(([, range]) => range === undefined));
        assert.equal(ranges.length, 10);
    });

    it("reads the 7-tracker frame with range", async () => {
        const { app, serial } = await connected();
        serial.emitFrame(
            's:{"imu_mode":1,"imu_num":7,"magf_status":"0123012","speed_mode":2,"dcal_flags":"04","detected":"04004C6C"}',
        );
        serial.emitFrame(INFO);

        const samples: Array<number | undefined> = [];
        app.on("imu", (sample) => samples.push(sample.range));

        serial.emitFrame(`F:${imuPayload(7, [300, 400])}`);

        assert.equal(samples.length, 7);
        assert.deepEqual(
            samples.filter((range) => range !== undefined),
            [300, 400],
        );
    });

    it("emits battery and device-scoped button events", async () => {
        const { app, serial } = await connected();

        serial.emitFrame(STATE_5);
        serial.emitFrame(INFO);

        const batteries: Array<{ deviceId: string; level: number | null }> = [];
        const buttons: Array<{ deviceId: string; button: string }> = [];
        app.on("battery", (battery) => batteries.push(battery));
        app.on("button", (button) => buttons.push(button));

        serial.emitFrame('v:{"battery voltage":3917,"battery remaining":74,"charge status":"Discharging"}');
        serial.emitFrame('t:{"id":"button2","type":"click","start_time":6937744,"option":""}');

        assert.equal(app.getDevice("0000003")?.battery?.level, 74);
        assert.deepEqual(
            batteries.map((battery) => [battery.deviceId, battery.level]),
            [["0000003", 74]],
        );
        assert.deepEqual(buttons, [{ deviceId: "0000003", button: "sub" }]);
    });

    it("writes wired settings to every open wired endpoint", async () => {
        const { app, serial } = await connected();
        serial.emitFrame(STATE_5);
        serial.emitFrame(INFO);

        const settings: TrackerSettings = {
            sensorMode: 1,
            fpsMode: 100,
            sensorAutoCorrection: ["accel", "gyro"],
            ankleMotionDetection: true,
        };
        const events: TrackerSettings[] = [];
        app.on("settings", (event) => events.push(event.settings));

        await app.setSettings("0000003", settings);

        // sensor mode 1 is the one that uses the magnetometer, which is imu mode 2 on a wired tracker
        assert.deepEqual(serial.writes, [
            `${ENDPOINT}:sensor imu mode 2\r\n`,
            `${ENDPOINT}:system speed mode 2\r\n`,
            `${ENDPOINT}:sensor cal flags 3\r\nsensor restart\r\n`,
            `${ENDPOINT}:param sensor range\r\nparam save\r\nsensor restart\r\n`,
        ]);
        assert.deepEqual(app.getDevice("0000003")?.settings, settings);
        assert.deepEqual(events, [settings]);
    });

    it("rejects settings for an unknown device", async () => {
        const { app } = await connected();

        const error = await app
            .setSettings("missing", {
                sensorMode: 1,
                fpsMode: 100,
                sensorAutoCorrection: [],
                ankleMotionDetection: false,
            })
            .catch((err: unknown) => err);

        assert.equal((error as { code?: string }).code, "DEVICE_NOT_FOUND");
    });
});

describe("wired protocol", () => {
    it("orders the parts by slot, with the hip last on 8 trackers and absent on 7", () => {
        assert.equal(wiredPartsFor(6).at(-1), "hip");
        assert.deepEqual(wiredPartsFor(7).slice(5), ["leftElbow", "rightElbow"]);
        assert.ok(!wiredPartsFor(7).includes("hip"));
        assert.deepEqual(wiredPartsFor(8).slice(5), ["leftElbow", "rightElbow", "hip"]);
    });

    it("decodes the lower case x float frames for every tracker", async () => {
        const { app, serial } = await connected();
        serial.emitFrame(STATE_5);
        serial.emitFrame(INFO);

        const samples: string[] = [];
        app.on("imu", (sample) => samples.push(sample.trackerId));

        serial.emitFrame(`x:${floatPayload(5)}`);
        assert.equal(samples.length, 5);
    });

    it("reads the tracker's own imu mode, speed and calibration from s:", async () => {
        const { app, serial } = await connected();
        serial.emitFrame(STATE_5);
        serial.emitFrame(INFO);

        serial.emitFrame(
            's:{"imu_mode":2,"imu_num":5,"magf_status":"33333","speed_mode":1,"dcal_flags":"5","detected":"04004C4C"}',
        );
        assert.deepEqual(app.getDevice("0000003")?.settings, {
            sensorMode: 1,
            fpsMode: 50,
            sensorAutoCorrection: ["accel", "mag"],
            ankleMotionDetection: false,
        });
    });

    it("reports the link the wired tracker uses and the one it switches to", async () => {
        const { app, serial } = await connected();
        serial.emitFrame(STATE_5);
        serial.emitFrame(INFO);

        assert.equal(app.getDevice("0000003")?.comm, "BLT");
        assert.equal(app.getDevice("0000003")?.commNext, "BTSPP");
    });

    it("reads left and right ankle range values from the trailing buffer", () => {
        const slices = splitWiredImu(imuPayload(6, [700, 1200]), 6);

        assert.equal(slices.length, 6);
        assert.equal(slices[2]?.range, 700);
        assert.equal(slices[4]?.range, 1200);
        assert.equal(slices[0]?.range, undefined);
        assert.equal(slices[5]?.range, undefined);

        // the range is detected from the length, whatever the frame letter was
        assert.equal(splitWiredImu(imuPayload(6), 6)[2]?.range, undefined);
        assert.equal(splitWiredImu(imuPayload(5, [700, 1200]), 5)[2]?.range, 700);
    });

    it("ignores a payload shorter than the tracker count", () => {
        assert.deepEqual(splitWiredImu(encodeBase64(new Uint8Array(14)), 2), []);
    });

    it("maps button ids", () => {
        assert.equal(parseWiredButton('{"id":"button1","type":"click"}'), "main");
        assert.equal(parseWiredButton('{"id":"button2","type":"click"}'), "sub");
        assert.equal(parseWiredButton('{"id":"button3","type":"click"}'), "sub2");
        assert.equal(parseWiredButton('{"id":"other"}'), undefined);
    });

    it("builds the v3 wired settings commands", () => {
        assert.deepEqual(
            wiredSettingsCommands({
                sensorMode: 1,
                fpsMode: 100,
                sensorAutoCorrection: ["accel", "gyro", "mag"],
                ankleMotionDetection: true,
            }),
            [
                "sensor imu mode 2\r\n",
                "system speed mode 2\r\n",
                "sensor cal flags 7\r\nsensor restart\r\n",
                "param sensor range\r\nparam save\r\nsensor restart\r\n",
            ],
        );

        assert.deepEqual(
            wiredSettingsCommands({
                sensorMode: 2,
                fpsMode: 50,
                sensorAutoCorrection: [],
                ankleMotionDetection: false,
            }),
            [
                "sensor imu mode 1\r\n",
                "system speed mode 1\r\n",
                "sensor cal flags 0\r\nsensor restart\r\n",
                "param sensor basic\r\nparam save\r\nsensor restart\r\n",
            ],
        );
    });
});
