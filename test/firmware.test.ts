import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    baseLockRemovedIn,
    bodyPartBaseLocked,
    bodyPartNeedsUnlock,
    bodyPartNotifies,
    commandHoldMs,
    compareFirmwareVersions,
    dongleMayDropCommands,
    dongleReportsAccelAccuracy,
    factoryAttachPoint,
    firmwareAtLeast,
    hasSensor2,
    parseFirmwareVersion,
} from "../dist/protocol/firmware.js";

describe("firmware versions", () => {
    it("parses versions and ignores anything that isn't one", () => {
        assert.deepEqual(parseFirmwareVersion("1.0.26"), { major: 1, minor: 0, patch: 26 });
        assert.deepEqual(parseFirmwareVersion(" v1.1.1\n"), { major: 1, minor: 1, patch: 1 });
        assert.equal(parseFirmwareVersion(""), undefined);
        assert.equal(parseFirmwareVersion(undefined), undefined);
        assert.equal(parseFirmwareVersion("7.2"), undefined);
    });

    it("compares numerically, not as text", () => {
        const parse = (text: string) => parseFirmwareVersion(text)!;
        assert.ok(compareFirmwareVersions(parse("1.0.30"), parse("1.0.5")) > 0);
        assert.ok(compareFirmwareVersions(parse("1.0.28"), parse("1.1.1")) < 0);
        assert.ok(compareFirmwareVersions(parse("2.0.0"), parse("1.99.99")) > 0);
        assert.equal(compareFirmwareVersions(parse("1.1.1"), parse("1.1.1")), 0);
    });

    it("answers undefined instead of guessing when the version is unknown", () => {
        assert.equal(firmwareAtLeast("1.0.30", "1.0.28"), true);
        assert.equal(firmwareAtLeast("1.0.22", "1.0.28"), false);
        assert.equal(firmwareAtLeast("1.0.28", "1.0.28"), true);
        assert.equal(firmwareAtLeast(undefined, "1.0.28"), undefined);
        assert.equal(firmwareAtLeast("", "1.0.28"), undefined);
    });
});

describe("firmware rules", () => {
    it("knows which dongles report accel accuracy", () => {
        assert.equal(dongleReportsAccelAccuracy("1.1.1"), true);
        assert.equal(dongleReportsAccelAccuracy("1.0.29"), true);
        assert.equal(dongleReportsAccelAccuracy("1.0.28"), false);
        assert.equal(dongleReportsAccelAccuracy("1.0.26"), false);
        assert.equal(dongleReportsAccelAccuracy(undefined), undefined);
    });

    it("holds commands longer for trackers that need to see them several times", () => {
        assert.equal(commandHoldMs("1.0.28"), 150);
        assert.equal(commandHoldMs("1.0.5"), 150);
        assert.equal(commandHoldMs("1.1.1"), 600);
        // not knowing is the safe side, it only costs time
        assert.equal(commandHoldMs(undefined), 600);

        assert.equal(commandHoldMs("1.0.28"), 150);
    });

    it("warns only when the tracker needs repeats and the dongle won't repeat", () => {
        assert.equal(dongleMayDropCommands("1.1.1", "1.0.29"), true);
        assert.equal(dongleMayDropCommands("1.1.1", "1.1.1"), false);
        assert.equal(dongleMayDropCommands("1.0.28", "1.0.29"), false);
        // unknown versions don't trigger the warning
        assert.equal(dongleMayDropCommands(undefined, "1.0.29"), false);
        assert.equal(dongleMayDropCommands("1.1.1", undefined), false);
    });

    it("knows which trackers have sensor2", () => {
        assert.equal(hasSensor2("x2", "1.0.1"), true);
        assert.equal(hasSensor2("x2", "1.0.5"), true);
        assert.equal(hasSensor2("x2", "1.1.1"), true);
        assert.equal(hasSensor2("wireless", "1.0.28"), true);
        assert.equal(hasSensor2("wireless", "1.0.26"), true);
        assert.equal(hasSensor2("wireless", "1.0.25"), false);
        assert.equal(hasSensor2("wireless", "1.0.22"), false);
        // an unknown version has to be worked out from the traffic
        assert.equal(hasSensor2("x2", undefined), false);
        assert.equal(hasSensor2("wired", "1.7.8"), false);
    });

    it("knows how a tracker takes its body part", () => {
        // HX2 applies a change directly before 1.0.14, HXW before 1.0.27. Newer builds want the 0A 1F <id> 00 sequence
        assert.equal(bodyPartNeedsUnlock("x2", "1.0.5"), false);
        assert.equal(bodyPartNeedsUnlock("x2", "1.0.10"), false);
        assert.equal(bodyPartNeedsUnlock("x2", "1.0.14"), true);
        assert.equal(bodyPartNeedsUnlock("x2", "1.0.30"), true);
        assert.equal(bodyPartNeedsUnlock("wireless", "1.0.26"), false);
        assert.equal(bodyPartNeedsUnlock("wireless", "1.0.27"), true);
        assert.equal(bodyPartNeedsUnlock("wireless", "1.0.22"), false);
        assert.equal(bodyPartNeedsUnlock("wireless", "1.0.28"), true);
        // an unknown version can't tell which path is safe, so the caller has to refuse
        assert.equal(bodyPartNeedsUnlock("wireless", undefined), undefined);
        assert.equal(bodyPartNeedsUnlock("x2", undefined), undefined);
        assert.equal(bodyPartNeedsUnlock("x2", ""), undefined);

        assert.equal(bodyPartNotifies("x2", "1.0.30"), true);
        assert.equal(bodyPartNotifies("wireless", "1.0.27"), true);
        assert.equal(bodyPartNotifies("wireless", "1.0.22"), false);
        assert.equal(bodyPartNotifies("wireless", undefined), true);
    });
});

describe("general firmware rules", () => {
    it("reads the factory body part from the last serial symbol", () => {
        assert.equal(factoryAttachPoint("C1HLW1"), 1);
        assert.equal(factoryAttachPoint("C1MGN3"), 3);
        assert.equal(factoryAttachPoint("C1M8W0"), 0);
        assert.equal(factoryAttachPoint("C1MGNJ"), 18);
        assert.equal(factoryAttachPoint("c1hlw1"), 1);
        assert.equal(factoryAttachPoint("C1HLWI"), undefined);
        assert.equal(factoryAttachPoint(""), undefined);
        assert.equal(factoryAttachPoint(undefined), undefined);
    });

    it("knows which tracker still refuses a body-part change because of its base", () => {
        // the HX2 trackers with a base here (1.0.5, chest and leg combo) are locked, an extra (serial ends in 0) never is
        assert.equal(bodyPartBaseLocked("x2", "1.0.5", "C1HLW1"), true);
        assert.equal(bodyPartBaseLocked("x2", "1.0.5", "C1MGN3"), true);
        assert.equal(bodyPartBaseLocked("x2", "1.0.5", "C1M8W0"), false);
        assert.equal(bodyPartBaseLocked("x2", "1.0.23", "C1HLW1"), true);
        assert.equal(bodyPartBaseLocked("x2", "1.0.24", "C1HLW1"), false);
        assert.equal(bodyPartBaseLocked("x2", "1.0.30", "C1HLW1"), false);

        assert.equal(bodyPartBaseLocked("wireless", "1.0.26", "A2E987"), true);
        assert.equal(bodyPartBaseLocked("wireless", "1.0.27", "A2E987"), true);
        assert.equal(bodyPartBaseLocked("wireless", "1.0.28", "A2E987"), false);
        assert.equal(bodyPartBaseLocked("wireless", "1.0.27", "A2E980"), false);

        // builds that were never checked answer unknown, not a guess
        assert.equal(bodyPartBaseLocked("wireless", "1.0.22", "A2E987"), true);
        assert.equal(bodyPartBaseLocked("x2", undefined, "C1HLW1"), undefined);
        assert.equal(bodyPartBaseLocked("x2", "1.0.30", undefined), undefined);
        assert.equal(bodyPartBaseLocked("wired", "1.7.8", "C1HLW1"), false);
    });

    it("names the first build without the base lock", () => {
        assert.equal(baseLockRemovedIn("x2"), "1.0.24");
        assert.equal(baseLockRemovedIn("wireless"), "1.0.28");
        assert.equal(baseLockRemovedIn("wired"), undefined);
    });
});
