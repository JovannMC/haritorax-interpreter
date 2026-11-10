import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeImuBytes } from "../dist/protocol/codec/imu.js";
import type { Quaternion, TrackerModel, Vector } from "../dist/types.js";

const G = 9.80665;
const identity: Quaternion = { x: 0, y: 0, z: 0, w: 1 };
const up: Vector = { x: 0, y: 1, z: 0 };
const front: Vector = { x: 0, y: 0, z: 1 };
const away: Vector = { x: 0, y: 0, z: -1 };

function multiply(a: Quaternion, b: Quaternion): Quaternion {
    return {
        x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
        y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
        z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
        w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    };
}

function conjugate(q: Quaternion): Quaternion {
    return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

function around(axis: "x" | "y" | "z", degrees: number): Quaternion {
    const halfAngle = (degrees * Math.PI) / 360;
    return { x: 0, y: 0, z: 0, w: Math.cos(halfAngle), [axis]: Math.sin(halfAngle) };
}

function rotate(q: Quaternion, v: Vector): Vector {
    const n = Math.hypot(q.x, q.y, q.z, q.w);
    const unit = { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
    const result = multiply(multiply(unit, { ...v, w: 0 }), conjugate(unit));
    return { x: result.x, y: result.y, z: result.z };
}

function closeVector(actual: Vector, expected: Vector, tolerance: number): void {
    assert.ok(
        Math.hypot(actual.x - expected.x, actual.y - expected.y, actual.z - expected.z) < tolerance,
        `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
    );
}

function frame(q: Quaternion, model: TrackerModel, linear: Vector = { x: 0, y: 0, z: 0 }): Uint8Array {
    const bytes = new Uint8Array(14);
    const view = new DataView(bytes.buffer);
    const gravity = rotate(conjugate(q), { x: 0, y: 0, z: G });
    const accelScale = model === "x2" ? 2048 / G : 256;
    for (const [i, value] of [q.x, q.y, q.z, q.w].entries()) view.setInt16(i * 2, Math.round(value * 16384), true);
    for (const [i, value] of [gravity.x + linear.x, gravity.y + linear.y, gravity.z + linear.z].entries())
        view.setInt16(8 + i * 2, Math.round(value * accelScale), true);
    return bytes;
}

const serverAxes = around("x", -90);

describe("normalized IMU case frame", () => {
    it("matches the physical front and top after SlimeVR's receiver conversion", () => {
        const poses = [
            { name: "face up", hxw: identity, hx2: identity, normal: up, top: away },
            { name: "upright front", hxw: around("x", 90), hx2: around("y", -90), normal: front, top: up },
            { name: "right side", hxw: around("y", 90), hx2: around("x", 90), normal: { x: 1, y: 0, z: 0 }, top: away },
            { name: "left side", hxw: around("y", -90), hx2: around("x", -90), normal: { x: -1, y: 0, z: 0 }, top: away },
        ];
        for (const pose of poses) {
            for (const [model, native] of [
                ["wireless", pose.hxw],
                ["x2", pose.hx2],
                ["wired", pose.hxw],
            ] as const) {
                const decoded = decodeImuBytes(frame(native, model), model);
                assert.ok(decoded, `${model}: ${pose.name}`);
                const received = multiply(serverAxes, decoded.rotation);
                closeVector(rotate(received, front), pose.normal, 0.0002);
                closeVector(rotate(received, up), pose.top, 0.0002);
                closeVector(decoded.acceleration, { x: 0, y: 0, z: 0 }, 0.01);
            }
        }
    });

    it("preserves yaw direction and emits acceleration consistent with the quaternion", () => {
        const q = multiply(around("z", 37), multiply(around("y", -21), around("x", 46)));
        const c = around("z", 90);
        const nativeHx2 = multiply(multiply(conjugate(c), q), c);
        const a = { x: 1.2, y: -2.3, z: 0.7 };
        const nativeHx2Acceleration = rotate(conjugate(c), a);
        for (const [model, native, linear] of [
            ["wireless", q, a],
            ["x2", nativeHx2, nativeHx2Acceleration],
            ["wired", q, a],
        ] as const) {
            const decoded = decodeImuBytes(frame(native, model, linear), model);
            assert.ok(decoded);
            closeVector(rotate(decoded.rotation, front), rotate(q, front), 0.0002);
            closeVector(decoded.acceleration, a, 0.01);
            closeVector(rotate(decoded.rotation, decoded.acceleration), rotate(q, a), 0.01);
            const yaw = decodeImuBytes(frame(around("z", 45), model), model);
            assert.ok(yaw);
            closeVector(rotate(yaw.rotation, { x: 1, y: 0, z: 0 }), { x: Math.SQRT1_2, y: Math.SQRT1_2, z: 0 }, 0.0002);
        }
    });

    it("reconstructs the clearer receiver photos and fixes the case top, not just agreement between models", () => {
        // SlimeVR raw readouts: XYZ components of a YZX Euler decomposition.
        // These photos include the previous SlimeTora HX2 alignment. Undo it,
        // and the legacy quaternion sign transform, to recover native Q14 input.
        const photos = [
            { id: 5497, model: "wireless", euler: [-79.48, -8.0, -3.52], normal: up, top: away },
            { id: 5498, model: "wireless", euler: [-166.84, -6.68, -0.7], normal: front, top: up },
            { id: 5499, model: "wireless", euler: [104.82, 153.9, 83.35], normal: { x: 1, y: 0, z: 0 }, top: away },
            { id: 5500, model: "wireless", euler: [27.13, 106.98, -80.9], normal: { x: -1, y: 0, z: 0 }, top: away },
            { id: 5502, model: "x2", euler: [-72.85, -7.39, -0.84], normal: up, top: away },
            { id: 5503, model: "x2", euler: [-164.85, -1.44, 0.74], normal: front, top: up },
            { id: 5504, model: "x2", euler: [-40.72, 40.35, -81.26], normal: { x: -1, y: 0, z: 0 }, top: away },
            { id: 5505, model: "x2", euler: [15.65, -116.48, 78.09], normal: { x: 1, y: 0, z: 0 }, top: away },
        ] as const;
        const legacySigns = around("z", 180);
        const hx2Alignment = around("z", 90);
        const maxAngle = (20 * Math.PI) / 180;
        for (const photo of photos) {
            const [x, y, z] = photo.euler;
            const observed = multiply(multiply(around("y", y), around("z", z)), around("x", x));
            let native = multiply(conjugate(serverAxes), observed);
            if (photo.model === "x2") native = multiply(multiply(conjugate(hx2Alignment), native), hx2Alignment);
            native = multiply(multiply(conjugate(legacySigns), native), legacySigns);
            const decoded = decodeImuBytes(frame(native, photo.model), photo.model);
            assert.ok(decoded);
            const received = multiply(serverAxes, decoded.rotation);
            for (const [axis, expected] of [
                [front, photo.normal],
                [up, photo.top],
            ]) {
                assert.ok(axis && expected);
                const actual = rotate(received, axis);
                const dot = actual.x * expected.x + actual.y * expected.y + actual.z * expected.z;
                assert.ok(dot > Math.cos(maxAngle), `IMG_${photo.id}: case axis misses physical pose`);
            }
            closeVector(decoded.acceleration, { x: 0, y: 0, z: 0 }, 0.01);
        }
    });
});
