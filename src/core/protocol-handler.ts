export interface ProtocolHandler {
    // ASCII
    // rawName keeps the device's case, for the few frames where case is the difference (wired `X:` vs `x:`)
    handleFrame(endpointId: string, name: string, slot: string | undefined, payload: string, rawName?: string): void;
    // binary data (BLE only)
    handleBinaryFrame?(endpointId: string, characteristic: string, data: Uint8Array): void;

    forgetEndpoint(endpointId: string): void;
    dispose(): void;
}
