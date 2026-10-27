import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { DeviceRegistry, type DeviceRegistration } from "../dist/core/device-registry.js";
import { Emitter } from "../dist/lib/emitter.js";
import { Logger } from "../dist/lib/logging.js";
import type { TrackerSettings } from "../dist/types.js";

function create() {
    const emitter = new Emitter();
    const registry = new DeviceRegistry({ emitter, log: new Logger("silent") });
    return { emitter, registry };
}

function registration(overrides: Partial<DeviceRegistration> = {}): DeviceRegistration {
    return {
        deviceId: "AAAAA7",
        endpointId: "COM4",
        slot: "0",
        model: "wireless",
        firmwareModel: "mc3s",
        version: "1.0.22",
        reportedImuCount: 1,
        connection: "serial",
        parts: ["unassigned"],
        ...overrides,
    };
}

describe("device registry", () => {
    it("grows the tracker list without recreating the device", () => {
        const { emitter, registry } = create();
        const device = registry.register(registration());
        const first = device.trackers[0];
        assert.ok(first);

        const connected: string[] = [];
        const identified: string[] = [];
        emitter.on("tracker:connected", ({ trackerId }) => connected.push(trackerId));
        emitter.on("identified", ({ trackerId, bodyPart }) => identified.push(`${trackerId}:${bodyPart}`));

        registry.setTrackers("AAAAA7", ["leftAnkle", "leftKnee"]);

        const updated = registry.getDevice("AAAAA7");
        assert.ok(updated);
        assert.equal(updated, device);
        assert.equal(updated.trackers[0], first);
        assert.equal(updated.imuCount, 2);
        assert.deepEqual(connected, ["AAAAA7:1"]);
        assert.deepEqual(identified, ["AAAAA7:0:leftAnkle"]);
        assert.equal(registry.getBodyPart("AAAAA7:0"), "leftAnkle");
        assert.equal(registry.getBodyPart("AAAAA7:1"), "leftKnee");
    });

    it("shrinks the tracker list and disconnects the removed tracker", () => {
        const { emitter, registry } = create();
        registry.register(registration({ reportedImuCount: 2, parts: ["leftAnkle", "leftKnee"] }));

        const disconnected: string[] = [];
        emitter.on("tracker:disconnected", ({ trackerId, reason }) => disconnected.push(`${trackerId}:${reason}`));

        registry.setTrackers("AAAAA7", ["leftAnkle"]);

        const device = registry.getDevice("AAAAA7");
        assert.ok(device);
        assert.equal(device.imuCount, 1);
        assert.deepEqual(
            device.trackers.map((tracker) => tracker.trackerId),
            ["AAAAA7:0"],
        );
        assert.deepEqual(disconnected, ["AAAAA7:1:requested"]);
        assert.equal(registry.getTracker("AAAAA7:1"), undefined);
    });

    it("updates body parts in place", () => {
        const { emitter, registry } = create();
        registry.register(registration());

        const identified: string[] = [];
        emitter.on("identified", ({ deviceId, trackerId, bodyPart }) => identified.push(`${deviceId}:${trackerId}:${bodyPart}`));

        registry.setTrackers("AAAAA7", ["chest"]);

        assert.equal(registry.getBodyPart("AAAAA7:0"), "chest");
        assert.deepEqual(identified, ["AAAAA7:AAAAA7:0:chest"]);
    });

    it("disconnects trackers before devices when an endpoint goes away", () => {
        const { emitter, registry } = create();
        registry.register(registration());
        registry.register(registration({ deviceId: "B1TEST", slot: "1" }));

        const order: string[] = [];
        emitter.on("tracker:disconnected", ({ trackerId }) => order.push(`tracker:${trackerId}`));
        emitter.on("device:disconnected", ({ deviceId }) => order.push(`device:${deviceId}`));
        emitter.on("devices", ({ devices }) => order.push(`devices:${devices.length}`));

        registry.removeDevicesAtEndpoint("COM4", "requested");

        assert.deepEqual(order, ["tracker:AAAAA7:0", "tracker:B1TEST:0", "device:AAAAA7", "device:B1TEST", "devices:0"]);
        assert.deepEqual(registry.listDevices(), []);
    });

    it("keeps one timer and refreshes it on each sample", () => {
        mock.timers.enable({ apis: ["setTimeout", "Date"] });
        try {
            const { emitter, registry } = create();
            registry.register(registration());

            const disconnected: string[] = [];
            emitter.on("tracker:disconnected", ({ trackerId, reason }) => disconnected.push(`${trackerId}:${reason}`));

            mock.timers.tick(5_000);
            registry.trackerSeen("AAAAA7:0");
            mock.timers.tick(5_000);
            assert.deepEqual(disconnected, []);

            mock.timers.tick(5_000);
            assert.deepEqual(disconnected, ["AAAAA7:0:timeout"]);
        } finally {
            mock.timers.reset();
        }
    });

    it("emits settings only when they change", () => {
        const { emitter, registry } = create();
        registry.register(registration());

        const events: TrackerSettings[] = [];
        emitter.on("settings", ({ settings }) => events.push(settings));

        const settings: TrackerSettings = {
            sensorMode: 1,
            fpsMode: 100,
            sensorAutoCorrection: ["accel", "gyro"],
            ankleMotionDetection: true,
        };

        registry.setSettings("AAAAA7", settings);
        // same values, different array order
        registry.setSettings("AAAAA7", { ...settings, sensorAutoCorrection: ["gyro", "accel"] });
        registry.setSettings("AAAAA7", { ...settings, fpsMode: 50 });

        assert.equal(events.length, 2);
        assert.deepEqual(events[0], settings);
        assert.equal(events[1]?.fpsMode, 50);
    });
});
