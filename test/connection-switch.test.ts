import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fromByteArray } from "base64-js";
import { createHaritoraX } from "../dist/index.js";
import type { Connection, Frame } from "../dist/connections/contract.js";
import type { ConnectionKind, DisconnectReason, EndpointDescriptor } from "../dist/types.js";

class MemoryConnection implements Connection {
    readonly writes: Array<{ endpointId: string; characteristic?: string }> = [];
    readonly #data = new Set<(frame: Frame) => void>();
    readonly #lost = new Set<(endpointId: string, reason: DisconnectReason) => void>();
    readonly kind: ConnectionKind;
    readonly endpointId: string;

    constructor(kind: ConnectionKind, endpointId: string) {
        this.kind = kind;
        this.endpointId = endpointId;
    }

    list(): Promise<EndpointDescriptor[]> {
        return Promise.resolve([
            {
                id: this.endpointId,
                connection: this.kind,
                displayName: this.kind === "ble" ? "HaritoraX2-B1TEST" : this.endpointId,
                model: "x2",
            },
        ]);
    }
    open(): Promise<void> {
        return Promise.resolve();
    }
    close(): Promise<void> {
        return Promise.resolve();
    }
    write(endpointId: string, _data: Uint8Array, options?: { characteristic?: string }): Promise<void> {
        this.writes.push({ endpointId, characteristic: options?.characteristic });
        return Promise.resolve();
    }
    onData(handler: (frame: Frame) => void) {
        this.#data.add(handler);
        return () => {
            this.#data.delete(handler);
        };
    }
    onLost(handler: (endpointId: string, reason: DisconnectReason) => void) {
        this.#lost.add(handler);
        return () => {
            this.#lost.delete(handler);
        };
    }
    onRssi() {
        return () => {};
    }
    dispose(): Promise<void> {
        this.#data.clear();
        this.#lost.clear();
        return Promise.resolve();
    }
    emit(data: string | Uint8Array, characteristic?: string): void {
        const frame = {
            endpointId: this.endpointId,
            data: typeof data === "string" ? new TextEncoder().encode(data) : data,
            characteristic,
        };
        for (const handler of this.#data) handler(frame);
    }
    lose(): void {
        for (const handler of this.#lost) handler(this.endpointId, "remote");
    }
}

const LEG = Uint8Array.of(0x94, 0x00, 0xfe, 0x01, 0xc0, 0x08, 0x5d, 0x3f, 0x7d, 0xff, 0x3c, 0x00, 0xfc, 0x07);
const info = (count: number, serial = "B1TEST") =>
    `i0:${JSON.stringify({ version: "1.0.5", model: "mc4b", imu_num: count, "serial no": serial })}`;
function sensor(count: number): Uint8Array {
    const data = new Uint8Array(count === 2 ? 30 : 16);
    data.set(LEG);
    data[14] = 2;
    if (count === 2) data.set(LEG, 16);
    return data;
}
async function session(count: number) {
    const serial = new MemoryConnection("serial", "COM4");
    const ble = new MemoryConnection("ble", "ble-1");
    const app = createHaritoraX({ connections: [serial, ble], logLevel: "silent" });
    await app.discover();
    await app.connect("COM4");
    serial.emit(info(count));
    const serialSample = () => serial.emit(`x0:${fromByteArray(sensor(count))}`);
    const bleSample = () => ble.emit(sensor(count), "sensor2");
    serialSample();
    await app.connect("ble-1");
    const bleInfo = () => {
        ble.emit("B1TEST", "serial-number");
        ble.emit("1.0.30", "software-revision");
        ble.emit(Uint8Array.of(count), "number-of-imu");
        ble.emit("MC4B", "model-number");
        ble.emit(Uint8Array.of(3), "body-part");
    };
    bleInfo();
    return { app, serial, ble, serialSample, bleSample, bleInfo };
}
function assertConnection(
    app: ReturnType<typeof createHaritoraX>,
    connection: ConnectionKind,
    endpointId: string,
    count: number,
) {
    const device = app.getDevice("B1TEST");
    assert.ok(device);
    assert.equal(device.connection, connection);
    assert.equal(device.endpointId, endpointId);
    assert.equal(device.trackers.length, count);
    assert.ok(device.trackers.every((tracker) => tracker.connected && tracker.endpointId === endpointId));
}

describe("tracker connection swaps", () => {
    for (const count of [1, 2]) {
        it(`keeps ${count} IMU(s) on BLE after stale dongle info, RSSI and disconnect`, async () => {
            const { app, serial, ble, bleSample } = await session(count);
            try {
                bleSample();
                assertConnection(app, "ble", "ble-1", count);
                const lost: string[] = [];
                const reconnected: string[] = [];
                app.on("tracker:disconnected", ({ deviceId, trackerId }) => {
                    if (deviceId === "B1TEST") lost.push(trackerId);
                });
                app.on("tracker:connected", ({ deviceId, trackerId }) => {
                    if (deviceId === "B1TEST") reconnected.push(trackerId);
                });
                for (let i = 0; i < 5; i++) {
                    serial.emit(info(count));
                    serial.emit("a0:7f7f7f7f7f7f");
                    bleSample();
                    assertConnection(app, "ble", "ble-1", count);
                }
                serial.emit(info(1, "OTHER1"));
                assertConnection(app, "ble", "ble-1", count);
                await app.disconnect("COM4");
                assertConnection(app, "ble", "ble-1", count);
                assert.deepEqual(lost, []);
                assert.deepEqual(reconnected, []);
                serial.writes.length = 0;
                ble.writes.length = 0;
                await app.setSettings("B1TEST", {
                    sensorMode: 2,
                    fpsMode: 50,
                    sensorAutoCorrection: [],
                    ankleMotionDetection: false,
                });
                assert.equal(serial.writes.length, 0);
                assert.ok(ble.writes.length > 0 && ble.writes.every((write) => write.endpointId === "ble-1"));
            } finally {
                await app.dispose();
            }
        });

        it(`moves ${count} IMU(s) back to serial on data and ignores old BLE metadata/loss`, async () => {
            const { app, serial, ble, serialSample, bleSample, bleInfo } = await session(count);
            try {
                bleSample();
                serial.emit(info(count));
                serialSample();
                assertConnection(app, "serial", "COM4", count);
                const lost: string[] = [];
                app.on("tracker:disconnected", ({ deviceId, trackerId }) => {
                    if (deviceId === "B1TEST") lost.push(trackerId);
                });
                bleInfo();
                ble.emit(Uint8Array.of(80), "battery-level");
                assertConnection(app, "serial", "COM4", count);
                ble.lose();
                assertConnection(app, "serial", "COM4", count);
                assert.deepEqual(lost, []);
                serial.emit("a0:7f7f7f7f7f7f");
                assert.deepEqual(
                    lost,
                    Array.from({ length: count }, (_, index) => `B1TEST:${index}`),
                );
                assert.ok(app.getDevice("B1TEST")?.trackers.every((tracker) => !tracker.connected));
                serialSample();
                assertConnection(app, "serial", "COM4", count);
            } finally {
                await app.dispose();
            }
        });

        it(`rejects malformed frames from the inactive source with ${count} IMU(s)`, async () => {
            const { app, serial, ble, serialSample, bleSample } = await session(count);
            try {
                bleSample();
                serial.emit("x0:AA==");
                assertConnection(app, "ble", "ble-1", count);
                serialSample();
                ble.emit(Uint8Array.of(1, 2, 3), "sensor2");
                ble.emit(Uint8Array.of(1, 2, 3), "sensor");
                assertConnection(app, "serial", "COM4", count);
            } finally {
                await app.dispose();
            }
        });
    }

    it("does not revive a lost serial device from invalid RSSI counters", async () => {
        const { app, serial, serialSample } = await session(2);
        try {
            assertConnection(app, "serial", "COM4", 2);
            serial.emit("a0:7f7f7f7f7f7f");
            const reconnected: string[] = [];
            app.on("tracker:connected", ({ trackerId }) => reconnected.push(trackerId));
            for (const payload of ["", "2842", "2259224cd0c9", "284128440030"]) {
                serial.emit(`a0:${payload}`);
            }
            assert.ok(app.getDevice("B1TEST")?.trackers.every((tracker) => !tracker.connected));
            assert.deepEqual(reconnected, []);
            serialSample();
            assertConnection(app, "serial", "COM4", 2);
        } finally {
            await app.dispose();
        }
    });

    it("invalidates the BLE cache after the serial owner disconnects and the device is recreated", async () => {
        const { app, serialSample, bleSample } = await session(2);
        try {
            bleSample();
            const original = app.getDevice("B1TEST");
            serialSample();
            await app.disconnect("COM4");
            assert.equal(app.getDevice("B1TEST"), undefined);
            bleSample();
            assert.notEqual(app.getDevice("B1TEST"), original);
            assertConnection(app, "ble", "ble-1", 2);
        } finally {
            await app.dispose();
        }
    });
});
