import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { describe, it } from "node:test";
import { Writable } from "node:stream";
import { formatConnectionError, TraceOutput } from "../dist/lib/trace-output.js";

describe("trace output", () => {
    it("bounds queued output and reports dropped lines after writable backpressure", async () => {
        let releaseWrite: (() => void) | undefined;
        let text = "";
        const sink = new Writable({
            highWaterMark: 1,
            write(chunk, _encoding, callback) {
                text += String(chunk);
                releaseWrite = callback;
            },
        });
        const failures: unknown[] = [];
        const output = new TraceOutput(
            [sink],
            [],
            (error) => {
                failures.push(error);
            },
            8,
        );

        output.write("one");
        await setImmediate();
        output.write("two");
        output.write("three");
        releaseWrite?.();
        await setImmediate();
        releaseWrite?.();
        const flushing = output.flush();
        await setImmediate();
        releaseWrite?.();
        await flushing;

        assert.equal(text.includes("one\n"), true);
        assert.equal(text.includes("two\n"), true);
        assert.match(text, /Dropped 1 output line/);
        assert.deepEqual(failures, []);
        sink.end();
    });

    it("settles a blocked drain when the sink closes", async () => {
        const sink = new Writable({
            highWaterMark: 1,
            write(_chunk, _encoding, _callback) {},
        });
        const failures: unknown[] = [];
        const output = new TraceOutput([sink], [], (error) => failures.push(error), 1024, 100);
        output.write("blocked");
        await setImmediate();

        const flushing = output.flush();
        sink.destroy();
        await flushing;

        assert.equal(failures.length, 1);
        assert.match(String(failures[0]), /closed before draining/);
    });

    it("bounds a sink that never drains", async () => {
        const sink = new Writable({
            highWaterMark: 1,
            write(_chunk, _encoding, _callback) {},
        });
        const failures: unknown[] = [];
        const output = new TraceOutput([sink], [], (error) => failures.push(error), 1024, 10);
        output.write("blocked");

        await output.flush();

        assert.match(String(failures[0]), /Timed out waiting for trace output drain/);
        sink.destroy();
    });

    it("formats transport errors with their endpoint context", () => {
        assert.equal(
            formatConnectionError({
                connection: "ble",
                operation: "refresh",
                endpointId: "ble-1",
                characteristic: "battery-level",
                error: new Error("read failed"),
            }),
            "[ble] refresh failed (endpoint: ble-1, characteristic: battery-level): read failed",
        );
    });
});
