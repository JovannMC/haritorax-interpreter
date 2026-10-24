import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHaritoraX } from "../dist/index.js";
import { BleConnection, type BleBackend, type BlePeripheralSummary } from "../dist/connections/ble/index.js";
import type { ListOptions } from "../dist/connections/contract.js";
import {
    bleBodyPart,
    bleCharacteristicFromUuid,
    bleSettingValues,
    parseBleDeviceName,
    splitBleImu,
} from "../dist/protocol/ble.js";
import type { BleCharacteristic } from "../dist/protocol/ble.js";
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

// captured from a HaritoraX2-C1M8W0 (HaritoraX2-C1M8W0-read.txt)
const SINGLE_IMU = hex("9400fe01c0085d3f7dff3c00fc07");

class FakeBleBackend implements BleBackend {
    readonly peripherals: BlePeripheralSummary[] = [
        { id: "ble-1", localName: "HaritoraX2-C1M8W0", rssi: -52 },
        { id: "other", localName: "JBL Flip 4", rssi: -80 },
    ];
    readonly writes: Array<{ endpointId: string; characteristic: BleCharacteristic; data: number[] }> = [];
    readonly opened = new Set<string>();

    readonly #dataHandlers = new Set<(endpointId: string, characteristic: BleCharacteristic, data: Uint8Array) => void>();
    readonly #lostHandlers = new Set<(endpointId: string, reason: DisconnectReason) => void>();

    scan(_options?: ListOptions): Promise<BlePeripheralSummary[]> {
        return Promise.resolve(this.peripherals);
    }

    open(peripheralId: string): Promise<void> {
        this.opened.add(peripheralId);
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

    dispose(): Promise<void> {
        this.opened.clear();
        this.#dataHandlers.clear();
        this.#lostHandlers.clear();
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

function identityFrames(): Array<[BleCharacteristic, Uint8Array]> {
    return [
        ["serial-number", bytes("C1M8W0")],
        // v3 used the software revision (2a28) as the tracker version
        ["software-revision", bytes("1.0.30")],
        ["number-of-imu", byte(1)],
        ["model-number", bytes("MC4B")],
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

async function connected() {
    const backend = new FakeBleBackend();
    const connection = new BleConnection(backend, { scanTimeoutMs: 1 });
    const app = createHaritoraX({ connections: [connection], logLevel: "silent" });

    const infos: Array<{ deviceId: string; version: string; model: string; imuCount?: number }> = [];
    app.on("info", (event) => infos.push(event));

    await app.discover();
    await app.connect("ble-1");

    // the real backend reads these during open; the fake emits them once connected
    for (const [characteristic, data] of identityFrames()) backend.emit("ble-1", characteristic, data);

    return { app, backend, infos };
}

describe("BLE protocol", () => {
    it("parses HaritoraXW/HaritoraX2 local names", () => {
        assert.deepEqual(parseBleDeviceName("HaritoraX2-C1M8W0"), {
            model: "x2",
            localName: "HaritoraX2-C1M8W0",
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
    });

    it("slices single and dual IMU payloads like v3", () => {
        assert.equal(splitBleImu(SINGLE_IMU).length, 1);
        assert.deepEqual(
            splitBleImu(SINGLE_IMU).map((slice) => slice.role),
            ["ankle"],
        );

        const dual30 = new Uint8Array(30);
        dual30.set(SINGLE_IMU, 0);
        dual30.set(SINGLE_IMU, 14);
        const slices30 = splitBleImu(dual30);
        assert.equal(slices30.length, 2);
        assert.equal(slices30[0]?.payload.length, 14);
        assert.equal(slices30[1]?.payload.length, 15);
        assert.equal(slices30[1]?.role, "knee");

        const dual33 = new Uint8Array(33);
        dual33.set(SINGLE_IMU, 0);
        dual33.set(SINGLE_IMU, 18);
        const slices33 = splitBleImu(dual33);
        assert.equal(slices33.length, 2);
        assert.equal(slices33[1]?.payload.length, 14);
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
        assert.equal(found[0]?.displayName, "HaritoraX2-C1M8W0");
    });

    it("registers a device, trackers, settings and battery from initial reads", async () => {
        const { app, infos } = await connected();

        assert.equal(infos.length, 1);
        assert.equal(infos[0]?.deviceId, "C1M8W0");
        assert.equal(infos[0]?.version, "1.0.30");
        assert.equal(infos[0]?.model, "MC4B");
        assert.equal(infos[0]?.imuCount, 1);

        const device = app.getDevice("C1M8W0");
        assert.ok(device);
        assert.equal(device.model, "x2");
        assert.equal(device.connection, "ble");
        assert.equal(device.imuCount, 1);
        assert.deepEqual(
            device.trackers.map((tracker) => [tracker.trackerId, tracker.bodyPart]),
            [["C1M8W0:0", "leftElbow"]],
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

    it("emits IMU samples for single and dual payloads", async () => {
        const { app, backend } = await connected();

        const samples: Array<{ trackerId: string; role: string }> = [];
        app.on("imu", (sample) => samples.push({ trackerId: sample.trackerId, role: sample.role }));

        backend.emit("ble-1", "sensor", SINGLE_IMU);
        assert.deepEqual(samples, [{ trackerId: "C1M8W0:0", role: "ankle" }]);

        const dual = new Uint8Array(30);
        dual.set(SINGLE_IMU, 0);
        dual.set(SINGLE_IMU, 14);
        backend.emit("ble-1", "sensor", dual);

        assert.deepEqual(
            samples.map((sample) => [sample.trackerId, sample.role]),
            [
                ["C1M8W0:0", "ankle"],
                ["C1M8W0:0", "ankle"],
                ["C1M8W0:1", "knee"],
            ],
        );
        assert.equal(app.getTracker("C1M8W0:1")?.bodyPart, "unassigned");
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

        assert.deepEqual(mags, ["C1M8W0:0:great"]);
        assert.deepEqual(buttons, [{ deviceId: "C1M8W0", button: "sub" }]);
        assert.equal(app.getDevice("C1M8W0")?.battery?.level, 70);
        assert.equal(app.getDevice("C1M8W0")?.battery?.voltage, 4032);
    });

    it("writes BLE settings to the setting characteristics", async () => {
        const { app, backend } = await connected();

        const settings: TrackerSettings = {
            sensorMode: 1,
            fpsMode: 100,
            sensorAutoCorrection: ["accel", "gyro", "mag"],
            ankleMotionDetection: true,
        };
        await app.setSettings("C1M8W0", settings);

        assert.deepEqual(backend.writes, [
            { endpointId: "ble-1", characteristic: "sensor-mode", data: [5] },
            { endpointId: "ble-1", characteristic: "fps", data: [2] },
            { endpointId: "ble-1", characteristic: "auto-calibration", data: [7] },
            { endpointId: "ble-1", characteristic: "tof", data: [1] },
        ]);
        assert.deepEqual(app.getDevice("C1M8W0")?.settings, settings);
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
