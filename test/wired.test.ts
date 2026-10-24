import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fromByteArray as encodeBase64, toByteArray as decodeBase64 } from "base64-js";
import { createHaritoraX } from "../dist/index.js";
import type { Frame, ListOptions } from "../dist/connections/contract.js";
import { parseWiredButton, splitWiredImu, wiredSettingsCommands } from "../dist/protocol/endpoint/wired.js";
import type { DisconnectReason, EndpointDescriptor, TrackerSettings, Unsubscribe } from "../dist/types.js";

const ENDPOINT = "/dev/rfcomm0";
const INFO = 'i:{"model":"MC2","version":"1.7.8","serial no":"0108013","comm":"BLT","comm_next":"BTSPP"}';
const INFO_MC2B = 'i:{"model":"MC2B","version":"1.7.10","serial no":"0108014","comm":"BLT","comm_next":"BTSPP"}';
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

function imuPayload(count: number, ankle?: [number, number]): string {
    const leg = decodeBase64(LEG).slice(0, 14);
    const bytes = new Uint8Array(count * 14 + (ankle ? 4 : 0));

    for (let index = 0; index < count; index++) bytes.set(leg, index * 14);
    if (ankle) {
        bytes[count * 14] = ankle[0] & 0xff;
        bytes[count * 14 + 2] = ankle[1] & 0xff;
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

        const device = app.getDevice("0108013");
        assert.ok(device);
        assert.equal(device.model, "wired");
        assert.equal(device.slot, "0");
        assert.equal(device.imuCount, 6);
        assert.deepEqual(
            device.trackers.map((tracker) => tracker.trackerId),
            ["0108013:0", "0108013:1", "0108013:2", "0108013:3", "0108013:4", "0108013:5"],
        );
        assert.deepEqual(
            device.trackers.map((tracker) => tracker.bodyPart),
            ["chest", "leftKnee", "leftAnkle", "rightKnee", "rightAnkle", "hip"],
        );
        assert.deepEqual(connectedEvents, ["0108013:wired:0:6"]);
        assert.equal(app.getBodyPart("0108013:2"), "leftAnkle");
        assert.deepEqual(
            device.trackers.map((tracker) => tracker.mag),
            ["veryBad", "bad", "okay", "great", "veryBad", "bad"],
        );
    });

    it("waits for s: before creating the device", async () => {
        const { app, serial } = await connected();

        serial.emitFrame(INFO);
        assert.equal(app.getDevice("0108013"), undefined);

        serial.emitFrame(STATE_5);

        const device = app.getDevice("0108013");
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

        assert.equal(app.getDevice("0108014")?.model, "wired");
    });

    it("ignores an unsupported imu_num", async () => {
        const { app, serial } = await connected();

        serial.emitFrame('s:{"imu_mode":1,"imu_num":4,"magf_status":"0000"}');
        serial.emitFrame(INFO);

        assert.equal(app.getDevice("0108013"), undefined);
    });

    it("emits single-role IMU samples for every tracker", async () => {
        const { app, serial } = await connected();

        serial.emitFrame(STATE_5);
        serial.emitFrame(INFO);

        const samples: Array<{ trackerId: string; bodyPart: string; role: string }> = [];
        app.on("imu", (sample) => samples.push(sample));

        serial.emitFrame(`x:${imuPayload(5)}`);

        assert.deepEqual(
            samples.map((sample) => sample.trackerId),
            ["0108013:0", "0108013:1", "0108013:2", "0108013:3", "0108013:4"],
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

        const device = app.getDevice("0108013");
        assert.ok(device);
        assert.equal(device.imuCount, 8);
        assert.deepEqual(
            device.trackers.map((tracker) => tracker.bodyPart),
            ["chest", "leftKnee", "leftAnkle", "rightKnee", "rightAnkle", "hip", "leftElbow", "rightElbow"],
        );

        const samples: string[] = [];
        app.on("imu", (sample) => samples.push(sample.trackerId));

        serial.emitFrame(`h:${imuPayload(8, [10, -20])}`);

        assert.equal(samples.length, 8);
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

        assert.equal(app.getDevice("0108013")?.battery?.level, 74);
        assert.deepEqual(
            batteries.map((battery) => [battery.deviceId, battery.level]),
            [["0108013", 74]],
        );
        assert.deepEqual(buttons, [{ deviceId: "0108013", button: "sub" }]);
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

        await app.setSettings("0108013", settings);

        assert.deepEqual(serial.writes, [
            `${ENDPOINT}:sensor imu mode 1\r\n`,
            `${ENDPOINT}:system speed mode 2\r\n`,
            `${ENDPOINT}:sensor cal flags 3\r\nsensor restart\r\n`,
            `${ENDPOINT}:param sensor range\r\nparam save\r\nsensor restart\r\n`,
        ]);
        assert.deepEqual(app.getDevice("0108013")?.settings, settings);
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
    it("reads left and right ankle values from the trailing buffer", () => {
        const slices = splitWiredImu(imuPayload(6, [10, -20]), 6, true);

        assert.equal(slices.length, 6);
        assert.equal(slices[2]?.ankleAngle, 10);
        assert.equal(slices[4]?.ankleAngle, -20);
        assert.equal(slices[0]?.ankleAngle, undefined);
        assert.equal(slices[5]?.ankleAngle, undefined);
    });

    it("ignores a payload shorter than the tracker count", () => {
        assert.deepEqual(splitWiredImu(encodeBase64(new Uint8Array(14)), 2, false), []);
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
                "sensor imu mode 1\r\n",
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
                "sensor imu mode 2\r\n",
                "system speed mode 1\r\n",
                "sensor cal flags 0\r\nsensor restart\r\n",
                "param sensor basic\r\nparam save\r\nsensor restart\r\n",
            ],
        );
    });
});
