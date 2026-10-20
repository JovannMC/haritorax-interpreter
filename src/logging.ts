import type { LogEntry, LogLevel } from "./types.js";

const ORDER: Readonly<Record<Exclude<LogLevel, "silent">, number>> = Object.freeze({
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
    trace: 5,
});

export type LogSink = (entry: LogEntry) => void;

export class Logger {
    readonly #level: LogLevel;
    readonly #sink: LogSink | undefined;

    constructor(level: LogLevel = "info", sink?: LogSink) {
        this.#level = level;
        this.#sink = sink;
    }

    enabled(level: Exclude<LogLevel, "silent">): boolean {
        return this.#level !== "silent" && ORDER[level] <= ORDER[this.#level];
    }

    write(level: Exclude<LogLevel, "silent">, message: string, data?: Record<string, unknown>): void {
        if (!this.enabled(level)) return;
        this.#sink?.({ level, message, timestamp: Date.now(), ...(data ? { data } : {}) });
    }

    error(message: string, data?: Record<string, unknown>): void {
        this.write("error", message, data);
    }

    warn(message: string, data?: Record<string, unknown>): void {
        this.write("warn", message, data);
    }

    info(message: string, data?: Record<string, unknown>): void {
        this.write("info", message, data);
    }

    debug(message: string, data?: Record<string, unknown>): void {
        this.write("debug", message, data);
    }
}
