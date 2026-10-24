import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asciiDecode, parseIdentifier, parseLine } from "../dist/protocol/codec/framing.js";

describe("serial framing", () => {
    it("splits identifier from payload", () => {
        // Real line from testing/data/HaritoraX Wireless.txt
        const frame = parseLine(asciiEncode("X0:QAV1/Is6EBngAaf/bAkCAA=="));
        assert.equal(frame.identifier, "x0");
        assert.equal(frame.payload, "QAV1/Is6EBngAaf/bAkCAA==");
    });

    it("keeps colons inside a JSON payload", () => {
        const frame = parseLine(asciiEncode('i0:{"version":"1.0.22","model":"mc3s"}'));
        assert.equal(frame.identifier, "i0");
        assert.equal(frame.payload, '{"version":"1.0.22","model":"mc3s"}');
    });

    it("handles a bare request with an empty payload", () => {
        const frame = parseLine(asciiEncode("i:"));
        assert.equal(frame.identifier, "i");
        assert.equal(frame.payload, "");
    });

    it("handles a line with no colon", () => {
        const frame = parseLine(asciiEncode("DONGLE"));
        assert.equal(frame.identifier, "dongle");
        assert.equal(frame.payload, "");
    });

    it("lowercases only the identifier", () => {
        const frame = parseLine(asciiEncode("S:{"));
        assert.equal(frame.identifier, "s");
        assert.equal(frame.payload, "{");
    });

    it("extracts the dongle slot from an identifier", () => {
        assert.equal(parseLine(asciiEncode("X1:AA")).identifier, "x1");
    });

    it("splits an identifier into name and slot", () => {
        assert.deepEqual(parseIdentifier("x1"), { name: "x", slot: "1" });
        assert.deepEqual(parseIdentifier("i"), { name: "i", slot: undefined });
        assert.equal(parseIdentifier("x1y"), undefined);
        assert.equal(parseIdentifier(""), undefined);
    });

    it("decodes ASCII without TextDecoder", () => {
        assert.equal(asciiDecode(new Uint8Array([0x58, 0x30, 0x3a, 0x41])), "X0:A");
    });
});

function asciiEncode(text: string): Uint8Array {
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
    return bytes;
}
