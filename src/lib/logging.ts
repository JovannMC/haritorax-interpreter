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
    #onSinkError: ((error: unknown) => void | Promise<void>) | undefined;
    #reportingSinkError = false;

    constructor(level: LogLevel = "info", sink?: LogSink) {
        this.#level = level;
        if (sink) this.#sinks.add(sink);
    }

    onEntry(sink: LogSink): Unsubscribe {
        this.#sinks.add(sink);
        return () => this.#sinks.delete(sink);
    }

    setErrorHandler(handler: (error: unknown) => void | Promise<void>): void {
        this.#onSinkError = handler;
    }

    enabled(level: Exclude<LogLevel, "silent">): boolean {
        return this.#level !== "silent" && ORDER[level] <= ORDER[this.#level];
    }

    write(level: Exclude<LogLevel, "silent">, message: string, data?: Record<string, unknown>): void {
        if (!this.enabled(level)) return;
        const entry: LogEntry = { level, message, timestamp: Date.now(), ...(data ? { data } : {}) };
        for (const sink of [...this.#sinks]) {
            try {
                const result = sink(entry);
                if (isPromiseLike(result)) {
                    void Promise.resolve(result).catch((error: unknown) => this.#reportSinkError(error));
                }
            } catch (error) {
                this.#reportSinkError(error);
            }
        }
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

    #reportSinkError(error: unknown): void {
        if (this.#reportingSinkError) return;
        this.#reportingSinkError = true;
        let reportingAsync = false;
        try {
            const result = this.#onSinkError?.(error);
            if (isPromiseLike(result)) {
                reportingAsync = true;
                void Promise.resolve(result)
                    .catch(() => undefined)
                    .finally(() => {
                        this.#reportingSinkError = false;
                    });
            }
        } catch {
            // don't let it unwind through logging or recurse into itself
        } finally {
            if (!reportingAsync) this.#reportingSinkError = false;
        }
    }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return (typeof value === "object" && value !== null) || typeof value === "function"
        ? typeof (value as { then?: unknown }).then === "function"
        : false;
}
