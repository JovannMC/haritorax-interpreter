export interface ProtocolHandler {
    // ASCII
    handleFrame(endpointId: string, name: string, slot: string | undefined, payload: string): void;
    // binary data (BLE only)
    handleBinaryFrame?(endpointId: string, characteristic: string, data: Uint8Array): void;

    forgetEndpoint(endpointId: string): void;
    dispose(): void;
}
