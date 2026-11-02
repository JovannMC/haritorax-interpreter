import type { LogEntry, LogLevel, Unsubscribe } from "../types.js";

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
    readonly #sinks = new Set<LogSink>();

    constructor(level: LogLevel = "info", sink?: LogSink) {
        this.#level = level;
        if (sink) this.#sinks.add(sink);
    }

    onEntry(sink: LogSink): Unsubscribe {
        this.#sinks.add(sink);
        return () => this.#sinks.delete(sink);
    }

    enabled(level: Exclude<LogLevel, "silent">): boolean {
        return this.#level !== "silent" && ORDER[level] <= ORDER[this.#level];
    }

    write(level: Exclude<LogLevel, "silent">, message: string, data?: Record<string, unknown>): void {
        if (!this.enabled(level)) return;
        const entry: LogEntry = { level, message, timestamp: Date.now(), ...(data ? { data } : {}) };
        for (const sink of [...this.#sinks]) sink(entry);
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

    trace(message: string, data?: Record<string, unknown>): void {
        this.write("trace", message, data);
    }
}
