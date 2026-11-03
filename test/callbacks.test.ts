import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Emitter } from "../dist/lib/emitter.js";
import { Logger } from "../dist/lib/logging.js";

describe("callback safety", () => {
    it("reports rejected async event handlers without stopping synchronous listeners", async () => {
        const emitter = new Emitter();
        const failures: string[] = [];
        let laterListenerRan = false;
        emitter.setErrorHandler((event, error) => failures.push(`${event}:${String(error)}`));
        emitter.on("log", async () => {
            throw new Error("async listener failed");
        });
        emitter.on("log", () => {
            laterListenerRan = true;
        });

        emitter.emit("log", { level: "info", message: "test", timestamp: 0 });
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(laterListenerRan, true);
        assert.deepEqual(failures, ["log:Error: async listener failed"]);
    });

    it("isolates error handlers that themselves throw", async () => {
        const emitter = new Emitter();
        let laterListenerRan = false;
        emitter.setErrorHandler(() => {
            throw new Error("reporter failed");
        });
        emitter.on("log", () => {
            throw new Error("listener failed");
        });
        emitter.on("log", async () => {
            throw new Error("async listener failed");
        });
        emitter.on("log", () => {
            laterListenerRan = true;
        });

        assert.doesNotThrow(() => emitter.emit("log", { level: "info", message: "test", timestamp: 0 }));
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(laterListenerRan, true);
    });

    it("isolates throwing and rejecting log sinks and reports their errors", async () => {
        const logger = new Logger("info");
        const failures: string[] = [];
        let laterSinkRan = false;
        logger.setErrorHandler((error) => failures.push(String(error)));
        logger.onEntry(() => {
            throw new Error("sync sink failed");
        });
        logger.onEntry(async () => {
            throw new Error("async sink failed");
        });
        logger.onEntry(() => {
            laterSinkRan = true;
        });

        assert.doesNotThrow(() => logger.info("test"));
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(laterSinkRan, true);
        assert.deepEqual(failures, ["Error: sync sink failed", "Error: async sink failed"]);
    });

    it("does not recurse when a log sink error handler also fails", () => {
        const logger = new Logger("info");
        let laterSinkRan = false;
        logger.setErrorHandler(() => {
            throw new Error("error reporter failed");
        });
        logger.onEntry(() => {
            throw new Error("sink failed");
        });
        logger.onEntry(() => {
            laterSinkRan = true;
        });

        assert.doesNotThrow(() => logger.info("test"));
        assert.equal(laterSinkRan, true);
    });
});
