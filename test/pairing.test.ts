import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { PairingTracker } from "../dist/core/pairing.js";

describe("pairing tracker", () => {
    it("settles a pending pairing", async () => {
        const tracker = new PairingTracker();
        const pending = tracker.wait("COM4", 1_000);

        assert.equal(tracker.has("COM4"), true);
        assert.equal(tracker.settle("COM4", "paired"), true);
        assert.equal(tracker.has("COM4"), false);
        assert.equal(await pending, "paired");
    });

    it("times out a pending pairing", async () => {
        mock.timers.enable({ apis: ["setTimeout"] });
        try {
            const tracker = new PairingTracker();
            const pending = tracker.wait("COM4", 10_000);

            mock.timers.tick(10_000);

            assert.equal(await pending, "timeout");
            assert.equal(tracker.has("COM4"), false);
        } finally {
            mock.timers.reset();
        }
    });

    it("cancels all pending pairings", async () => {
        const tracker = new PairingTracker();
        const first = tracker.wait("COM4", 1_000);
        const second = tracker.wait("COM5", 1_000);

        tracker.cancelAll();

        assert.deepEqual(await Promise.all([first, second]), ["cancelled", "cancelled"]);
        assert.equal(tracker.has("COM4"), false);
        assert.equal(tracker.has("COM5"), false);
    });
});
