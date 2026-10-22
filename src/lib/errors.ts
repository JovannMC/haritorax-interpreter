export type ErrorCode =
    | "LINK_UNAVAILABLE"
    | "DEVICE_NOT_FOUND"
    | "CONNECTION_FAILED"
    | "NOT_CONNECTED"
    | "WRITE_FAILED"
    | "READ_FAILED"
    | "DECODE_FAILED"
    | "NOT_SUPPORTED"
    | "BUSY"
    | "TIMEOUT";

export class HaritoraXError extends Error {
    readonly code: ErrorCode;

    constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
        super(message, options?.cause === undefined ? undefined : { cause: options.cause });
        this.name = "HaritoraXError";
        this.code = code;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

export function isHaritoraXError(value: unknown): value is HaritoraXError {
    return value instanceof HaritoraXError;
}
