import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { fromByteArray as encodeBase64, toByteArray as decodeBase64 } from "base64-js";
import { createHaritoraX } from "../dist/index.js";
import type { Frame, ListOptions } from "../dist/connections/contract.js";
import type { DisconnectReason, Unsubscribe } from "../dist/types.js";
import {
    bodyPartOfTracker,
    bodyPartsFor,
    isDongleSlot,
    pairCommands,
    parseChannel,
    parsePairingResult,
    parseTrackerId,
    setChannelCommand,
    splitDongleImu,
    unpairCommands,
} from "../dist/protocol/dongle.js";

/** In-memory connection that also records everything written to it. */
function memoryConnection(endpointId = "COM4") {
    const dataHandlers = new Set<(frame: Frame) => void>();
    const lostHandlers = new Set<(endpointId: string, reason: DisconnectReason) => void>();
    const opened = new Set<string>();
    const writes: string[] = [];

    const connection = {
        kind: "serial" as const,
        opened,
        writes,

        list(_options?: ListOptions): Promise<Array<{ id: string; connection: "serial"; displayName: string }>> {
            return Promise.resolve([{ id: endpointId, connection: "serial" as const, displayName: endpointId }]);
        },

        open(id: string): Promise<void> {
            opened.add(id);
            return Promise.resolve();
        },

        close(id: string): Promise<void> {
            opened.delete(id);
            return Promise.resolve();
        },

        write(id: string, data: Uint8Array): Promise<void> {
            writes.push(`${id}:${asciiText(data)}`);
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
            for (const handler of dataHandlers) handler({ endpointId, data });
        },

        emitLost(reason: DisconnectReason): void {
            for (const handler of lostHandlers) handler(endpointId, reason);
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

async function connected() {
    const serial = memoryConnection();
    const app = createHaritoraX({ connections: [serial], logLevel: "silent" });

    await app.discover();
    await app.connect("COM4");

    return { app, serial };
}

const INFO = 'i0:{"version":"1.0.22","model":"mc3s","imu_num":1,"serial no":"A2E987"}';
const INFO_DUAL = 'i0:{"version":"1.0.5","model":"mc4b","imu_num":2,"serial no":"C1MGN3"}';

describe("dongle protocol", () => {
    it("reads the RF channel from o:", () => {
        // Real line from testing/HaritoraX Wireless.txt
        assert.equal(parseChannel("3040"), 4);
        assert.equal(parseChannel("30a0"), 10);
        assert.equal(parseChannel("30"), undefined);
        assert.equal(parseChannel("30f0"), undefined);
    });

    it("recognises a completed pairing", () => {
        assert.equal(parsePairingResult("330"), true);
        assert.equal(parsePairingResult("310"), true);
        assert.equal(parsePairingResult("110"), false);
    });

    it("reads the tracker id from a slot reply", () => {
        // Real lines from testing/HaritoraX Wireless.txt
        assert.equal(parseTrackerId("110070200000"), "7");
        assert.equal(parseTrackerId("110080200100"), "8");
        assert.equal(parseTrackerId("110000200000"), undefined);
    });

    it("splits a dongle IMU payload into one or two slices", () => {
        const single = "QAV1/Is6EBngAaf/bAkCAA==";
        assert.deepEqual(splitDongleImu(single, 1), [{ payload: single, role: "ankle", index: 0 }]);

        const leg = decodeBase64(single);
        const combo = new Uint8Array(30);
        combo.set(leg.slice(0, 14), 0);
        combo[14] = 3;
        combo[15] = 1;
        combo.set(leg.slice(0, 14), 16);
        const payload = encodeBase64(combo);

        // a 30-byte payload on a 1-tracker device stays whole (v3 behaviour)
        assert.deepEqual(splitDongleImu(payload, 1), [{ payload, role: "ankle", index: 0 }]);

        const slices = splitDongleImu(payload, 2);
        assert.equal(slices.length, 2);
        assert.deepEqual(
            slices.map((slice) => slice.role),
            ["ankle", "knee"],
        );
        assert.deepEqual(
            slices.map((slice) => slice.index),
            [0, 1],
        );
        assert.deepEqual(
            slices.map((slice) => slice.magByte),
            [3, 1],
        );

        const [first] = slices;
        assert.ok(first);
        assert.equal(decodeBase64(first.payload).length, 14);
    });

    it("maps tracker ids to body parts", () => {
        assert.equal(bodyPartOfTracker("1"), "chest");
        assert.equal(bodyPartOfTracker("3"), "leftAnkle");
        assert.equal(bodyPartOfTracker("8"), "rightElbow");
        assert.equal(bodyPartOfTracker("9"), "leftWrist");
        assert.equal(bodyPartOfTracker("a"), "rightWrist");
        assert.equal(bodyPartOfTracker("b"), "head");
        assert.equal(bodyPartOfTracker("c"), "leftFoot");
        assert.equal(bodyPartOfTracker("d"), "rightFoot");
        assert.equal(bodyPartOfTracker("e"), undefined);
    });

    it("derives ankle + knee for dual-IMU devices", () => {
        assert.deepEqual(bodyPartsFor("leftAnkle", 2), ["leftAnkle", "leftKnee"]);
        assert.deepEqual(bodyPartsFor("rightAnkle", 2), ["rightAnkle", "rightKnee"]);
        assert.deepEqual(bodyPartsFor("chest", 1), ["chest"]);
        assert.deepEqual(bodyPartsFor("hip", 2), ["hip", "unassigned"]);
    });

    it("builds the v3 channel and pairing commands", () => {
        assert.equal(isDongleSlot("0"), true);
        assert.equal(isDongleSlot("2"), false);

        assert.equal(setChannelCommand(4), "o:3040");
        assert.equal(setChannelCommand(10), "o:30a0");

        assert.deepEqual(pairCommands(4, "0"), ["o:1140", "o:1040", "o:3040"]);
        assert.deepEqual(pairCommands(4, "1"), ["o:2240", "o:2040", "o:3040"]);

        assert.deepEqual(unpairCommands(4, "0"), ["o:3041", "o:3040"]);
        assert.deepEqual(unpairCommands(10, "1"), ["o:30a2", "o:30a0"]);
    });
});

describe("dongle channel", () => {
    it("exposes the channel from an o: reply", async () => {
        const { app, serial } = await connected();

        const channels: Array<{ endpointId: string; channel: number }> = [];
        app.on("channel", (event) => channels.push(event));

        serial.emitFrame("o:3040");

        assert.equal(app.getChannel("COM4"), 4);
        assert.equal(app.getEndpoints()[0]?.channel, 4);
        assert.deepEqual(channels, [{ endpointId: "COM4", channel: 4 }]);
    });

    it("writes a channel change", async () => {
        const { app, serial } = await connected();

        await app.setChannel("COM4", 10);

        assert.deepEqual(serial.writes, ["COM4:o:30a0"]);
        assert.equal(app.getChannel("COM4"), 10);
    });

    it("rejects an invalid channel", async () => {
        const { app } = await connected();

        const error = await app.setChannel("COM4", 11).catch((err: unknown) => err);

        assert.equal((error as { code?: string }).code, "NOT_SUPPORTED");
    });
});

describe("tracker identity", () => {
    it("assigns the body part from r0:", async () => {
        const { app, serial } = await connected();

        const identified: Array<{ deviceId: string; trackerId: string; bodyPart: string }> = [];
        app.on("identified", (event) => identified.push(event));

        serial.emitFrame(INFO);
        serial.emitFrame("r0:110070200000");

        assert.equal(app.getDevice("A2E987")?.trackers[0]?.bodyPart, "leftElbow");
        assert.equal(app.getBodyPart("A2E987:0"), "leftElbow");
        assert.deepEqual(identified, [{ trackerId: "A2E987:0", deviceId: "A2E987", bodyPart: "leftElbow" }]);
    });

    it("keeps an identity that arrived before info", async () => {
        const { app, serial } = await connected();

        // Identity alone does not create a device.
        serial.emitFrame("r0:110030200000");
        assert.deepEqual(app.getDevices(), []);

        serial.emitFrame(INFO);
        assert.equal(app.getBodyPart("A2E987:0"), "leftAnkle");
        assert.equal(app.getDevice("A2E987")?.trackers[0]?.trackerId, "A2E987:0");
    });

    it("assigns both slots on one endpoint independently", async () => {
        const { app, serial } = await connected();

        serial.emitFrame('i0:{"version":"1.0.22","model":"mc3s","serial no":"A2E987"}');
        serial.emitFrame('i1:{"version":"1.0.22","model":"mc3s","serial no":"A2KUN8"}');
        serial.emitFrame("r0:110070200000");
        serial.emitFrame("r1:110080200100");

        assert.equal(app.getBodyPart("A2E987:0"), "leftElbow");
        assert.equal(app.getBodyPart("A2KUN8:0"), "rightElbow");
        assert.deepEqual(
            app
                .getDevices()
                .map((device) => device.deviceId)
                .sort(),
            ["A2E987", "A2KUN8"],
        );
    });

    it("expands a dual-IMU ankle into ankle + knee samples", async () => {
        const { app, serial } = await connected();

        serial.emitFrame(INFO_DUAL);
        serial.emitFrame("r0:110030200000");

        assert.equal(app.getBodyPart("C1MGN3:0"), "leftAnkle");
        assert.equal(app.getBodyPart("C1MGN3:1"), "leftKnee");

        const leg = decodeBase64("QAV1/Is6EBngAaf/bAkCAA==");
        const combo = new Uint8Array(30);
        combo.set(leg.slice(0, 14), 0);
        combo[14] = 3;
        combo[15] = 1;
        combo.set(leg.slice(0, 14), 16);

        const samples: Array<{ trackerId: string; bodyPart: string; role: string }> = [];
        app.on("imu", (sample) => samples.push(sample));

        serial.emitFrame(`x0:${encodeBase64(combo)}`);

        assert.deepEqual(
            samples.map((sample) => sample.bodyPart),
            ["leftAnkle", "leftKnee"],
        );
        assert.deepEqual(
            samples.map((sample) => sample.trackerId),
            ["C1MGN3:0", "C1MGN3:1"],
        );
        assert.deepEqual(
            samples.map((sample) => sample.role),
            ["ankle", "knee"],
        );
    });
});

describe("tracker lifecycle", () => {
    it("times out a tracker after 10 s without data", async () => {
        const { app, serial } = await connected();

        mock.timers.enable({ apis: ["setTimeout", "Date"] });
        try {
            serial.emitFrame(INFO);

            const disconnected: Array<{ trackerId: string; deviceId: string; reason: string }> = [];
            app.on("tracker:disconnected", (event) => disconnected.push(event));

            mock.timers.tick(10_000);

            assert.deepEqual(disconnected, [{ trackerId: "A2E987:0", deviceId: "A2E987", reason: "timeout" }]);
            assert.equal(app.getTracker("A2E987:0")?.connected, false);
            assert.equal(app.getDevices().length, 1);
        } finally {
            mock.timers.reset();
        }
    });

    it("reconnects a timed-out tracker on the next sample", async () => {
        const { app, serial } = await connected();

        mock.timers.enable({ apis: ["setTimeout", "Date"] });
        try {
            serial.emitFrame(INFO);
            mock.timers.tick(10_000);

            const connectedAgain: string[] = [];
            app.on("tracker:connected", ({ trackerId }) => connectedAgain.push(trackerId));

            serial.emitFrame("x0:QAV1/Is6EBngAaf/bAkCAA==");

            assert.deepEqual(connectedAgain, ["A2E987:0"]);
            assert.equal(app.getTracker("A2E987:0")?.connected, true);
        } finally {
            mock.timers.reset();
        }
    });

    it("emits tracker, device and endpoint disconnects in order", async () => {
        const { app, serial } = await connected();
        serial.emitFrame(INFO);

        const events: string[] = [];
        app.on("tracker:disconnected", () => events.push("tracker"));
        app.on("device:disconnected", () => events.push("device"));
        app.on("endpoint:disconnected", () => events.push("endpoint"));

        await app.disconnect("COM4");

        assert.deepEqual(events, ["tracker", "device", "endpoint"]);
        assert.equal(app.getTracker("A2E987:0"), undefined);
    });
});

describe("pairing", () => {
    it("pairs a slot and observes the completion", async () => {
        const { app, serial } = await connected();
        serial.emitFrame("o:3040");

        const paired: Array<{ endpointId: string; slot: string }> = [];
        app.on("paired", (event) => paired.push(event));

        const pending = app.pair("COM4", 0);
        serial.emitFrame("r:330");
        await pending;

        assert.deepEqual(serial.writes, ["COM4:o:1140", "COM4:o:1040", "COM4:o:3040", "COM4:o:3040", "COM4:r0:"]);
        assert.deepEqual(paired, [{ endpointId: "COM4", slot: "0" }]);
    });

    it("refuses to pair without a known channel", async () => {
        const { app } = await connected();

        const error = await app.pair("COM4", 0).catch((err: unknown) => err);

        assert.equal((error as { code?: string }).code, "NOT_CONNECTED");
    });

    it("unpairs and clears the body part", async () => {
        const { app, serial } = await connected();
        serial.emitFrame(INFO);
        serial.emitFrame("r0:110070200000");
        serial.emitFrame("o:3040");

        const unpaired: Array<{ endpointId: string; slot: string }> = [];
        app.on("unpaired", (event) => unpaired.push(event));

        await app.unpair("COM4", 0);

        assert.deepEqual(serial.writes, ["COM4:o:3041", "COM4:o:3040"]);
        assert.equal(app.getBodyPart("A2E987:0"), "unassigned");
        assert.deepEqual(unpaired, [{ endpointId: "COM4", slot: "0" }]);
    });
});
