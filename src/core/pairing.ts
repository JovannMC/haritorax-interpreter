export type PairingResult = "paired" | "cancelled" | "timeout";

interface PendingPairing {
    resolve: (result: PairingResult) => void;
    timer: ReturnType<typeof setTimeout>;
}

export class PairingTracker {
    readonly #pending = new Map<string, PendingPairing>();

    has(endpointId: string): boolean {
        return this.#pending.has(endpointId);
    }

    wait(endpointId: string, timeoutMs: number): Promise<PairingResult> {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.#pending.delete(endpointId);
                resolve("timeout");
            }, timeoutMs);

            this.#pending.set(endpointId, { resolve, timer });
        });
    }

    settle(endpointId: string, result: PairingResult): boolean {
        const pending = this.#pending.get(endpointId);
        if (!pending) return false;

        clearTimeout(pending.timer);
        this.#pending.delete(endpointId);
        pending.resolve(result);
        return true;
    }

    cancel(endpointId: string): void {
        this.settle(endpointId, "cancelled");
    }

    cancelAll(): void {
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
            pending.resolve("cancelled");
        }
        this.#pending.clear();
    }
}
