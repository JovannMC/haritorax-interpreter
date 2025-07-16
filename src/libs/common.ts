function addUUIDs(map: Map<string, string>, uuid: string, name: string) {
    const fullUUID = toFullUUID(uuid);
    map.set(uuid, name);
    map.set(fullUUID, name);
    map.set(fullUUID.replace(/-/g, ""), name);
}

function toFullUUID(shortUUID: string): string {
    if (shortUUID.length === 4) {
        return `0000${shortUUID}-0000-1000-8000-00805f9b34fb`;
    }
    return formatUUID(shortUUID);
}

function formatUUID(uuid: string): string {
    const cleanedUUID = uuid.replace(/-/g, "");
    if (cleanedUUID.length !== 32) {
        throw new Error(`Invalid UUID length: ${cleanedUUID.length}`);
    }
    return `${cleanedUUID.slice(0, 8)}-${cleanedUUID.slice(8, 12)}-${cleanedUUID.slice(12, 16)}-${cleanedUUID.slice(
        16,
        20,
    )}-${cleanedUUID.slice(20)}`;
}

const services = new Map<string, string>();
addUUIDs(services, "1800", "Generic Access");
addUUIDs(services, "1801", "Generic Attribute");
addUUIDs(services, "180a", "Device Information");
addUUIDs(services, "180f", "Battery Service");
addUUIDs(services, "fe59", "DFU Service");
addUUIDs(services, "00dbec3a90aa11eda1eb0242ac120002", "Tracker Service");
addUUIDs(services, "ef84369a90a911eda1eb0242ac120002", "Setting Service");

const characteristics = new Map<string, string>();
addUUIDs(characteristics, "2a19", "BatteryLevel");
addUUIDs(characteristics, "2a25", "SerialNumber");
addUUIDs(characteristics, "2a29", "Manufacturer");
addUUIDs(characteristics, "2a27", "HardwareRevision");
addUUIDs(characteristics, "2a26", "FirmwareRevision");
addUUIDs(characteristics, "2a28", "SoftwareRevision");
addUUIDs(characteristics, "2a24", "ModelNumber");
addUUIDs(characteristics, "00dbf1c690aa11eda1eb0242ac120002", "Sensor");
addUUIDs(characteristics, "00dbc40090aa11eda1eb0242ac120002", "Sensor2");
addUUIDs(characteristics, "00dbf07c90aa11eda1eb0242ac120002", "NumberOfImu");
addUUIDs(characteristics, "00dbf30690aa11eda1eb0242ac120002", "Magnetometer");
addUUIDs(characteristics, "00dbf45090aa11eda1eb0242ac120002", "MainButton");
addUUIDs(characteristics, "00dbf58690aa11eda1eb0242ac120002", "SecondaryButton");
addUUIDs(characteristics, "00dbf6a890aa11eda1eb0242ac120002", "TertiaryButton");
addUUIDs(characteristics, "ef84420290a911eda1eb0242ac120002", "FpsSetting");
addUUIDs(characteristics, "ef8443f690a911eda1eb0242ac120002", "TofSetting");
addUUIDs(characteristics, "ef8445c290a911eda1eb0242ac120002", "SensorModeSetting");
addUUIDs(characteristics, "ef84c30090a911eda1eb0242ac120002", "WirelessModeSetting");
addUUIDs(characteristics, "ef84c30590a911eda1eb0242ac120002", "AutoCalibrationSetting");
addUUIDs(characteristics, "ef84476690a911eda1eb0242ac120002", "SensorDataControl");
addUUIDs(characteristics, "ef843b5490a911eda1eb0242ac120002", "BatteryVoltage");
addUUIDs(characteristics, "ef843cb290a911eda1eb0242ac120002", "ChargeStatus");
addUUIDs(characteristics, "ef84c30190a911eda1eb0242ac120002", "BodyPartAssignment");
addUUIDs(characteristics, "8ec90003f3154f609fb8838830daea50", "DFUControl");
addUUIDs(characteristics, "0c900914a85e11edafa10242ac120002", "CommandMode");
addUUIDs(characteristics, "0c900c84a85e11edafa10242ac120002", "Command");
addUUIDs(characteristics, "0c900df6a85e11edafa10242ac120002", "Response");

export { characteristics, services };
