import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { createHaritoraX } from "../dist/index.js";
import { BleConnection, type BleBackend, type BlePeripheralSummary } from "../dist/connections/ble/index.js";
import type { Connection, Frame, ListOptions } from "../dist/connections/contract.js";
import {
    bleBodyPart,
    bleCharacteristicFromUuid,
    bleSettingValues,
    bleWiredMagStatusAt,
    parseBleDeviceName,
    splitBleImu,
    splitBleSensor2,
} from "../dist/protocol/endpoint/ble.js";
import type { BleCharacteristic } from "../dist/protocol/endpoint/ble.js";
import { splitWiredImuBytes } from "../dist/protocol/endpoint/wired.js";
import type { DisconnectReason, TrackerSettings, Unsubscribe } from "../dist/types.js";

function bytes(text: string): Uint8Array {
    const result = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index++) result[index] = text.charCodeAt(index);
    return result;
}

function byte(...values: number[]): Uint8Array {
    return Uint8Array.from(values);
}

function hex(text: string): Uint8Array {
    const result = new Uint8Array(text.length / 2);
    for (let index = 0; index < result.length; index++) {
        result[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
    }

    return result;
}

// captured from a HaritoraX2-BBBBB0 (HaritoraX2-BBBBB0-read.txt)
const SINGLE_IMU = hex("9400fe01c0085d3f7dff3c00fc07");
// captured from a two-IMU HaritoraX 2 over BLE (the same instant, so sensor and sensor2 carry the same IMU data)
const SENSOR_2IMU = hex("00db0afb3b00fc33020181f89a02551d31fdb2fecc3875008b069e04");
const SENSOR2_2IMU = hex("00db0afb3b00fc33020181f89a020201551d31fdb2fecc3875008b069e04");

// HXW reports its model as "MC3" over BLE, the dongle calls it "mc3s"
const HXW_DEVICE: FakeDevice = { localName: "HaritoraXW-AAAAA7", serial: "AAAAA7", model: "MC3", version: "1.0.28" };

class FakeBleBackend implements BleBackend {
    readonly peripherals: BlePeripheralSummary[] = [
        { id: "ble-1", localName: "HaritoraX2-BBBBB0", rssi: -52 },
        { id: "other", localName: "JBL Flip 4", rssi: -80 },
    ];
    readonly writes: Array<{ endpointId: string; characteristic: BleCharacteristic; data: number[] }> = [];
    readonly opened = new Set<string>();
    // the real backend reads the device information while opening, a test can emit it from here
    onOpen: (() => void) | undefined;

    readonly #dataHandlers = new Set<(endpointId: string, characteristic: BleCharacteristic, data: Uint8Array) => void>();
    readonly #lostHandlers = new Set<(endpointId: string, reason: DisconnectReason) => void>();
    readonly #rssiHandlers = new Set<(peripheralId: string, rssi: number) => void>();

    scan(_options?: ListOptions): Promise<BlePeripheralSummary[]> {
        return Promise.resolve(this.peripherals);
    }

    open(peripheralId: string): Promise<void> {
        this.opened.add(peripheralId);
        this.onOpen?.();
        return Promise.resolve();
    }

    close(peripheralId: string): Promise<void> {
        this.opened.delete(peripheralId);
        return Promise.resolve();
    }

    read(): Promise<Uint8Array | undefined> {
        return Promise.resolve(undefined);
    }

    write(peripheralId: string, characteristic: BleCharacteristic, data: Uint8Array): Promise<void> {
        this.writes.push({ endpointId: peripheralId, characteristic, data: [...data] });
        return Promise.resolve();
    }

    onData(handler: (endpointId: string, characteristic: BleCharacteristic, data: Uint8Array) => void): Unsubscribe {
        this.#dataHandlers.add(handler);
        return () => this.#dataHandlers.delete(handler);
    }

    onLost(handler: (endpointId: string, reason: DisconnectReason) => void): Unsubscribe {
        this.#lostHandlers.add(handler);
        return () => this.#lostHandlers.delete(handler);
    }

    onRssi(handler: (peripheralId: string, rssi: number) => void): Unsubscribe {
        this.#rssiHandlers.add(handler);
        return () => this.#rssiHandlers.delete(handler);
    }

    dispose(): Promise<void> {
        this.opened.clear();
        this.#dataHandlers.clear();
        this.#lostHandlers.clear();
        this.#rssiHandlers.clear();
        return Promise.resolve();
    }

    emit(endpointId: string, characteristic: BleCharacteristic, data: Uint8Array): void {
        for (const handler of this.#dataHandlers) handler(endpointId, characteristic, data);
    }

    lose(endpointId: string): void {
        this.opened.delete(endpointId);
        for (const handler of this.#lostHandlers) handler(endpointId, "remote");
    }
}

interface FakeDevice {
    localName: string;
    serial: string;
    // device information model number, "MC4B" for HX2 and "MC3" for HXW
    model: string;
    // software revision (2a28), the tracker's firmware version
    version: string;
}

const HX2_DEVICE: FakeDevice = { localName: "HaritoraX2-BBBBB0", serial: "BBBBB0", model: "MC4B", version: "1.0.30" };

function identityFrames(device: FakeDevice): Array<[BleCharacteristic, Uint8Array]> {
    return [
        ["serial-number", bytes(device.serial)],
        // v3 used the software revision (2a28) as the tracker version
        ["software-revision", bytes(device.version)],
        ["number-of-imu", byte(1)],
        ["model-number", bytes(device.model)],
        ["body-part", byte(7)],
        ["magnetometer", byte(2)],
        ["sensor-mode", byte(8)],
        ["fps", byte(2)],
        ["auto-calibration", byte(1)],
        ["tof", byte(0)],
        ["battery-level", byte(80)],
        ["battery-voltage", byte(0xc0, 0x0f)],
        ["charge-status", byte(0)],
    ];
}

async function connected(device: FakeDevice = HX2_DEVICE) {
    const backend = new FakeBleBackend();
    backend.peripherals[0] = { id: "ble-1", localName: device.localName, rssi: -52 };

    const connection = new BleConnection(backend, { scanTimeoutMs: 1 });
    const app = createHaritoraX({ connections: [connection], logLevel: "silent" });

    const infos: Array<{ deviceId: string; version: string; model: string; imuCount?: number }> = [];
    app.on("info", (event) => infos.push(event));

    await app.discover();
    await app.connect("ble-1");

    // the real backend reads these during open; the fake emits them once connected
    for (const [characteristic, data] of identityFrames(device)) backend.emit("ble-1", characteristic, data);

    return { app, backend, infos };
}

describe("BLE protocol", () => {
    it("parses HaritoraXW/HaritoraX2 local names", () => {
        assert.deepEqual(parseBleDeviceName("HaritoraX2-BBBBB0"), {
            model: "x2",
            localName: "HaritoraX2-BBBBB0",
        });
        assert.deepEqual(parseBleDeviceName("haritoraxw-ABC123"), {
            model: "wireless",
            localName: "haritoraxw-ABC123",
        });
        assert.equal(parseBleDeviceName("JBL Flip 4"), undefined);
        assert.equal(parseBleDeviceName("HaritoraX2-"), undefined);
    });

    it("maps characteristic UUIDs with and without dashes", () => {
        assert.equal(bleCharacteristicFromUuid("2a19"), "battery-level");
        assert.equal(bleCharacteristicFromUuid("00DBF1C6-90AA-11ED-A1EB-0242AC120002"), "sensor");
        assert.equal(bleCharacteristicFromUuid("00dbf07c90aa11eda1eb0242ac120002"), "number-of-imu");
        assert.equal(bleCharacteristicFromUuid("1234"), undefined);
        // standard characteristics also come as the full 128-bit UUID, as the wired tracker's read capture shows
        assert.equal(bleCharacteristicFromUuid("00002a19-0000-1000-8000-00805f9b34fb"), "battery-level");
        assert.equal(bleCharacteristicFromUuid("00002a28-0000-1000-8000-00805f9b34fb"), "software-revision");
        assert.equal(bleCharacteristicFromUuid("00002a99-0000-1000-8000-00805f9b34fb"), undefined);
    });

    it("slices single and dual IMU payloads like v3", () => {
        assert.equal(splitBleImu(SINGLE_IMU).length, 1);
        assert.deepEqual(
            splitBleImu(SINGLE_IMU).map((slice) => slice.role),
            ["ankle"],
        );

        // two-IMU sensor frames are 28 bytes: [IMU0 14][IMU1 14], verified on hardware
        const slices28 = splitBleImu(SENSOR_2IMU.slice(0, 28));
        assert.equal(slices28.length, 2);
        assert.equal(slices28[0]?.payload.length, 14);
        assert.equal(slices28[1]?.payload.length, 14);
        assert.equal(slices28[1]?.role, "knee");
        assert.deepEqual(slices28[1]?.payload, SENSOR_2IMU.slice(14, 28));
        assert.equal(slices28[0]?.range, undefined);
    });

    it("finds the range bytes in sensor frames", () => {
        // with ankle motion detection the range sits between the IMUs: [IMU0 14][range 2] and [IMU0 14][range 2][IMU1 14]
        const single = new Uint8Array(16);
        single.set(SINGLE_IMU, 0);
        single.set([0xbc, 0x02], 14);

        const [only] = splitBleImu(single);
        assert.equal(splitBleImu(single).length, 1);
        assert.equal(only?.payload.length, 14);
        assert.equal(only?.range, 700);

        const dual = new Uint8Array(30);
        dual.set(SENSOR_2IMU.slice(0, 14), 0);
        dual.set([0xbc, 0x02], 14);
        dual.set(SENSOR_2IMU.slice(14, 28), 16);

        const slices = splitBleImu(dual);
        assert.equal(slices.length, 2);
        assert.equal(slices[0]?.range, 700);
        assert.deepEqual(slices[1]?.payload, SENSOR_2IMU.slice(14, 28));
        assert.equal(slices[1]?.range, undefined);

        assert.deepEqual(splitBleImu(new Uint8Array(13)), []);
    });

    it("slices sensor2 frames by length and reads status and range", () => {
        const one = splitBleSensor2(SENSOR2_2IMU.slice(0, 16));
        assert.equal(one.length, 1);
        assert.equal(one[0]?.index, 0);
        assert.equal(one[0]?.status, 0x0102);
        assert.equal(one[0]?.range, undefined);

        const ranged = new Uint8Array(18);
        ranged.set(SENSOR2_2IMU.slice(0, 16), 0);
        ranged.set([0x2a, 0x00], 16);
        assert.equal(splitBleSensor2(ranged)[0]?.range, 42);

        const two = splitBleSensor2(SENSOR2_2IMU);
        assert.equal(two.length, 2);
        assert.equal(two[0]?.status, 0x0102);
        assert.equal(two[1]?.index, 1);
        assert.equal(two[1]?.role, "knee");
        assert.deepEqual(two[1]?.payload, SENSOR_2IMU.slice(14, 28));

        // two IMUs plus range: [IMU0 14][status 2][range 2][IMU1 14], the second IMU starts at 18
        // (from the firmware, not captured on hardware yet)
        const dualRanged = new Uint8Array(32);
        dualRanged.set(SENSOR2_2IMU.slice(0, 16), 0);
        dualRanged.set([0xbc, 0x02], 16);
        dualRanged.set(SENSOR_2IMU.slice(14, 28), 18);

        const dual = splitBleSensor2(dualRanged);
        assert.equal(dual.length, 2);
        assert.equal(dual[0]?.range, 700);
        assert.deepEqual(dual[1]?.payload, SENSOR_2IMU.slice(14, 28));

        assert.deepEqual(splitBleSensor2(new Uint8Array(20)), []);
    });

    it("maps settings values and body part assignments", () => {
        assert.deepEqual(
            bleSettingValues({
                sensorMode: 1,
                fpsMode: 100,
                sensorAutoCorrection: ["accel", "gyro", "mag"],
                ankleMotionDetection: true,
            }),
            { sensorMode: 5, fpsMode: 2, autoCorrection: 7, tof: 1 },
        );

        assert.equal(bleBodyPart(byte(1)), "chest");
        assert.equal(bleBodyPart(byte(3)), "leftAnkle");
        assert.equal(bleBodyPart(byte(0)), undefined);
        assert.equal(bleBodyPart(byte(99)), undefined);
    });
});

describe("BLE device", () => {
    it("lists only HaritoraX peripherals", async () => {
        const backend = new FakeBleBackend();
        const connection = new BleConnection(backend, { scanTimeoutMs: 1 });

        const found = await connection.list();

        assert.deepEqual(
            found.map((descriptor) => [descriptor.id, descriptor.model, descriptor.connection]),
            [["ble-1", "x2", "ble"]],
        );
        assert.equal(found[0]?.rssi, -52);
        assert.equal(found[0]?.displayName, "HaritoraX2-BBBBB0");
    });

    it("registers a device, trackers, settings and battery from initial reads", async () => {
        const { app, infos } = await connected();

        assert.equal(infos.length, 1);
        assert.equal(infos[0]?.deviceId, "BBBBB0");
        assert.equal(infos[0]?.version, "1.0.30");
        assert.equal(infos[0]?.model, "MC4B");
        assert.equal(infos[0]?.imuCount, 1);

        const device = app.getDevice("BBBBB0");
        assert.ok(device);
        assert.equal(device.model, "x2");
        assert.equal(device.connection, "ble");
        assert.equal(device.imuCount, 1);
        assert.deepEqual(
            device.trackers.map((tracker) => [tracker.trackerId, tracker.bodyPart]),
            [["BBBBB0:0", "leftElbow"]],
        );
        assert.deepEqual(device.settings, {
            sensorMode: 2,
            fpsMode: 100,
            sensorAutoCorrection: ["accel"],
            ankleMotionDetection: false,
        });
        assert.equal(device.battery?.level, 80);
        assert.equal(device.battery?.voltage, 4032);
        assert.equal(device.battery?.chargeStatus, "discharging");
    });

    it("registers an HXW over BLE, which reports its model as MC3", async () => {
        const { app } = await connected(HXW_DEVICE);

        const device = app.getDevice("AAAAA7");
        assert.equal(device?.model, "wireless");
        assert.equal(device?.version, "1.0.28");
        assert.equal(app.getTracker("AAAAA7:0")?.bodyPart, "leftElbow");
    });

    it("skips sensor from the start once the firmware version proves sensor2 exists", async () => {
        const { app, backend } = await connected();

        const samples: string[] = [];
        app.on("imu", (sample) => samples.push(sample.trackerId));

        // HX2 1.0.30 has sensor2, so the sensor notification that arrives first is not read
        backend.emit("ble-1", "sensor", SINGLE_IMU);
        assert.deepEqual(samples, []);

        backend.emit("ble-1", "sensor2", SENSOR2_2IMU.slice(0, 16));
        assert.deepEqual(samples, ["BBBBB0:0"]);
    });

    it("gates sensor2 on the HXW firmware version", async () => {
        const old = await connected({ ...HXW_DEVICE, version: "1.0.22" });
        const oldSamples: string[] = [];
        old.app.on("imu", (sample) => oldSamples.push(sample.trackerId));
        old.backend.emit("ble-1", "sensor", SINGLE_IMU);
        assert.deepEqual(oldSamples, ["AAAAA7:0"]);

        const current = await connected(HXW_DEVICE);
        const currentSamples: string[] = [];
        current.app.on("imu", (sample) => currentSamples.push(sample.trackerId));
        current.backend.emit("ble-1", "sensor", SINGLE_IMU);
        assert.deepEqual(currentSamples, []);
    });

    it("reads sensor while the HXW version is unknown, until sensor2 shows up", async () => {
        const { app, backend } = await connected({ ...HXW_DEVICE, version: "" });

        const samples: string[] = [];
        app.on("imu", (sample) => samples.push(sample.trackerId));

        backend.emit("ble-1", "sensor", SINGLE_IMU);
        assert.equal(samples.length, 1);

        backend.emit("ble-1", "sensor2", SENSOR2_2IMU.slice(0, 16));
        assert.equal(samples.length, 2);

        // sensor2 has been seen, so sensor is the duplicate now
        backend.emit("ble-1", "sensor", SINGLE_IMU);
        assert.equal(samples.length, 2);
    });

    it("uses sensor2 as the IMU source for two IMUs", async () => {
        const { app, backend } = await connected();

        const samples: Array<{ trackerId: string; role: string }> = [];
        app.on("imu", (sample) => samples.push({ trackerId: sample.trackerId, role: sample.role }));
        const taps: number[] = [];
        app.on("tap", (event) => taps.push(event.count));

        backend.emit("ble-1", "sensor2", SENSOR2_2IMU);
        backend.emit("ble-1", "sensor", SENSOR_2IMU.slice(0, 28));

        assert.deepEqual(
            samples.map((sample) => [sample.trackerId, sample.role]),
            [
                ["BBBBB0:0", "ankle"],
                ["BBBBB0:1", "knee"],
            ],
        );
        assert.deepEqual(taps, [0, 0]);
        assert.equal(app.getTracker("BBBBB0:1")?.mag, "bad");
    });

    it("keeps both combo IMUs alive when sensor2 is advertised but never streams", async () => {
        mock.timers.enable({ apis: ["Date", "setTimeout"] });
        const { app, backend } = await connected();
        try {
            const samples: string[] = [];
            const lost: string[] = [];
            app.on("imu", (sample) => samples.push(sample.trackerId));
            app.on("tracker:disconnected", ({ trackerId }) => lost.push(trackerId));

            backend.emit("ble-1", "sensor", SENSOR_2IMU);
            assert.deepEqual(samples, []);
            // Longer than the registry's 10-second inactivity timeout.
            for (let tick = 0; tick < 120; tick++) {
                mock.timers.tick(100);
                backend.emit("ble-1", "sensor", SENSOR_2IMU);
            }
            assert.ok(samples.includes("BBBBB0:0"));
            assert.ok(samples.includes("BBBBB0:1"));
            assert.deepEqual(lost, []);
            assert.equal(app.getTracker("BBBBB0:1")?.connected, true);
        } finally {
            await app.dispose();
            mock.timers.reset();
        }
    });

    it("falls back after sensor2 stalls and prefers it again when it recovers", async () => {
        mock.timers.enable({ apis: ["Date", "setTimeout"] });
        const { app, backend } = await connected();
        try {
            const samples: string[] = [];
            app.on("imu", (sample) => samples.push(sample.trackerId));
            backend.emit("ble-1", "sensor2", SENSOR2_2IMU);
            backend.emit("ble-1", "sensor", SENSOR_2IMU);
            assert.equal(samples.length, 2);

            mock.timers.tick(300);
            backend.emit("ble-1", "sensor", SENSOR_2IMU);
            assert.equal(samples.length, 4);
            backend.emit("ble-1", "sensor2", SENSOR2_2IMU);
            backend.emit("ble-1", "sensor", SENSOR_2IMU);
            assert.equal(samples.length, 6);
        } finally {
            await app.dispose();
            mock.timers.reset();
        }
    });

    it("does not let malformed sensor2 notifications suppress valid basic frames", async () => {
        mock.timers.enable({ apis: ["Date", "setTimeout"] });
        const { app, backend } = await connected();
        try {
            const samples: string[] = [];
            app.on("imu", (sample) => samples.push(sample.trackerId));
            backend.emit("ble-1", "sensor", SENSOR_2IMU);
            mock.timers.tick(300);
            backend.emit("ble-1", "sensor2", new Uint8Array(20));
            backend.emit("ble-1", "sensor", SENSOR_2IMU);
            assert.deepEqual(samples, ["BBBBB0:0", "BBBBB0:1"]);
        } finally {
            await app.dispose();
            mock.timers.reset();
        }
    });

    it("reports the range in millimetres, decoded for the tracker model", async () => {
        const hx2 = await connected();
        const hx2Ranges: Array<number | undefined> = [];
        hx2.app.on("imu", (sample) => hx2Ranges.push(sample.range));

        const frame = (raw: number) => {
            const data = new Uint8Array(18);
            data.set(SENSOR2_2IMU.slice(0, 16), 0);
            data.set([raw & 0xff, raw >> 8], 16);
            return data;
        };

        hx2.backend.emit("ble-1", "sensor2", SENSOR2_2IMU.slice(0, 16));
        // HX2 range sensor: millimetres in the upper 11 bits, a spread code in the low 5
        hx2.backend.emit("ble-1", "sensor2", frame((700 << 5) | 3));
        hx2.backend.emit("ble-1", "sensor2", frame(0xffff));
        assert.deepEqual(hx2Ranges, [undefined, 700, undefined]);

        const hxw = await connected(HXW_DEVICE);
        const hxwRanges: Array<number | undefined> = [];
        hxw.app.on("imu", (sample) => hxwRanges.push(sample.range));

        // HXW range sensor: signed millimetres, negative values are errors, 0xffff is no reading yet
        hxw.backend.emit("ble-1", "sensor2", frame(700));
        hxw.backend.emit("ble-1", "sensor2", frame(0xfff9));
        hxw.backend.emit("ble-1", "sensor2", frame(0xffff));
        assert.deepEqual(hxwRanges, [700, undefined, undefined]);
    });

    it("reads the range from sensor2 frames that carry it", async () => {
        const { app, backend } = await connected();

        const ranges: Array<number | undefined> = [];
        app.on("imu", (sample) => ranges.push(sample.range));

        // 16 bytes is IMU + status, 18 adds the range at byte 16
        const withoutRange = new Uint8Array(16);
        withoutRange.set(SINGLE_IMU, 0);
        const withRange = new Uint8Array(18);
        withRange.set(SINGLE_IMU, 0);
        withRange.set([(700 << 5) & 0xff, (700 << 5) >> 8], 16);

        backend.emit("ble-1", "sensor2", withoutRange);
        backend.emit("ble-1", "sensor2", withRange);

        // a 16-byte frame has no range
        assert.deepEqual(ranges, [undefined, 700]);
    });

    it("emits magnetometer, button and battery updates", async () => {
        const { app, backend } = await connected();

        const mags: string[] = [];
        const buttons: Array<{ deviceId: string; button: string }> = [];
        app.on("mag", (event) => mags.push(`${event.trackerId}:${event.status}`));
        app.on("button", (event) => buttons.push(event));

        backend.emit("ble-1", "magnetometer", byte(3));
        backend.emit("ble-1", "secondary-button", byte(1));
        backend.emit("ble-1", "battery-level", byte(70));

        assert.deepEqual(mags, ["BBBBB0:0:great"]);
        assert.deepEqual(buttons, [{ deviceId: "BBBBB0", button: "sub" }]);
        assert.equal(app.getDevice("BBBBB0")?.battery?.level, 70);
        assert.equal(app.getDevice("BBBBB0")?.battery?.voltage, 4032);
    });

    it("emits mag, tap and accel accuracy from sensor2 and 00dbc401", async () => {
        const { app, backend } = await connected();

        const taps: number[] = [];
        const mags: string[] = [];
        const accuracy: number[] = [];
        app.on("tap", (event) => taps.push(event.count));
        app.on("mag", (event) => mags.push(event.status));
        app.on("accelAccuracy", (event) => accuracy.push(event.accuracy));

        // 16-byte sensor2 frame, status word 0x0006: IMU0 mag 2 (okay), tap 1; upper byte is for IMU1 (not present)
        const frame = new Uint8Array(16);
        frame[14] = 0x06;
        frame[15] = 0x0b;
        backend.emit("ble-1", "sensor2", frame);
        backend.emit("ble-1", "sensor2", frame);
        frame[14] = 0x00;
        backend.emit("ble-1", "sensor2", frame);

        // 0b11 = IMU0 high
        backend.emit("ble-1", "accel-accuracy", byte(0x03));
        backend.emit("ble-1", "accel-accuracy", byte(0x03));

        assert.deepEqual(taps, [1, 0]);
        // mag was already "okay" from the magnetometer characteristic at connect, so only the drop to 0 is a change
        assert.deepEqual(mags, ["veryBad"]);
        assert.deepEqual(accuracy, [3]);
        assert.equal(app.getTracker("BBBBB0:0")?.tap, 0);
        assert.equal(app.getTracker("BBBBB0:0")?.accelAccuracy, 3);
    });

    it("writes BLE settings to the setting characteristics", async () => {
        const { app, backend } = await connected();

        const settings: TrackerSettings = {
            sensorMode: 1,
            fpsMode: 100,
            sensorAutoCorrection: ["accel", "gyro", "mag"],
            ankleMotionDetection: true,
        };
        await app.setSettings("BBBBB0", settings);

        assert.deepEqual(backend.writes, [
            { endpointId: "ble-1", characteristic: "sensor-mode", data: [5] },
            { endpointId: "ble-1", characteristic: "fps", data: [2] },
            { endpointId: "ble-1", characteristic: "auto-calibration", data: [7] },
            { endpointId: "ble-1", characteristic: "tof", data: [1] },
        ]);
        assert.deepEqual(app.getDevice("BBBBB0")?.settings, settings);
    });

    it("drops the device when the peripheral disconnects", async () => {
        const { app, backend } = await connected();

        const lost: string[] = [];
        app.on("endpoint:disconnected", (event) => lost.push(`${event.endpointId}:${event.reason}`));

        backend.lose("ble-1");

        assert.deepEqual(lost, ["ble-1:remote"]);
        assert.deepEqual(app.getDevices(), []);
    });
});

describe("setting the body part over BLE", () => {
    const settle = async () => {
        for (let index = 0; index < 3; index++) await new Promise<void>((resolve) => setImmediate(resolve));
    };

    it("writes the id and waits for the tracker to notify the new body part", async () => {
        const { app, backend } = await connected();

        const pending = app.setBodyPart("BBBBB0", "rightAnkle");
        await settle();
        assert.deepEqual(backend.writes.at(-1), { endpointId: "ble-1", characteristic: "body-part-write", data: [5] });

        // the tracker answers by notifying the body part characteristic
        backend.emit("ble-1", "body-part", byte(5));
        await pending;

        assert.equal(app.getBodyPart("BBBBB0:0"), "rightAnkle");
    });

    it("fails when the tracker never notifies the body part", async () => {
        const { app } = await connected();

        mock.timers.enable({ apis: ["setTimeout"] });
        try {
            const pending = app.setBodyPart("BBBBB0", "rightAnkle").catch((error: unknown) => error);
            await settle();
            mock.timers.tick(2_000);

            assert.equal(((await pending) as { code?: string }).code, "TIMEOUT");
        } finally {
            mock.timers.reset();
        }
    });

    it("doesn't wait when the tracker already has that body part, it doesn't notify then", async () => {
        const { app, backend } = await connected();

        // BBBBB0 reports left elbow (7)
        await app.setBodyPart("BBBBB0", "leftElbow");

        assert.deepEqual(backend.writes.at(-1), { endpointId: "ble-1", characteristic: "body-part-write", data: [7] });
    });

    it("doesn't wait for a notification from firmware that can't send one", async () => {
        // an extra (serial ends in 0), so the base lock doesn't stop the write
        const { app, backend } = await connected({
            ...HXW_DEVICE,
            localName: "HaritoraXW-AAAAA0",
            serial: "AAAAA0",
            version: "1.0.22",
        });

        await app.setBodyPart("AAAAA0", "leftKnee");

        assert.deepEqual(backend.writes.at(-1), { endpointId: "ble-1", characteristic: "body-part-write", data: [2] });
    });

    it("refuses a base tracker on firmware that still has the lock, before writing", async () => {
        // AAAAA7 ends in 7, so it came with a body part, and 1.0.27 is the last HXW build with the lock
        const { app, backend } = await connected({ ...HXW_DEVICE, version: "1.0.27" });

        const error = (await app.setBodyPart("AAAAA7", "leftKnee").catch((reason: unknown) => reason)) as {
            code?: string;
        };
        assert.equal(error.code, "NOT_SUPPORTED");
        assert.equal(backend.writes.filter((write) => write.characteristic === "body-part-write").length, 0);
    });

    it("rejects a body part a tracker can't have", async () => {
        const { app } = await connected();

        const error = await app.setBodyPart("BBBBB0", "unassigned").catch((reason: unknown) => reason);
        assert.equal((error as { code?: string }).code, "NOT_SUPPORTED");
    });
});

// wired tracker (MC2B) used over BLE
function wiredIdentity(options: { calibration?: boolean } = {}): Array<[BleCharacteristic, Uint8Array]> {
    const frames: Array<[BleCharacteristic, Uint8Array]> = [
        ["serial-number", hex("303030303032310000000000")],
        ["software-revision", hex("312e372e31300000000000000000")],
        ["number-of-imu", byte(6)],
        ["model-number", hex("4d43324200000000")],
        ["magnetometer", hex("0000000000000000")],
        ["sensor-mode", byte(8)],
        ["fps", byte(2)],
        ["tof", byte(0)],
        ["battery-level", byte(0x41)],
        ["battery-voltage", hex("100f")],
        ["charge-status", byte(0)],
    ];
    if (options.calibration !== false) frames.push(["wired-auto-calibration", byte(7)]);

    return frames;
}

async function connectedWired(options: { calibration?: boolean } = {}) {
    const backend = new FakeBleBackend();
    backend.peripherals[0] = { id: "ble-1", localName: "HaritoraX1.1B-0000021", rssi: -60 };

    const connection = new BleConnection(backend, { scanTimeoutMs: 1 });
    const app = createHaritoraX({ connections: [connection], logLevel: "silent" });

    backend.onOpen = () => {
        for (const [characteristic, data] of wiredIdentity(options)) backend.emit("ble-1", characteristic, data);
    };

    await app.discover();
    await app.connect("ble-1");

    return { app, backend };
}

// 6 IMUs of 14 bytes, then the two range values when the range sensor is on
function wiredSensorFrame(ranges?: [number, number], padTo = 0): Uint8Array {
    const frame = new Uint8Array(Math.max(padTo, 6 * 14 + (ranges ? 4 : 0)));
    for (let index = 0; index < 6; index++) frame.set(SINGLE_IMU, index * 14);
    if (ranges) {
        const view = new DataView(frame.buffer);
        view.setUint16(84, ranges[0], true);
        view.setUint16(86, ranges[1], true);
    }

    return frame;
}

// a serial connection with one wired tracker on COM9, the way a Bluetooth Classic SPP port shows up
function wiredSerialStub() {
    const writes: string[] = [];
    let handler: ((frame: Frame) => void) | undefined;
    const connection: Connection = {
        kind: "serial",
        list: () =>
            Promise.resolve([{ id: "COM9", connection: "serial", displayName: "HaritoraX Wired (COM9)", model: "wired" }]),
        open: () => Promise.resolve(),
        close: () => Promise.resolve(),
        write: (_endpointId, data) => {
            writes.push(String.fromCharCode(...data));
            return Promise.resolve();
        },
        onData: (onFrame) => {
            handler = onFrame;
            return () => undefined;
        },
        onLost: () => () => undefined,
        dispose: () => Promise.resolve(),
    };

    return { connection, writes, emit: (text: string) => handler?.({ endpointId: "COM9", data: bytes(text) }) };
}

describe("wired tracker over BLE", () => {
    it("recognises the wired tracker names and characteristics", () => {
        assert.deepEqual(parseBleDeviceName("HaritoraX1.1B-0000021"), {
            model: "wired",
            localName: "HaritoraX1.1B-0000021",
        });
        assert.equal(parseBleDeviceName("HaritoraX1.1-0000003")?.model, "wired");
        assert.equal(parseBleDeviceName("HaritoraX-0000001")?.model, "wired");
        assert.equal(parseBleDeviceName("HaritoraXW-AAAAA7")?.model, "wireless");
        assert.equal(parseBleDeviceName("HaritoraX1.1B-"), undefined);

        assert.equal(bleCharacteristicFromUuid("ef844766-90a9-11ed-a1eb-0242ac120002"), "sensor-data-control");
        assert.equal(bleCharacteristicFromUuid("ef844900-90a9-11ed-a1eb-0242ac120002"), "wired-auto-calibration");
    });

    it("registers the tracker from its device information", async () => {
        const { app } = await connectedWired();

        const device = app.getDevice("0000021");
        assert.equal(device?.model, "wired");
        assert.equal(device?.version, "1.7.10");
        assert.equal(device?.connection, "ble");
        assert.equal(device?.imuCount, 6);
        assert.deepEqual(
            device?.trackers.map((tracker) => tracker.bodyPart),
            ["chest", "leftKnee", "leftAnkle", "rightKnee", "rightAnkle", "hip"],
        );
        assert.deepEqual(device?.settings, {
            sensorMode: 2,
            fpsMode: 100,
            sensorAutoCorrection: ["accel", "gyro", "mag"],
            ankleMotionDetection: false,
        });
        assert.equal(device?.battery?.level, 65);
        assert.equal(device?.battery?.voltage, 3856);
        assert.equal(device?.battery?.chargeStatus, "discharging");
    });

    it("starts the sensor data after connecting, which only wired trackers need", async () => {
        const { backend } = await connectedWired();
        assert.deepEqual(
            backend.writes.filter((write) => write.characteristic === "sensor-data-control"),
            [{ endpointId: "ble-1", characteristic: "sensor-data-control", data: [1] }],
        );

        const hx2 = await connected();
        assert.deepEqual(
            hx2.backend.writes.filter((write) => write.characteristic === "sensor-data-control"),
            [],
        );
    });

    it("emits a single-role sample per IMU, with no range while the range sensor is off", async () => {
        const { app, backend } = await connectedWired();

        const samples: Array<{ trackerId: string; bodyPart: string; role: string; range?: number }> = [];
        app.on("imu", (sample) => samples.push(sample));

        backend.emit("ble-1", "sensor", wiredSensorFrame());
        assert.deepEqual(
            samples.map((sample) => [sample.trackerId, sample.bodyPart, sample.role]),
            [
                ["0000021:0", "chest", "single"],
                ["0000021:1", "leftKnee", "single"],
                ["0000021:2", "leftAnkle", "single"],
                ["0000021:3", "rightKnee", "single"],
                ["0000021:4", "rightAnkle", "single"],
                ["0000021:5", "hip", "single"],
            ],
        );
        assert.ok(samples.every((sample) => sample.range === undefined));

        // a notification can be longer than the frame, like the 116 bytes the characteristic holds. The extra bytes aren't range
        samples.length = 0;
        backend.emit("ble-1", "sensor", wiredSensorFrame(undefined, 116));
        assert.equal(samples.length, 6);
        assert.ok(samples.every((sample) => sample.range === undefined));
    });

    it("reads the ankle range while the range sensor is on", async () => {
        const { app, backend } = await connectedWired();
        backend.emit("ble-1", "tof", byte(1));

        const ranges: Array<[string, number | undefined]> = [];
        app.on("imu", (sample) => ranges.push([sample.bodyPart, sample.range]));

        backend.emit("ble-1", "sensor", wiredSensorFrame([700, 1200]));
        assert.deepEqual(
            ranges.filter(([, range]) => range !== undefined),
            [
                ["leftAnkle", 700],
                ["rightAnkle", 1200],
            ],
        );
    });

    it("reads the magnetometer status from ASCII digits and ignores bytes that aren't digits", async () => {
        const { app, backend } = await connectedWired();

        const mags: string[] = [];
        app.on("mag", (event) => mags.push(`${event.trackerId}:${event.status}`));

        // before streaming the characteristic holds zeros, which aren't a reading
        backend.emit("ble-1", "magnetometer", hex("0000000000000000"));
        assert.deepEqual(mags, []);

        backend.emit("ble-1", "magnetometer", bytes("01230123"));
        assert.deepEqual(mags, [
            "0000021:0:veryBad",
            "0000021:1:bad",
            "0000021:2:okay",
            "0000021:3:great",
            "0000021:4:veryBad",
            "0000021:5:bad",
        ]);

        assert.equal(bleWiredMagStatusAt(bytes("3"), 0), "great");
        assert.equal(bleWiredMagStatusAt(bytes("4"), 0), undefined);
        assert.equal(bleWiredMagStatusAt(bytes("0"), 1), undefined);
    });

    it("maps the left and right buttons and ignores the power button", async () => {
        const { app, backend } = await connectedWired();

        const buttons: string[] = [];
        app.on("button", (event) => buttons.push(event.button));

        // nothing was pressed yet: the event type is ff
        backend.emit("ble-1", "secondary-button", hex("ffffffffff"));
        backend.emit("ble-1", "tertiary-button", hex("ffffffffff"));
        assert.deepEqual(buttons, []);

        // [u32 start time][event type], the power button is the first one
        backend.emit("ble-1", "main-button", hex("e803000000"));
        backend.emit("ble-1", "secondary-button", hex("e803000000"));
        backend.emit("ble-1", "tertiary-button", hex("d007000000"));
        assert.deepEqual(buttons, ["main", "sub"]);
    });

    it("writes the settings to the wired characteristics", async () => {
        const { app, backend } = await connectedWired();
        backend.writes.length = 0;

        await app.setSettings("0000021", {
            sensorMode: 1,
            fpsMode: 50,
            sensorAutoCorrection: ["accel", "mag"],
            ankleMotionDetection: true,
        });

        assert.deepEqual(
            backend.writes.map((write) => [write.characteristic, write.data]),
            [
                ["sensor-mode", [5]],
                ["fps", [1]],
                ["wired-auto-calibration", [5]],
                ["tof", [1]],
            ],
        );
    });

    it("skips the calibration write when the tracker has no such characteristic", async () => {
        const { app, backend } = await connectedWired({ calibration: false });
        assert.equal(app.getDevice("0000021")?.settings, undefined);
        backend.writes.length = 0;

        await app.setSettings("0000021", {
            sensorMode: 2,
            fpsMode: 100,
            sensorAutoCorrection: [],
            ankleMotionDetection: false,
        });

        assert.deepEqual(
            backend.writes.map((write) => write.characteristic),
            ["sensor-mode", "fps", "tof"],
        );
    });

    it("uses the range bytes only when told they are there", () => {
        const frame = wiredSensorFrame([700, 1200], 116);

        assert.equal(splitWiredImuBytes(frame, 6, false)[2]?.range, undefined);
        assert.equal(splitWiredImuBytes(frame, 6, true)[2]?.range, 700);
        assert.equal(splitWiredImuBytes(frame, 6, true)[4]?.range, 1200);
        // with nothing said the length decides, like it does for the text frames
        assert.equal(splitWiredImuBytes(wiredSensorFrame(), 6)[2]?.range, undefined);
        assert.deepEqual(splitWiredImuBytes(new Uint8Array(20), 6), []);
    });

    it("uses BLE only when it sees the wired tracker, and keeps the serial port when it doesn't", async () => {
        const stub = wiredSerialStub();
        const backend = new FakeBleBackend();
        backend.peripherals[0] = { id: "ble-1", localName: "HaritoraX1.1B-0000021", rssi: -60 };
        const app = createHaritoraX({
            connections: [stub.connection, new BleConnection(backend, { scanTimeoutMs: 1 })],
            logLevel: "silent",
        });

        // the wired tracker is on Bluetooth Classic and advertises over BLE as well
        assert.deepEqual(
            (await app.discover()).map((endpoint) => endpoint.id),
            ["ble-1"],
        );
        await assert.rejects(app.connect("COM9"), (error: { code?: string }) => error.code === "DEVICE_NOT_FOUND");

        // nothing on BLE: the serial port is all there is
        backend.peripherals[0] = { id: "other", localName: "JBL Flip 4", rssi: -80 };
        assert.deepEqual(
            (await app.discover()).map((endpoint) => endpoint.id),
            ["COM9"],
        );
    });

    it("doesn't drop a wired serial port that is already connected", async () => {
        const stub = wiredSerialStub();
        const backend = new FakeBleBackend();
        backend.peripherals.length = 0;
        const app = createHaritoraX({
            connections: [stub.connection, new BleConnection(backend, { scanTimeoutMs: 1 })],
            logLevel: "silent",
        });

        await app.discover();
        await app.connect("COM9");

        backend.peripherals.push({ id: "ble-1", localName: "HaritoraX1.1B-0000021", rssi: -60 });
        assert.deepEqual((await app.discover()).map((endpoint) => endpoint.id).sort(), ["COM9", "ble-1"]);
    });

    it("keeps text commands off the BLE endpoint when a serial wired tracker changes settings", async () => {
        const stub = wiredSerialStub();
        const backend = new FakeBleBackend();
        backend.peripherals.length = 0;
        backend.onOpen = () => {
            for (const [characteristic, data] of wiredIdentity()) backend.emit("ble-1", characteristic, data);
        };
        const app = createHaritoraX({
            connections: [stub.connection, new BleConnection(backend, { scanTimeoutMs: 1 })],
            logLevel: "silent",
        });

        // a serial session that is already running when a wired tracker shows up over BLE
        await app.discover();
        await app.connect("COM9");
        stub.emit('s:{"imu_mode":1,"imu_num":5,"magf_status":"33333"}');
        stub.emit('i:{"model":"MC2","version":"1.7.8","serial no":"0000003"}');

        backend.peripherals.push({ id: "ble-1", localName: "HaritoraX1.1B-0000021", rssi: -60 });
        await app.discover();
        await app.connect("ble-1");
        assert.equal(app.getDevice("0000003")?.connection, "serial");
        assert.equal(app.getDevice("0000021")?.connection, "ble");
        backend.writes.length = 0;

        await app.setSettings("0000003", {
            sensorMode: 1,
            fpsMode: 100,
            sensorAutoCorrection: [],
            ankleMotionDetection: false,
        });

        assert.ok(stub.writes.length > 0);
        assert.deepEqual(backend.writes, []);
        // the BLE tracker was not written to, so its settings are not claimed as applied
        assert.equal(app.getDevice("0000021")?.settings?.fpsMode, 100);
        assert.equal(app.getDevice("0000021")?.settings?.sensorAutoCorrection.length, 3);
    });
});
