import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { describe, it } from "node:test";
import { Writable } from "node:stream";
import { TraceOutput } from "../dist/lib/trace-output.js";

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
});
