import type { SettingsApplyResult, SettingsWriteFailure } from "../types.js";

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

export class SettingsWriteError extends HaritoraXError {
    readonly result: SettingsApplyResult;
    readonly failures: readonly SettingsWriteFailure[];

    constructor(result: SettingsApplyResult, failures: readonly SettingsWriteFailure[]) {
        super(
            "WRITE_FAILED",
            `Failed to apply ${failures.map(({ setting }) => setting).join(", ")} settings, ${result.applied.length} field(s) applied`,
            { cause: new AggregateError(failures.map(({ error }) => error)) },
        );
        this.name = "SettingsWriteError";
        this.result = { applied: [...result.applied], unsupported: [...result.unsupported] };
        this.failures = failures.map((failure) => ({ ...failure }));
    }
}

export function isHaritoraXError(value: unknown): value is HaritoraXError {
    return value instanceof HaritoraXError;
}
