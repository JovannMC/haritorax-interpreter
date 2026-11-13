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

    it("preserves a large backlog across compaction and subsequent writes", async () => {
        let releaseFirst: (() => void) | undefined;
        const written: string[] = [];
        const sink = new Writable({
            highWaterMark: 1,
            write(chunk, _encoding, callback) {
                written.push(String(chunk));
                if (written.length === 1) releaseFirst = callback;
                else callback();
            },
        });
        const failures: unknown[] = [];
        const output = new TraceOutput([sink], [], (error) => failures.push(error));
        const lines = Array.from({ length: 5000 }, (_, index) => `line ${index}`);

        output.write("start");
        for (const line of lines) output.write(line);
        releaseFirst?.();
        await output.flush();
        output.write("after");
        await output.flush();

        assert.deepEqual(written, ["start\n", ...lines.map((line) => `${line}\n`), "after\n"]);
        assert.deepEqual(failures, []);
        sink.end();
    });

    it("accounts for UTF-8 bytes while routing queued output", async () => {
        let releaseFirst: (() => void) | undefined;
        const stdout: string[] = [];
        const stderr: string[] = [];
        const sink = new Writable({
            highWaterMark: 1,
            write(chunk, _encoding, callback) {
                stdout.push(String(chunk));
                if (stdout.length === 1) releaseFirst = callback;
                else callback();
            },
        });
        const errorSink = new Writable({
            write(chunk, _encoding, callback) {
                stderr.push(String(chunk));
                callback();
            },
        });
        const failures: unknown[] = [];
        const output = new TraceOutput([sink], [errorSink], (error) => failures.push(error), 6);

        output.write("go");
        output.write("\u00e9");
        output.write("ok", true);
        output.write("no");
        releaseFirst?.();
        await output.flush();
        output.write("\u00e9", true);
        await output.flush();

        assert.deepEqual(stdout.slice(0, 2), ["go\n", "\u00e9\n"]);
        assert.match(stdout[2]!, /Dropped 1 output line/);
        assert.equal(stdout.length, 3);
        assert.deepEqual(stderr, ["ok\n", "\u00e9\n"]);
        assert.deepEqual(failures, []);
        sink.end();
        errorSink.end();
    });

    for (const line of [
        "ascii",
        "\u00e9",
        "\u4e2d\u6587",
        "\ud83d\ude00",
        "\ud800",
        "\udc00",
        "e\u0301",
        "x".repeat(4095) + "\ud83d\ude00",
        "\ud800".repeat(5000),
        "x".repeat(20000),
    ]) {
        const label = line.length > 64 ? `${line.length} UTF-16 code units` : JSON.stringify(line);
        it(`preserves the exact UTF-8 queue limit for ${label}`, async () => {
            let releaseFirst: (() => void) | undefined;
            const written: string[] = [];
            const sink = new Writable({
                highWaterMark: 1,
                write(chunk, _encoding, callback) {
                    written.push(String(chunk));
                    if (written.length === 1) releaseFirst = callback;
                    else callback();
                },
            });
            const failures: unknown[] = [];
            const output = new TraceOutput(
                [sink],
                [],
                (error) => failures.push(error),
                new TextEncoder().encode(`${line}\n`).byteLength,
            );

            output.write("");
            output.write(line);
            output.write(line);
            releaseFirst?.();
            await output.flush();
            output.write(line);
            await output.flush();

            const encodedLine = new TextDecoder().decode(new TextEncoder().encode(`${line}\n`));
            assert.equal(written[1], encodedLine);
            assert.match(written[2]!, /Dropped 1 output line/);
            assert.equal(written[3], encodedLine);
            assert.equal(written.length, 4);
            assert.deepEqual(failures, []);
            sink.end();
        });
    }

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
