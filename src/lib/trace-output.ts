// something something ai says this is needed to avoid accumulating buffered output under slow disk/pipe or smth like that
import { once } from "node:events";
import type { Writable } from "node:stream";

const DEFAULT_MAX_QUEUED_BYTES = 1024 * 1024;
const textEncoder = new TextEncoder();

/** Bounded line queue that waits for each writable's drain event before advancing. */
export class TraceOutput {
    readonly #stdoutSinks: readonly Writable[];
    readonly #stderrSinks: readonly Writable[];
    readonly #maxQueuedBytes: number;
    readonly #onError: (error: unknown) => void;
    readonly #queue: Array<{ chunk: string; error: boolean }> = [];
    #queuedBytes = 0;
    #droppedLines = 0;
    #draining: Promise<void> | undefined;
    #failed = false;

    constructor(
        stdoutSinks: readonly Writable[],
        stderrSinks: readonly Writable[],
        onError: (error: unknown) => void,
        maxQueuedBytes = DEFAULT_MAX_QUEUED_BYTES,
    ) {
        this.#stdoutSinks = stdoutSinks;
        this.#stderrSinks = stderrSinks;
        this.#onError = onError;
        this.#maxQueuedBytes = maxQueuedBytes;
    }

    write(line: string, error = false): void {
        if (this.#failed) return;
        const chunk = `${line}\n`;
        const size = textEncoder.encode(chunk).byteLength;
        if (size > this.#maxQueuedBytes || this.#queuedBytes + size > this.#maxQueuedBytes) {
            this.#droppedLines++;
            return;
        }

        this.#queue.push({ chunk, error });
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
            this.#queue.push({ chunk, error: false });
            this.#queuedBytes = textEncoder.encode(chunk).byteLength;
            this.#startDrain();
            while (this.#draining || this.#queue.length > 0) {
                if (!this.#draining) this.#startDrain();
                await this.#waitForDrain();
            }
        }
    }

    #startDrain(): void {
        if (this.#draining || this.#failed) return;
        this.#draining = this.#drain()
            .catch((error: unknown) => {
                this.#failed = true;
                this.#queue.length = 0;
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
        while (this.#queue.length > 0) {
            const item = this.#queue.shift();
            if (item === undefined) continue;
            this.#queuedBytes -= textEncoder.encode(item.chunk).byteLength;

            const sinks = item.error ? this.#stderrSinks : this.#stdoutSinks;
            for (const sink of sinks) {
                if (!sink.write(item.chunk)) await once(sink, "drain");
            }
        }
    }
}
