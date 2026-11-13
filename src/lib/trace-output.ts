// something something ai says this is needed to avoid accumulating buffered output under slow disk/pipe or smth like that
import type { Writable } from "node:stream";
import type { ConnectionErrorEvent } from "../types.js";

const DEFAULT_MAX_QUEUED_BYTES = 1024 * 1024;
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
const textEncoder = new TextEncoder();

export function formatConnectionError(event: ConnectionErrorEvent): string {
    const details = [
        event.endpointId ? `endpoint: ${event.endpointId}` : undefined,
        event.characteristic ? `characteristic: ${event.characteristic}` : undefined,
        event.command ? `command: ${event.command}` : undefined,
    ].filter((detail): detail is string => detail !== undefined);
    const context = details.length > 0 ? ` (${details.join(", ")})` : "";
    return `[${event.connection}] ${event.operation} failed${context}: ${event.error.message}`;
}

/** Bounded line queue that waits for each writable's drain event before advancing. */
export class TraceOutput {
    readonly #stdoutSinks: readonly Writable[];
    readonly #stderrSinks: readonly Writable[];
    readonly #maxQueuedBytes: number;
    readonly #drainTimeoutMs: number;
    readonly #onError: (error: unknown) => void;
    readonly #encodedChunk = new Uint8Array(4096);
    readonly #queue: Array<{ chunk: string; error: boolean; size: number } | undefined> = [];
    #queueHead = 0;
    #queuedBytes = 0;
    #droppedLines = 0;
    #draining: Promise<void> | undefined;
    #failed = false;

    constructor(
        stdoutSinks: readonly Writable[],
        stderrSinks: readonly Writable[],
        onError: (error: unknown) => void,
        maxQueuedBytes = DEFAULT_MAX_QUEUED_BYTES,
        drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
    ) {
        this.#stdoutSinks = stdoutSinks;
        this.#stderrSinks = stderrSinks;
        this.#onError = onError;
        this.#maxQueuedBytes = maxQueuedBytes;
        this.#drainTimeoutMs = drainTimeoutMs;
    }

    write(line: string, error = false): void {
        if (this.#failed) return;
        const chunk = `${line}\n`;
        const size = this.#byteLength(chunk);
        if (size > this.#maxQueuedBytes || this.#queuedBytes + size > this.#maxQueuedBytes) {
            this.#droppedLines++;
            return;
        }

        this.#queue.push({ chunk, error, size });
        this.#queuedBytes += size;
        this.#startDrain();
    }

    async flush(): Promise<void> {
        while (this.#draining || this.#queue.length > 0) {
            if (!this.#draining) this.#startDrain();
            await this.#waitForDrain();
        }

        if (this.#droppedLines > 0 && !this.#failed) {
            const dropped = this.#droppedLines;
            this.#droppedLines = 0;
            const chunk = `[trace] Dropped ${dropped} output line(s) because the output queue was full.\n`;
            const size = this.#byteLength(chunk);
            this.#queue.push({ chunk, error: false, size });
            this.#queuedBytes = size;
            this.#startDrain();
            while (this.#draining || this.#queue.length > 0) {
                if (!this.#draining) this.#startDrain();
                await this.#waitForDrain();
            }
        }
    }

    #byteLength(chunk: string): number {
        let offset = 0;
        let size = 0;
        while (offset < chunk.length) {
            const { read, written } = textEncoder.encodeInto(chunk.slice(offset), this.#encodedChunk);
            offset += read;
            size += written;
        }
        return size;
    }

    #startDrain(): void {
        if (this.#draining || this.#failed) return;
        this.#draining = this.#drain()
            .catch((error: unknown) => {
                this.#failed = true;
                this.#queue.length = 0;
                this.#queueHead = 0;
                this.#queuedBytes = 0;
                this.#onError(error);
            })
            .finally(() => {
                this.#draining = undefined;
                if (this.#queue.length > 0) this.#startDrain();
            });
    }

    #waitForDrain(): Promise<void> {
        return this.#draining ?? Promise.resolve();
    }

    async #drain(): Promise<void> {
        while (this.#queueHead < this.#queue.length) {
            const item = this.#queue[this.#queueHead];
            this.#queue[this.#queueHead++] = undefined;
            if (item === undefined) continue;
            this.#queuedBytes -= item.size;
            if (this.#queueHead >= 1024 && this.#queueHead * 2 >= this.#queue.length) {
                this.#queue.splice(0, this.#queueHead);
                this.#queueHead = 0;
            }

            const sinks = item.error ? this.#stderrSinks : this.#stdoutSinks;
            for (const sink of sinks) {
                if (!sink.write(item.chunk)) await waitForDrain(sink, this.#drainTimeoutMs);
            }
        }
        this.#queue.length = 0;
        this.#queueHead = 0;
    }
}

function waitForDrain(sink: Writable, timeoutMs: number): Promise<void> {
    if (sink.destroyed || sink.writableEnded) return Promise.reject(new Error("Trace output sink is closed"));

    return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => finish(new Error("Timed out waiting for trace output drain")), timeoutMs);
        const onDrain = (): void => finish();
        const onClose = (): void => finish(new Error("Trace output sink closed before draining"));
        const onError = (error: Error): void => finish(error);

        function finish(error?: Error): void {
            clearTimeout(timeout);
            sink.removeListener("drain", onDrain);
            sink.removeListener("close", onClose);
            sink.removeListener("error", onError);
            if (error) reject(error);
            else resolve();
        }

        sink.once("drain", onDrain);
        sink.once("close", onClose);
        sink.once("error", onError);
        if (sink.destroyed || sink.writableEnded) onClose();
    });
}
