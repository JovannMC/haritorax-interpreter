export interface LineFrame {
    identifier: string;
    payload: string;
}

export function asciiDecode(bytes: Uint8Array): string {
    let text = "";
    for (const byte of bytes) text += String.fromCharCode(byte);
    return text;
}

export function asciiEncode(text: string): Uint8Array {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    return bytes;
}

export function parseLine(bytes: Uint8Array): LineFrame {
    const text = asciiDecode(bytes);
    const colon = text.indexOf(":");

    if (colon === -1) return { identifier: text.toLowerCase(), payload: "" };

    return {
        identifier: text.slice(0, colon).toLowerCase(),
        payload: text.slice(colon + 1),
    };
}

const LF = 0x0a;
const CR = 0x0d;

// splits the given bytes into complete lines, returning whatever is left after the last terminator so the caller can keep it for the next chunk. Handles both LF and CRLF, and skips empty lines.
export function splitLines(pending: Uint8Array, chunk?: Uint8Array): { lines: Uint8Array[]; rest: Uint8Array } {
    const buffer = chunk ? concat(pending, chunk) : pending;
    const lines: Uint8Array[] = [];

    let start = 0;
    let newline = buffer.indexOf(LF);

    while (newline !== -1) {
        const end = newline > start && buffer[newline - 1] === CR ? newline - 1 : newline;
        if (end > start) lines.push(buffer.slice(start, end));

        start = newline + 1;
        newline = buffer.indexOf(LF, start);
    }

    return { lines, rest: buffer.slice(start) };
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
    if (left.length === 0) return right;

    const merged = new Uint8Array(left.length + right.length);
    merged.set(left, 0);
    merged.set(right, left.length);
    return merged;
}
