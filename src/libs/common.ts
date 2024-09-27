const services = new Map([
    ["1800", "Generic Access"],
    ["1801", "Generic Attribute"],
    ["180a", "Device Information"],
    ["180f", "Battery Service"],
    ["fe59", "DFU Service"],
    ["00dbec3a90aa11eda1eb0242ac120002", "Tracker Service"],
    ["ef84369a90a911eda1eb0242ac120002", "Setting Service"],
]);

const characteristics = new Map([
    // Battery Service
    ["2a19", "BatteryLevel"],

    // BT device info
    ["2a25", "SerialNumber"],
    ["2a29", "Manufacturer"],
    ["2a27", "HardwareRevision"],
    ["2a26", "FirmwareRevision"],
    ["2a28", "SoftwareRevision"],
    ["2a24", "ModelNumber"],

    // Tracker Service
    //["00dbef2890aa11eda1eb0242ac120002", ""] - unknown what this is
    ["00dbf1c690aa11eda1eb0242ac120002", "Sensor"],
    ["00dbf07c90aa11eda1eb0242ac120002", "NumberOfImu"],
    ["00dbf30690aa11eda1eb0242ac120002", "Magnetometer"],
    ["00dbf45090aa11eda1eb0242ac120002", "MainButton"],
    ["00dbf58690aa11eda1eb0242ac120002", "SecondaryButton"],
    ["00dbf6a890aa11eda1eb0242ac120002", "TertiaryButton"],

    // Setting Service
    ["ef84420290a911eda1eb0242ac120002", "FpsSetting"],
    ["ef8443f690a911eda1eb0242ac120002", "TofSetting"],
    ["ef8445c290a911eda1eb0242ac120002", "SensorModeSetting"],
    ["ef84c30090a911eda1eb0242ac120002", "WirelessModeSetting"], // probably for switching between GX and BT
    ["ef84c30590a911eda1eb0242ac120002", "AutoCalibrationSetting"],
    ["ef84476690a911eda1eb0242ac120002", "SensorDataControl"], // unknown what this is
    ["ef843b5490a911eda1eb0242ac120002", "BatteryVoltage"],
    ["ef843cb290a911eda1eb0242ac120002", "ChargeStatus"],
    /* unknown what these are
    ["ef84c30290a911eda1eb0242ac120002", ""],
    ["ef84c30390a911eda1eb0242ac120002", ""],
    ["ef84c30490a911eda1eb0242ac120002", ""],
    ["ef84c30690a911eda1eb0242ac120002", ""],
    ["ef84c30790a911eda1eb0242ac120002", ""],
    ["ef84c30890a911eda1eb0242ac120002", ""],*/

    // DFU Service
    ["8ec90003f3154f609fb8838830daea50", "DFUControl"], // gave custom name

    // Unknown characteristics
    // Seems to be for nRF (Nordic Semiconductor) stuff
    ["0c900914a85e11edafa10242ac120002", "CommandMode"],
    ["0c900c84a85e11edafa10242ac120002", "Command"],
    ["0c900df6a85e11edafa10242ac120002", "Response"],
]);

export { services, characteristics };