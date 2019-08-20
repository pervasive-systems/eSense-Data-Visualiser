const g_constant = 9.80665;    		   // unit: m/s^2

var GyroLPF = {
    BW_250: 0,
    BW_184: 1,
    BW_92: 2,
    BW_41: 3,
    BW_20: 4,
    BW_10: 5,
    BW_5: 6,
    BW_3600: 7,
    DISABLED: 8
};

var AccLPF = {
    BW_460: 0,
    BW_184: 1,
    BW_92: 2,
    BW_41: 3,
    BW_20: 4,
    BW_10: 5,
    BW_5: 6,
    DISABLED: 7
};

var AccRange = {
    G_2: 0,
    G_4: 1,
    G_8: 2,
    G_16: 3
};

var GyroRange = {
    DEG_250: 0,
    DEG_500: 1,
    DEG_1000: 2,
    DEG_2000: 3
};

function getAccSensitivityFactor(accRange) {
    switch (accRange) {
        case AccRange.G_2:
            return (16384.0);
        case AccRange.G_4:
            return (8192.0);
        case AccRange.G_8:
            return (4096.0);
        case AccRange.G_16:
            return (2048.0);
    }
}

function getGyroSensitivityFactor(gyroRange) {
    switch (gyroRange) {
        case GyroRange.DEG_250:
            return 131.0;
        case GyroRange.DEG_500:
            return 65.5;
        case GyroRange.DEG_1000:
            return 32.8;
        case GyroRange.DEG_2000:
            return 16.4;
    }
}

function getCheckSum(bytes, checksum_index) {
    var length = bytes.length;
    var sum = 0;
    for (var i = checksum_index + 1; i < length; i++) {
        sum += bytes[i] & 0xff;
    }

    return (sum % 256);
}

function checkCheckSum(bytes, checksum_index) {
    var checkSum = getCheckSum(bytes, checksum_index);
    return checkSum == bytes[checksum_index];
}

function convertGyroADCToDegPerSecond(adc, factor) {
    var value = adc / factor;
    return (value);
}

function convertGyroADCToRadPerSecond(adc, factor) {
    var value = (adc / factor) / (180 / Math.PI);
    return (value);
}

// The output is in m/s^2
function convertAccelADCToAcceleration(adc, factor) {
    var value = (adc / factor) * g_constant;
    return (value);
}

function convertAccelADCToG(adc, factor) {
    var value = adc / factor;
    return (value);
}

function getEnumString(enumObject, ordinal) {
    var keys = Object.keys(enumObject).sort(function (a, b) {
        return enumObject[a] - enumObject[b];
    });

    return keys[ordinal];
}

function getSensorReadings(data) {
    data = data.slice(4, 16);
    gx = data.readInt16BE(0);
    gy = data.readInt16BE(2);
    gz = data.readInt16BE(4);
    ax = data.readInt16BE(6);
    ay = data.readInt16BE(8);
    az = data.readInt16BE(10);
    return ([gx, gy, gz, ax, ay, az]);
}


module.exports = {
    GyroLPF,
    AccLPF,
    AccRange,
    GyroRange,
    getAccSensitivityFactor,
    getGyroSensitivityFactor,
    getCheckSum,
    checkCheckSum,
    convertGyroADCToDegPerSecond,
    convertGyroADCToRadPerSecond,
    convertAccelADCToAcceleration,
    convertAccelADCToG,
    getEnumString,
    getSensorReadings
}