import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { fromByteArray as encodeBase64, toByteArray as decodeBase64 } from "base64-js";
import { createHaritoraX } from "../dist/index.js";
import type { Frame, ListOptions } from "../dist/connections/contract.js";
import type { DisconnectReason, TrackerSettings, Unsubscribe } from "../dist/types.js";
import {
    bodyPartCommands,
    bodyPartOfTracker,
    bodyPartsFor,
    decodeTrackerRssi,
    dongleSettingsCommand,
    isDongleSlot,
    isRssiLost,
    isSlotPaired,
    pairCommands,
    parseChannel,
    parseDongleAccelAccuracy,
    parseDongleRegister,
    parseTrackerId,
    setChannelCommand,
    splitDongleImu,
    trackerIdOfBodyPart,
    unpairCommands,
} from "../dist/protocol/endpoint/dongle.js";

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

async function connected(buttonDebounceMs?: number) {
    const serial = memoryConnection();
    const app = createHaritoraX({ connections: [serial], logLevel: "silent", buttonDebounceMs });

    await app.discover();
    await app.connect("COM4");

    return { app, serial };
}

const INFO = 'i0:{"version":"1.0.22","model":"mc3s","imu_num":1,"serial no":"AAAAA7"}';
const INFO_DUAL = 'i0:{"version":"1.0.5","model":"mc4b","imu_num":2,"serial no":"CCCCC3"}';
const INFO_SLOT_1 = 'i1:{"version":"1.0.22","model":"mc3s","imu_num":1,"serial no":"EEEEE1"}';

describe("dongle protocol", () => {
    it("reads the RF channel from o:", () => {
        // Real line from testing/HaritoraX Wireless.txt
        assert.equal(parseChannel("3040"), 4);
        assert.equal(parseChannel("30a0"), 10);
        assert.equal(parseChannel("30"), undefined);
        assert.equal(parseChannel("30f0"), undefined);
    });

    it("reads the dongle register and which slots are paired", () => {
        // [mode][paired slots][unpaired slots]
        assert.deepEqual(parseDongleRegister("300"), { mode: 3, paired: 0, unpaired: 0 });
        assert.deepEqual(parseDongleRegister("110"), { mode: 1, paired: 1, unpaired: 0 });
        assert.equal(parseDongleRegister("30"), undefined);
        assert.equal(parseDongleRegister("3zz"), undefined);

        // sensing mode is not a pairing, only the slot's own bit is
        const sensing = parseDongleRegister("300");
        const slotZero = parseDongleRegister("110");
        const slotOne = parseDongleRegister("220");
        assert.ok(sensing && slotZero && slotOne);
        assert.equal(isSlotPaired(sensing, "0"), false);
        assert.equal(isSlotPaired(slotZero, "0"), true);
        assert.equal(isSlotPaired(slotZero, "1"), false);
        assert.equal(isSlotPaired(slotOne, "1"), true);
        assert.equal(isSlotPaired(slotOne, "0"), false);
    });

    it("reads accel accuracy from the 14 digit register of newer dongles", () => {
        assert.deepEqual(parseDongleAccelAccuracy("11003020000023"), [2, 3]);
        assert.deepEqual(parseDongleAccelAccuracy("11003020000000"), [0, 0]);
        assert.equal(parseDongleAccelAccuracy("110030200000"), undefined);
        assert.equal(parseDongleAccelAccuracy("11003020000090"), undefined);
    });

    it("reads the tracker id from a slot reply", () => {
        // Real lines from testing/HaritoraX Wireless.txt
        assert.equal(parseTrackerId("110070200000"), "7");
        assert.equal(parseTrackerId("110080200100"), "8");
        assert.equal(parseTrackerId("110000200000"), undefined);
    });

    it("recognises a lost-tracker a: frame", () => {
        assert.equal(isRssiLost("7f7f7f7f7f7f"), true);
        assert.equal(isRssiLost("7F7F7F7F7F7F"), true);
        assert.equal(isRssiLost("284128442f30"), false);
        assert.equal(isRssiLost(""), false);
    });

    it("decodes the a: frame from the averages, as dongle and sensor RSSI (negative dBm)", () => {
        // [dongle min][dongle max][sensor min][sensor max][dongle average][sensor average]
        // real lines from testing/HaritoraX Wireless.txt and from a dongle on 1.0.26
        assert.deepEqual(decodeTrackerRssi("284128442f30"), { dongle: -0x2f, sensor: -0x30 });
        assert.deepEqual(decodeTrackerRssi("374237423b3b"), { dongle: -0x3b, sensor: -0x3b });
        assert.deepEqual(decodeTrackerRssi("33392d3e3732"), { dongle: -55, sensor: -50 });
        assert.deepEqual(decodeTrackerRssi("2649254b2f2e"), { dongle: -47, sensor: -46 });
    });

    it("ignores RSSI averages that can't be real", () => {
        assert.equal(decodeTrackerRssi(""), undefined);
        assert.equal(decodeTrackerRssi("2842"), undefined); // too short to hold the averages
        assert.equal(decodeTrackerRssi("284128440030"), undefined); // the dongle average is zero
        assert.deepEqual(decodeTrackerRssi("284128442f00"), { dongle: -0x2f }); // only the sensor average is
        assert.equal(decodeTrackerRssi("2259224cd0c9"), undefined); // stale counters on the first frame after connecting

        // a side without samples stays 7f, the other side is still good
        assert.deepEqual(decodeTrackerRssi("28412844307f"), { dongle: -0x30 });
        assert.deepEqual(decodeTrackerRssi("2259225062ff"), { dongle: -98 });
    });

    it("splits a dongle IMU payload by its length", () => {
        const single = "QAV1/Is6EBngAaf/bAkCAA==";
        const leg = decodeBase64(single).slice(0, 14);
        const thigh = leg.map((byte) => byte ^ 0x55);

        // 16 bytes: [IMU0 14][status 2], the slice is the 14 bytes of IMU data
        const [only] = splitDongleImu(single, 1);
        assert.deepEqual(decodeBase64(only?.payload ?? ""), leg);
        assert.deepEqual({ ...only, payload: "" }, { payload: "", role: "ankle", index: 0, status: 0x0002 });

        // 18 bytes: [IMU0 14][status 2][range 2]
        const withRange = new Uint8Array(18);
        withRange.set(leg, 0);
        withRange.set([3, 1], 14);
        withRange.set([0xbc, 0x02], 16);
        const [ranged] = splitDongleImu(encodeBase64(withRange), 1);
        assert.equal(ranged?.range, 700);
        assert.equal(ranged?.status, 0x0103);

        // 30 bytes: [IMU0 14][status 2][IMU1 14]
        const combo = new Uint8Array(30);
        combo.set(leg, 0);
        combo.set([3, 1], 14);
        combo.set(thigh, 16);
        const payload = encodeBase64(combo);

        // a one-tracker device only gets its first IMU
        assert.equal(splitDongleImu(payload, 1).length, 1);

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
        // both IMUs share the status word at bytes 14-15
        assert.deepEqual(
            slices.map((slice) => slice.status),
            [0x0103, 0x0103],
        );
        assert.deepEqual(decodeBase64(slices[0]?.payload ?? ""), leg);
        assert.deepEqual(decodeBase64(slices[1]?.payload ?? ""), thigh);
        assert.equal(slices[0]?.range, undefined);

        // 32 bytes: [IMU0 14][status 2][range 2][IMU1 14], the second IMU moves to byte 18
        const comboRange = new Uint8Array(32);
        comboRange.set(leg, 0);
        comboRange.set([3, 1], 14);
        comboRange.set([0xbc, 0x02], 16);
        comboRange.set(thigh, 18);

        const rangedSlices = splitDongleImu(encodeBase64(comboRange), 2);
        assert.equal(rangedSlices.length, 2);
        assert.equal(rangedSlices[0]?.range, 700);
        assert.equal(rangedSlices[1]?.range, undefined);
        assert.deepEqual(decodeBase64(rangedSlices[1]?.payload ?? ""), thigh);

        assert.deepEqual(splitDongleImu(encodeBase64(new Uint8Array(10)), 1), []);
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
        assert.equal(bodyPartOfTracker("e"), "leftHand");
        assert.equal(bodyPartOfTracker("f"), "rightHand");
        assert.equal(bodyPartOfTracker("0"), undefined);
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

        // pairing mode with a reset for the slot, then without. Going back to sensing is up to the caller once the slot is paired
        assert.deepEqual(pairCommands(4, "0"), ["o:1140", "o:1040"]);
        assert.deepEqual(pairCommands(4, "1"), ["o:2240", "o:2040"]);

        assert.deepEqual(unpairCommands(4, "0"), ["o:3041", "o:3040"]);
        assert.deepEqual(unpairCommands(10, "1"), ["o:30a2", "o:30a0"]);
    });

    it("builds the v3 settings bitstring", () => {
        assert.equal(
            dongleSettingsCommand("0", {
                sensorMode: 1,
                fpsMode: 100,
                sensorAutoCorrection: ["accel", "gyro"],
                ankleMotionDetection: true,
            }),
            "o0:00000110103001",
        );

        assert.equal(
            dongleSettingsCommand("1", {
                sensorMode: 2,
                fpsMode: 50,
                sensorAutoCorrection: [],
                ankleMotionDetection: false,
            }),
            "o1:00000000100000",
        );
    });

    it("puts a body part in the attach point digits", () => {
        const settings = {
            sensorMode: 1,
            fpsMode: 100,
            sensorAutoCorrection: ["accel", "gyro", "mag"],
            ankleMotionDetection: false,
        } satisfies TrackerSettings;

        assert.equal(dongleSettingsCommand("0", settings, undefined, 0x1f), "o0:0001f110107000");
        assert.equal(dongleSettingsCommand("0", settings, 2, 0x0a), "o0:0000a110107020");

        assert.equal(trackerIdOfBodyPart("chest"), 1);
        assert.equal(trackerIdOfBodyPart("rightFoot"), 0xd);
        assert.equal(trackerIdOfBodyPart("unassigned"), undefined);

        // newer firmware only applies it after 0A, 1F, <id>, 00. HXW before 1.0.28 applies any change
        assert.deepEqual(bodyPartCommands("0", settings, 5, true), [
            "o0:0000a110107000",
            "o0:0001f110107000",
            "o0:00005110107000",
            "o0:00000110107000",
        ]);
        assert.deepEqual(bodyPartCommands("0", settings, 5, false), ["o0:00005110107000"]);
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

describe("settings writing", () => {
    it("writes the v3 bitstring to the device's slot", async () => {
        const { app, serial } = await connected();
        serial.emitFrame(INFO);
        serial.emitFrame(INFO_SLOT_1);

        const first: TrackerSettings = {
            sensorMode: 1,
            fpsMode: 100,
            sensorAutoCorrection: ["accel", "gyro"],
            ankleMotionDetection: true,
        };
        const second: TrackerSettings = {
            sensorMode: 2,
            fpsMode: 50,
            sensorAutoCorrection: [],
            ankleMotionDetection: false,
        };

        const events: TrackerSettings[] = [];
        app.on("settings", (event) => events.push(event.settings));

        await app.setSettings("AAAAA7", first);
        await app.setSettings("EEEEE1", second);

        // the dongle echoes the applied settings; unchanged values must not emit again
        serial.emitFrame("o0:00000110103001");
        serial.emitFrame("o1:00000000100000");

        assert.deepEqual(serial.writes, ["COM4:o0:00000110103001", "COM4:o1:00000000100000"]);
        assert.deepEqual(app.getDevice("AAAAA7")?.settings, first);
        assert.deepEqual(app.getDevice("EEEEE1")?.settings, second);
        assert.deepEqual(events, [first, second]);
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

describe("button counters", () => {
    // digit 4 is the tracker id, digits 6 and 9 are the main and sub event counters
    const counters = (main: string, sub = "0") => `r0:110010${main}00${sub}00`;

    for (const buttonDebounceMs of [undefined, 500]) {
        it(`uses the ${buttonDebounceMs === undefined ? "default 100" : buttonDebounceMs} ms debounce interval`, async () => {
            const { app, serial } = await connected(buttonDebounceMs);
            mock.timers.enable({ apis: ["Date"] });
            try {
                const buttons: string[] = [];
                app.on("button", (event) => buttons.push(event.button));
                serial.emitFrame(INFO);
                serial.emitFrame(counters("0"));
                serial.emitFrame(counters("1"));
                mock.timers.tick((buttonDebounceMs ?? 100) - 1);
                serial.emitFrame(counters("2"));
                assert.deepEqual(buttons, ["main"]);

                mock.timers.tick(1);
                serial.emitFrame(counters("3"));
                assert.deepEqual(buttons, ["main", "main"]);
            } finally {
                mock.timers.reset();
                await app.dispose();
            }
        });
    }

    it("disables debounce when buttonDebounceMs is 0", async () => {
        const { app, serial } = await connected(0);
        mock.timers.enable({ apis: ["Date"] });
        try {
            const buttons: string[] = [];
            app.on("button", (event) => buttons.push(event.button));
            serial.emitFrame(INFO);
            serial.emitFrame(counters("0"));
            serial.emitFrame(counters("1"));
            serial.emitFrame(counters("2"));
            assert.deepEqual(buttons, ["main", "main"]);
        } finally {
            mock.timers.reset();
            await app.dispose();
        }
    });

    it("sets the baseline on the first frame instead of reporting a press", async () => {
        const { app, serial } = await connected();
        const buttons: string[] = [];
        app.on("button", (event) => buttons.push(event.button));

        serial.emitFrame(INFO);
        serial.emitFrame(counters("7"));
        assert.deepEqual(buttons, []);

        serial.emitFrame(counters("8"));
        assert.deepEqual(buttons, ["main"]);
    });

    it("counts a wrap from 15 back to 0 as an event", async () => {
        const { app, serial } = await connected();
        const buttons: string[] = [];
        app.on("button", (event) => buttons.push(event.button));

        serial.emitFrame(INFO);
        serial.emitFrame(counters("f"));
        serial.emitFrame(counters("0"));
        assert.deepEqual(buttons, ["main"]);
    });

    it("reports the sub counter separately, and not again while unchanged", async () => {
        const { app, serial } = await connected();
        const buttons: string[] = [];
        app.on("button", (event) => buttons.push(event.button));

        serial.emitFrame(INFO);
        serial.emitFrame(counters("0", "0"));
        serial.emitFrame(counters("0", "3"));
        serial.emitFrame(counters("0", "3"));
        assert.deepEqual(buttons, ["sub"]);
    });
});

describe("tracker identity", () => {
    it("assigns the body part from r0:", async () => {
        const { app, serial } = await connected();

        const identified: Array<{ deviceId: string; trackerId: string; bodyPart: string }> = [];
        app.on("identified", (event) => identified.push(event));

        serial.emitFrame(INFO);
        serial.emitFrame("r0:110070200000");

        assert.equal(app.getDevice("AAAAA7")?.trackers[0]?.bodyPart, "leftElbow");
        assert.equal(app.getBodyPart("AAAAA7:0"), "leftElbow");
        assert.deepEqual(identified, [{ trackerId: "AAAAA7:0", deviceId: "AAAAA7", bodyPart: "leftElbow" }]);
    });

    it("keeps an identity that arrived before info", async () => {
        const { app, serial } = await connected();

        // Identity alone does not create a device.
        serial.emitFrame("r0:110030200000");
        assert.deepEqual(app.getDevices(), []);

        serial.emitFrame(INFO);
        assert.equal(app.getBodyPart("AAAAA7:0"), "leftAnkle");
        assert.equal(app.getDevice("AAAAA7")?.trackers[0]?.trackerId, "AAAAA7:0");
    });

    it("assigns both slots on one endpoint independently", async () => {
        const { app, serial } = await connected();

        serial.emitFrame('i0:{"version":"1.0.22","model":"mc3s","serial no":"AAAAA7"}');
        serial.emitFrame('i1:{"version":"1.0.22","model":"mc3s","serial no":"FFFFF8"}');
        serial.emitFrame("r0:110070200000");
        serial.emitFrame("r1:110080200100");

        assert.equal(app.getBodyPart("AAAAA7:0"), "leftElbow");
        assert.equal(app.getBodyPart("FFFFF8:0"), "rightElbow");
        assert.deepEqual(
            app
                .getDevices()
                .map((device) => device.deviceId)
                .sort(),
            ["AAAAA7", "FFFFF8"],
        );
    });

    it("expands a dual-IMU ankle into ankle + knee samples", async () => {
        const { app, serial } = await connected();

        serial.emitFrame(INFO_DUAL);
        serial.emitFrame("r0:110030200000");

        assert.equal(app.getBodyPart("CCCCC3:0"), "leftAnkle");
        assert.equal(app.getBodyPart("CCCCC3:1"), "leftKnee");

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
            ["CCCCC3:0", "CCCCC3:1"],
        );
        assert.deepEqual(
            samples.map((sample) => sample.role),
            ["ankle", "knee"],
        );
    });

    it("updates RSSI from an a0: frame and emits on change", async () => {
        const { app, serial } = await connected();

        serial.emitFrame(INFO);

        const rssiEvents: Array<{ trackerId: string; rssi: number }> = [];
        app.on("rssi", (event) => rssiEvents.push(event));

        serial.emitFrame("a0:284128442f30");
        serial.emitFrame("a0:284128442f30"); // unchanged — no second event
        serial.emitFrame("a0:374237423b3b");

        // the averages, not the min and max
        assert.equal(app.getTracker("AAAAA7:0")?.rssi, -0x3b);
        assert.equal(app.getTracker("AAAAA7:0")?.sensorRssi, -0x3b);
        assert.deepEqual(rssiEvents, [
            { trackerId: "AAAAA7:0", deviceId: "AAAAA7", rssi: -0x2f, sensorRssi: -0x30 },
            { trackerId: "AAAAA7:0", deviceId: "AAAAA7", rssi: -0x3b, sensorRssi: -0x3b },
        ]);
    });

    it("keeps a tracker connected while IMU frames arrive despite searching status", async () => {
        const { app, serial } = await connected();
        mock.timers.enable({ apis: ["setTimeout", "Date"] });
        try {
            serial.emitFrame(INFO);
            const disconnected: Array<{ trackerId: string; reason: string }> = [];
            const reconnected: string[] = [];
            app.on("tracker:disconnected", (event) => disconnected.push({ trackerId: event.trackerId, reason: event.reason }));
            app.on("tracker:connected", (event) => reconnected.push(event.trackerId));
            for (let i = 0; i < 12; i++) {
                serial.emitFrame("a0:7f7f7f7f7f7f");
                serial.emitFrame("x0:QAV1/Is6EBngAaf/bAkCAA==");
                mock.timers.tick(1_000);
            }
            assert.equal(app.getTracker("AAAAA7:0")?.connected, true);
            assert.deepEqual(disconnected, []);
            assert.deepEqual(reconnected, []);
            serial.emitFrame("a0:7f7f7f7f7f7f");
            mock.timers.tick(9_000);
            assert.equal(app.getTracker("AAAAA7:0")?.connected, false);
            assert.deepEqual(disconnected, [{ trackerId: "AAAAA7:0", reason: "timeout" }]);
        } finally {
            mock.timers.reset();
            await app.dispose();
        }
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

            assert.deepEqual(disconnected, [{ trackerId: "AAAAA7:0", deviceId: "AAAAA7", reason: "timeout" }]);
            assert.equal(app.getTracker("AAAAA7:0")?.connected, false);
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

            assert.deepEqual(connectedAgain, ["AAAAA7:0"]);
            assert.equal(app.getTracker("AAAAA7:0")?.connected, true);
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
        assert.equal(app.getTracker("AAAAA7:0"), undefined);
    });
});

// lets promises that are waiting on a write or a mocked timer run
async function flush(): Promise<void> {
    for (let index = 0; index < 5; index++) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("pairing", () => {
    it("pairs a slot once its unpaired mark clears during the attempt, then goes back to sensing", async () => {
        const { app, serial } = await connected();
        serial.emitFrame("o:3040");

        const paired: Array<{ endpointId: string; slot: string }> = [];
        app.on("paired", (event) => paired.push(event));

        mock.timers.enable({ apis: ["setTimeout"] });
        try {
            // slot 0 has no stored tracker, so its unpaired mark (bit 0) is set before the attempt
            serial.emitFrame("r:301");
            const pending = app.pair("COM4", 0);
            await flush();
            assert.deepEqual(serial.writes, ["COM4:o:1140"]);

            mock.timers.tick(1_000);
            await flush();
            assert.deepEqual(serial.writes, ["COM4:o:1140", "COM4:o:1040"]);

            // slot 0 still has no tracker
            serial.emitFrame("r:301");
            await flush();
            assert.deepEqual(paired, []);

            // the tracker is stored on slot 0: its unpaired mark clears and the paired bit is set
            serial.emitFrame("r:310");
            await pending;
        } finally {
            mock.timers.reset();
        }

        assert.deepEqual(serial.writes, ["COM4:o:1140", "COM4:o:1040", "COM4:o:3040", "COM4:r0:"]);
        assert.deepEqual(paired, [{ endpointId: "COM4", slot: "0" }]);
    });

    it("times out when the slot already had a stored tracker before the attempt", async () => {
        const { app, serial } = await connected();
        serial.emitFrame("o:3040");

        const paired: Array<{ endpointId: string; slot: string }> = [];
        app.on("paired", (event) => paired.push(event));

        mock.timers.enable({ apis: ["setTimeout"] });
        try {
            // slot 0 has a stored tracker (unpaired mark clear), so pairing needs an unpair first
            serial.emitFrame("r:310");
            const pending = app.pair("COM4", 0).catch((error: unknown) => error);
            await flush();
            mock.timers.tick(1_000);
            await flush();

            serial.emitFrame("r:310");
            await flush();
            assert.deepEqual(paired, []);

            mock.timers.tick(30_000);
            const error = await pending;
            assert.equal((error as { code?: string }).code, "TIMEOUT");
        } finally {
            mock.timers.reset();
        }

        assert.deepEqual(paired, []);
    });

    it("pairs the second slot on its own unpaired mark", async () => {
        const { app, serial } = await connected();
        serial.emitFrame("o:3040");

        mock.timers.enable({ apis: ["setTimeout"] });
        try {
            // slot 1 has no stored tracker (bit 1 set), slot 0 is unpaired too
            serial.emitFrame("r:303");
            const pending = app.pair("COM4", 1);
            await flush();
            mock.timers.tick(1_000);
            await flush();

            serial.emitFrame("r:303"); // still unpaired on slot 1
            serial.emitFrame("r:320"); // slot 1 stored, its unpaired mark cleared
            await pending;
        } finally {
            mock.timers.reset();
        }

        assert.deepEqual(serial.writes, ["COM4:o:2240", "COM4:o:2040", "COM4:o:3040", "COM4:r1:"]);
    });

    it("times out and returns the dongle to sensing mode", async () => {
        const { app, serial } = await connected();
        serial.emitFrame("o:3040");

        mock.timers.enable({ apis: ["setTimeout"] });
        try {
            const pending = app.pair("COM4", 0).catch((error: unknown) => error);
            await flush();
            mock.timers.tick(1_000);
            await flush();
            mock.timers.tick(30_000);

            const error = await pending;
            assert.equal((error as { code?: string }).code, "TIMEOUT");
        } finally {
            mock.timers.reset();
        }

        assert.deepEqual(serial.writes, ["COM4:o:1140", "COM4:o:1040", "COM4:o:3040"]);
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
        assert.equal(app.getBodyPart("AAAAA7:0"), "unassigned");
        assert.deepEqual(unpaired, [{ endpointId: "COM4", slot: "0" }]);
    });
});

const DONGLE_1_1_1 = 'i:{"version":"1.1.1","model":"GX6","serial no":"GGGGG0"}';
const DONGLE_1_0_26 = 'i:{"version":"1.0.26","model":"GX6","serial no":"GGGGG0"}';
const INFO_DUAL_1_0_30 = 'i0:{"version":"1.0.30","model":"mc4b","imu_num":2,"serial no":"CCCCC3"}';
const INFO_DUAL_1_1_1 = 'i0:{"version":"1.1.1","model":"mc4b","imu_num":2,"serial no":"CCCCC3"}';
const SETTINGS = "o0:00000110107000";
const LEG_IMU = decodeBase64("QAV1/Is6EBngAaf/bAkCAA==").slice(0, 14);

describe("dongle firmware version", () => {
    it("reads the dongle version from its info frame", async () => {
        const { app, serial } = await connected();
        assert.equal(app.getDongleVersion("COM4"), undefined);

        serial.emitFrame(DONGLE_1_0_26);
        assert.equal(app.getDongleVersion("COM4"), "1.0.26");

        serial.emitFrame(DONGLE_1_1_1);
        assert.equal(app.getDongleVersion("COM4"), "1.1.1");
    });

    it("exposes the tracker version on the device", async () => {
        const { app, serial } = await connected();
        serial.emitFrame(INFO_DUAL);

        assert.equal(app.getDevice("CCCCC3")?.version, "1.0.5");
    });

    it("reads accel accuracy from HX2 on a dongle that reports it", async () => {
        const { app, serial } = await connected();
        serial.emitFrame(DONGLE_1_1_1);
        serial.emitFrame(INFO_DUAL);

        const events: Array<{ trackerId: string; deviceId: string; accuracy: number }> = [];
        app.on("accelAccuracy", (event) => events.push(event));

        // the last two digits of the 14 digit register are the accuracy of the first and second IMU
        serial.emitFrame("r0:11003020000023");

        assert.deepEqual(events, [
            { trackerId: "CCCCC3:0", deviceId: "CCCCC3", accuracy: 2 },
            { trackerId: "CCCCC3:1", deviceId: "CCCCC3", accuracy: 3 },
        ]);
        assert.equal(app.getTracker("CCCCC3:1")?.accelAccuracy, 3);
    });

    it("ignores accel accuracy on a dongle known to be older, and for HXW", async () => {
        const old = await connected();
        old.serial.emitFrame(DONGLE_1_0_26);
        old.serial.emitFrame(INFO_DUAL);

        const oldEvents: unknown[] = [];
        old.app.on("accelAccuracy", (event) => oldEvents.push(event));
        old.serial.emitFrame("r0:11003020000023");
        assert.deepEqual(oldEvents, []);

        // HXW never reports it, whatever the dongle says
        const hxw = await connected();
        hxw.serial.emitFrame(DONGLE_1_1_1);
        hxw.serial.emitFrame(INFO);

        const hxwEvents: unknown[] = [];
        hxw.app.on("accelAccuracy", (event) => hxwEvents.push(event));
        hxw.serial.emitFrame("r0:11003020000023");
        assert.deepEqual(hxwEvents, []);
    });

    it("lets the frame length decide while the dongle version is not known yet", async () => {
        const { app, serial } = await connected();
        serial.emitFrame(INFO_DUAL);

        const events: unknown[] = [];
        app.on("accelAccuracy", (event) => events.push(event));

        serial.emitFrame("r0:110030200000"); // 12 digits, nothing to read
        assert.equal(events.length, 0);

        serial.emitFrame("r0:11003020000011");
        assert.equal(events.length, 2);
    });
});

describe("dongle range data", () => {
    it("reports the range from an HXW frame", async () => {
        const { app, serial } = await connected();
        serial.emitFrame(INFO);

        const ranges: Array<number | undefined> = [];
        app.on("imu", (sample) => ranges.push(sample.range));

        const frame = (range: number) => {
            const bytes = new Uint8Array(18);
            bytes.set(LEG_IMU, 0);
            bytes.set([2, 0], 14);
            new DataView(bytes.buffer).setUint16(16, range, true);
            return `x0:${encodeBase64(bytes)}`;
        };

        serial.emitFrame(frame(700));
        serial.emitFrame(frame(0xfff9)); // an error code
        serial.emitFrame(`x0:${encodeBase64(new Uint8Array([...LEG_IMU, 2, 0]))}`); // no range sensor data

        assert.deepEqual(ranges, [700, undefined, undefined]);
    });

    it("reports the range from an HX2 leg frame on the ankle only", async () => {
        const { app, serial } = await connected();
        serial.emitFrame(INFO_DUAL);
        serial.emitFrame("r0:110030200000");

        const samples: Array<{ bodyPart: string; range: number | undefined }> = [];
        app.on("imu", (sample) => samples.push({ bodyPart: sample.bodyPart, range: sample.range }));

        const bytes = new Uint8Array(32);
        bytes.set(LEG_IMU, 0);
        new DataView(bytes.buffer).setUint16(16, (700 << 5) | 3, true);
        bytes.set(LEG_IMU, 18);
        serial.emitFrame(`x0:${encodeBase64(bytes)}`);

        assert.deepEqual(samples, [
            { bodyPart: "leftAnkle", range: 700 },
            { bodyPart: "leftKnee", range: undefined },
        ]);
    });
});

describe("power off and switching", () => {
    async function holdTimes(info: string, dongleInfo?: string) {
        const { app, serial } = await connected();
        if (dongleInfo) serial.emitFrame(dongleInfo);
        serial.emitFrame(info);
        serial.emitFrame(SETTINGS);

        mock.timers.enable({ apis: ["setTimeout"] });
        try {
            const pending = app.powerOff("CCCCC3");
            await flush();
            assert.deepEqual(serial.writes, ["COM4:o0:00000110107020"]);

            // the command stays set until just before the hold time ends
            return { app, serial, pending };
        } catch (error) {
            mock.timers.reset();
            throw error;
        }
    }

    it("clears the command after 150 ms on trackers older than 1.1.1", async () => {
        const { serial, pending } = await holdTimes(INFO_DUAL);
        try {
            mock.timers.tick(149);
            await flush();
            assert.equal(serial.writes.length, 1);

            mock.timers.tick(1);
            await pending;
            assert.deepEqual(serial.writes, ["COM4:o0:00000110107020", "COM4:o0:00000110107000"]);
        } finally {
            mock.timers.reset();
        }
    });

    it("holds the command for 600 ms on 1.1.1 trackers, which need to see it in several packets", async () => {
        const { serial, pending } = await holdTimes(INFO_DUAL_1_1_1, DONGLE_1_1_1);
        try {
            mock.timers.tick(599);
            await flush();
            assert.equal(serial.writes.length, 1);

            mock.timers.tick(1);
            await pending;
            assert.deepEqual(serial.writes, ["COM4:o0:00000110107020", "COM4:o0:00000110107000"]);
        } finally {
            mock.timers.reset();
        }
    });

    it("holds it for 600 ms when the tracker version is not known", async () => {
        const { serial, pending } = await holdTimes('i0:{"version":"","model":"mc4b","imu_num":2,"serial no":"CCCCC3"}');
        try {
            mock.timers.tick(150);
            await flush();
            assert.equal(serial.writes.length, 1);

            mock.timers.tick(450);
            await pending;
            assert.equal(serial.writes.length, 2);
        } finally {
            mock.timers.reset();
        }
    });

    it("warns when a 1.1.1 tracker is on a dongle that may not repeat the command", async () => {
        const warnings: string[] = [];
        const serial = memoryConnection();
        const app = createHaritoraX({
            connections: [serial],
            logLevel: "warn",
            onLog: (entry) => warnings.push(entry.message),
        });
        await app.discover();
        await app.connect("COM4");

        serial.emitFrame(DONGLE_1_0_26);
        serial.emitFrame(INFO_DUAL_1_1_1);
        serial.emitFrame(SETTINGS);

        mock.timers.enable({ apis: ["setTimeout"] });
        try {
            const pending = app.powerOff("CCCCC3");
            await flush();
            mock.timers.tick(600);
            await pending;
        } finally {
            mock.timers.reset();
        }

        assert.equal(warnings.filter((message) => message.includes("dongle firmware 1.0.26")).length, 1);
    });
});

describe("setting the body part over a dongle", () => {
    async function ready(info: string, identity: string) {
        const { app, serial } = await connected();
        serial.emitFrame(info);
        serial.emitFrame(identity);
        serial.emitFrame(SETTINGS);
        serial.writes.length = 0;
        return { app, serial };
    }

    it("sends the unlock sequence and waits for the tracker to report the body part", async () => {
        // HX2 1.0.14 and later need the 0A 1F <id> 00 sequence, 1.0.5 applies a change directly (see the test below)
        const { app, serial } = await ready(INFO_DUAL_1_0_30, "r0:110030200000");

        mock.timers.enable({ apis: ["setTimeout"] });
        try {
            const pending = app.setBodyPart("CCCCC3", "rightAnkle");
            await flush();
            assert.deepEqual(serial.writes, ["COM4:o0:0000a110107000"]);

            for (let step = 0; step < 3; step++) {
                mock.timers.tick(200);
                await flush();
            }

            assert.deepEqual(serial.writes, [
                "COM4:o0:0000a110107000",
                "COM4:o0:0001f110107000",
                "COM4:o0:00005110107000",
                "COM4:o0:00000110107000",
                "COM4:r0:",
            ]);

            // the tracker reports its new body part in the register
            serial.emitFrame("r0:110050200000");
            await pending;
        } finally {
            mock.timers.reset();
        }

        assert.equal(app.getBodyPart("CCCCC3:0"), "rightAnkle");
        assert.equal(app.getBodyPart("CCCCC3:1"), "rightKnee");
    });

    it("applies the body part directly on HX2 1.0.5, without the unlock sequence", async () => {
        // an extra (serial ends in 0) has no factory part, so the base lock doesn't apply
        const extra = 'i0:{"version":"1.0.5","model":"mc4b","imu_num":2,"serial no":"BBBBB0"}';
        const { app, serial } = await ready(extra, "r0:110030200000");

        mock.timers.enable({ apis: ["setTimeout"] });
        try {
            const pending = app.setBodyPart("BBBBB0", "rightAnkle");
            await flush();
            assert.deepEqual(serial.writes, ["COM4:o0:00005110107000", "COM4:r0:"]);

            serial.emitFrame("r0:110050200000");
            await pending;
        } finally {
            mock.timers.reset();
        }

        assert.equal(app.getBodyPart("BBBBB0:0"), "rightAnkle");
    });

    it("refuses to set the body part when the firmware version is unknown", async () => {
        // the extra (serial ends in 0) has no base lock, so only the unknown version can stop the write
        const unknown = 'i0:{"version":"","model":"mc4b","imu_num":2,"serial no":"BBBBB0"}';
        const { app, serial } = await ready(unknown, "r0:110030200000");

        const error = (await app.setBodyPart("BBBBB0", "rightAnkle").catch((caught: unknown) => caught)) as {
            code?: string;
        };
        assert.equal(error.code, "NOT_SUPPORTED");
        assert.deepEqual(serial.writes, []);
    });

    it("refuses a base tracker on firmware with the lock before writing anything", async () => {
        const { app, serial } = await ready(INFO_DUAL, "r0:110030200000");

        const error = (await app.setBodyPart("CCCCC3", "rightAnkle").catch((caught: unknown) => caught)) as {
            code?: string;
            message?: string;
        };
        assert.equal(error.code, "NOT_SUPPORTED");
        assert.match(error.message ?? "", /base tracker.*1\.0\.24/);
        assert.deepEqual(serial.writes, []);
    });

    it("fails when the tracker never reports the body part", async () => {
        const { app } = await ready(INFO_DUAL_1_0_30, "r0:110030200000");

        mock.timers.enable({ apis: ["setTimeout"] });
        try {
            const pending = app.setBodyPart("CCCCC3", "rightAnkle").catch((error: unknown) => error);
            await flush();
            for (let step = 0; step < 3; step++) {
                mock.timers.tick(200);
                await flush();
            }
            mock.timers.tick(2_000);

            assert.equal(((await pending) as { code?: string }).code, "TIMEOUT");
        } finally {
            mock.timers.reset();
        }
    });

    it("writes the id directly to an HXW older than 1.0.27", async () => {
        // an extra (serial ends in 0), so the base lock doesn't stop the write
        const extra = 'i0:{"version":"1.0.22","model":"mc3s","imu_num":1,"serial no":"AAAAA0"}';
        const { app, serial } = await ready(extra, "r0:110030200000");

        const pending = app.setBodyPart("AAAAA0", "leftElbow");
        await flush();
        assert.deepEqual(serial.writes, ["COM4:o0:00007110107000", "COM4:r0:"]);

        serial.emitFrame("r0:110070200000");
        await pending;
        assert.equal(app.getBodyPart("AAAAA0:0"), "leftElbow");
    });

    it("rejects what can't be done", async () => {
        const { app } = await ready(INFO_DUAL_1_0_30, "r0:110030200000");

        const code = async (action: Promise<unknown>) =>
            ((await action.catch((error: unknown) => error)) as { code?: string }).code;
        assert.equal(await code(app.setBodyPart("CCCCC3", "unassigned")), "NOT_SUPPORTED");
        assert.equal(await code(app.setBodyPart("NOPE00", "chest")), "DEVICE_NOT_FOUND");

        // settings are needed, the sequence writes all of them back
        const noSettings = await connected();
        noSettings.serial.emitFrame(INFO_DUAL_1_0_30);
        assert.equal(await code(noSettings.app.setBodyPart("CCCCC3", "chest")), "READ_FAILED");
    });
});

describe("settings echo", () => {
    // the dongle's stored `oN:` frame, with led 1, gyro rate 2 and mag stabilised (digits 0, 8 and 11)
    const ECHO = ["1", "0", "0", "0", "0", "0", "0", "0", "2", "0", "0", "1", "0", "0"].join("");

    it("keeps the digits the dongle echoed and changes only the ones it sets", async () => {
        const { app, serial } = await connected();
        serial.emitFrame(INFO);
        serial.emitFrame(`o0:${ECHO}`);

        await app.setSettings("AAAAA7", {
            sensorMode: 1,
            fpsMode: 100,
            sensorAutoCorrection: ["accel"],
            ankleMotionDetection: true,
        });

        // led (0), gyro rate (8) and magSt (11) come from the echo. speed, imu mode, dcal and range are the new settings
        assert.deepEqual(
            serial.writes.filter((write) => write.startsWith("COM4:o0:")),
            ["COM4:o0:10000110201101"],
        );
    });

    it("clears a leftover power-off once per slot, from the first echo", async () => {
        const { serial } = await connected();
        const echo = (mode: string) => `${"00000000100000".slice(0, 12)}${mode}0`;

        serial.emitFrame(`o0:${echo("2")}`);
        serial.emitFrame(`o0:${echo("2")}`);
        assert.deepEqual(
            serial.writes.filter((write) => write.startsWith("COM4:o0:")),
            ["COM4:o0:00000000100000"],
        );

        // an echo with no leftover command isn't written again
        serial.emitFrame(`o1:${echo("0")}`);
        assert.deepEqual(
            serial.writes.filter((write) => write.startsWith("COM4:o1:")),
            [],
        );
    });
});

describe("dongle channels and latency", () => {
    it("refuses a channel another dongle already uses", async () => {
        const first = memoryConnection("COM4");
        const second = memoryConnection("COM5");
        const app = createHaritoraX({ connections: [first, second], logLevel: "silent" });

        await app.discover();
        await app.connect("COM4");
        await app.connect("COM5");
        first.emitFrame("o:3040");
        second.emitFrame("o:3040");

        const error = await app.setChannel("COM5", 4).catch((err: unknown) => err);
        assert.equal((error as { code?: string }).code, "NOT_SUPPORTED");
        assert.equal(app.getChannel("COM5"), 4);

        await app.setChannel("COM5", 5);
        assert.equal(app.getChannel("COM5"), 5);
    });

    it("pings the dongle once a second and measures the round trip", async () => {
        const { app, serial } = await connected();

        serial.emitFrame('i:{"version":"1.0.29","model":"gx6"}');
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        assert.ok(serial.writes.includes("COM4:i:"));

        serial.emitFrame('i:{"version":"1.0.29","model":"gx6"}');
        const latency = app.getLatency("COM4");
        assert.ok(latency !== undefined && latency >= 0 && latency < 1_000);
    });
});
