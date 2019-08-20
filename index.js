var express = require('express');
var path = require('path');
var log4js = require('log4js');
var noble = require('noble')
var earbud = null
var createBuffer = require('audio-buffer-from')
var format = require('audio-format')
const portAudio = require('naudiodon');
var utils = require('./utils');

var earbudName = "";
var mic_rate = 8000;

// IMU configuration default values 
var accel_range = utils.AccRange.G_4;        // unit: g
var gyro_range = utils.GyroRange.DEG_500;    // unit: degrees per second
var gyro_lpf = utils.GyroLPF.BW_5;
var acc_lpf = utils.AccLPF.BW_5;

// Sensitivity factors to convert ADC sensor values to different units
var acc_factor = utils.getAccSensitivityFactor(accel_range)
var gyro_factor = utils.getGyroSensitivityFactor(gyro_range)

var bleScanEnabled = false;
var eSenseConnecting = false;

// For offset calibration
var gyro_sum_axis = [0, 0, 0];
var acc_sum_axis = [0, 0, 0];
var samples_count = 0;
const CAL_SAMPLES_COUNT = 200;
var gx_offset = 0;
var gy_offset = 0;
var gz_offset = 0;
var ax_offset = 0;
var ay_offset = 0;
var az_offset = 0;

var control_characteristic = null;
var data_characteristic = null;
var sensor_notification_handler = null;
var sensor_config_characteristic = null;

// Variable to hold a reference to the audio input object
var audio_input = null

var logger = log4js.getLogger('[eSense-Recorder]');
logger.level = 'INFO'

// Print all audio devices
logger.info(portAudio.getDevices());

var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);

app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 100 }));

io.on('connection', function (socket) {
	logger.info('socket client ' + socket.id + ' is connected');

	socket.on('disconnect', function (data) {
		logger.info('socket client ' + socket.id + ' is disconnected');
	});

	// Receive commands from UI
	socket.on('console', function (data) {
		if (data.target == "connect") {
			earbudName = data.name;
			eSenseConnecting = true;
			io.sockets.emit('status', { message: "Scanning..." });
		} else if (data.target == "disconnect") {
			eSenseConnecting = false;
			if (earbud != null)
				earbud.disconnect();
			earbud = null;
			io.sockets.emit('status', { message: "Stop scanning." });
		} else if (data.target == "mic") {
			if (data.action == "on") {
				audio_input = createAudioInput(mic_rate);
				audio_input.start();
				io.sockets.emit('status', { message: "Turning on microphone sampling at " + mic_rate + "Hz." });
			} else if (data.action == "off") {
				if (audio_input != null)
					audio_input.quit();
			} else if (data.action == "update") {
				mic_rate = data.sampling;
				io.sockets.emit('status', { message: "Microphone sampling rate updated to " + mic_rate + "Hz." });
			}
		}

		if (control_characteristic != null && data_characteristic != null && sensor_config_characteristic != null) {
			if (data.target == "motion") {
				if (data.action == "on") {
					enableAndReadSensor(control_characteristic, data_characteristic, data.sampling);
				} else if (data.action == "off") {
					stopSensing(control_characteristic, data_characteristic);
				} else if (data.action == "update") {
					writeSensorConfiguration(sensor_config_characteristic, data.values[0], data.values[1], data.values[2], data.values[3]);
				}
			} else if (data.target == "calibration") {
				if (data.action == "on") {
					findAxesOffset(control_characteristic, data_characteristic, 100);
				}
			} else if (data.target == "ble") {
				if (data.action == "on") {
					bleScanEnabled = true;
				} else if (data.action == "off") {
					bleScanEnabled = false;
				} else if (data.action == "update") {
					writeAdvConnIntervals(control_characteristic, data.values[0], data.values[1], data.values[2], data.values[3]);
				}
			}
		}
	});
});

app.get("/", function (req, res) {
	res.sendFile(path.join(__dirname, '/public', 'index.html'));
});

http.listen(5000, function () {
	logger.info('eSense-Recorder is listening on port : 5000');
});

function subscribeToButtonEvents(characteristic) {
	characteristic.subscribe(function (err) {
		if (!err) {
			characteristic.on('data', function (data, isNotification) {
				// logger.info("Button " + data[3]);
				io.sockets.emit('status', { message: "Button " + (data[3] == 1 ? " pressed." : " released.") });
			});

			io.sockets.emit('status', { message: "Subscribed to button events" });
		}
	});
}

function readSensorConfiguration(characteristic) {
	characteristic.read(function (error, data) {
		logger.info("IMU configuration raw data: " + data.toString("hex"));

		gyro_range = (data[4] & 0x18) >> 3;
		accel_range = (data[5] & 0x18) >> 3;
		acc_factor = utils.getAccSensitivityFactor(accel_range);
		gyro_factor = utils.getGyroSensitivityFactor(gyro_range);

		//Gyro LPF
		var lpf_enabled = data[4] & 0x3;
		if (lpf_enabled == 1 || lpf_enabled == 2) {
			gyro_lpf = utils.GyroLPF.DISABLED  //Disabled
		} else {
			gyro_lpf = data[3] & 0x7;
		}

		//Accelerometer LPF
		lpf_enabled = (data[6] & 0x8) >> 3;
		if (lpf_enabled == 1) {
			acc_lpf = utils.AccLPF.DISABLED;    //Disabled
		} else {
			acc_lpf = data[6] & 0x7;
		}

		io.sockets.emit('status', { message: "Accelerometer range: +- " + utils.getEnumString(utils.AccRange, accel_range) });
		io.sockets.emit('status', { message: "Accelerometer LPF: " + utils.getEnumString(utils.AccLPF, acc_lpf) });
		io.sockets.emit('status', { message: "Gyro range: +- " + utils.getEnumString(utils.GyroRange, gyro_range) });
		io.sockets.emit('status', { message: "Gyro LPF: " + utils.getEnumString(utils.GyroLPF, gyro_lpf) });
	});
}

function writeSensorConfiguration(characteristic, acc_full_scale, gyro_full_scale, new_acc_lpf, new_gyro_lpf) {
	io.sockets.emit('status', {
		message: "Updating IMU configuration with accRange: " + utils.getEnumString(utils.AccRange, acc_full_scale) +
			"g, gyroRange: " + utils.getEnumString(utils.GyroRange, gyro_full_scale) +
			"deg/s, accLPF: " + utils.getEnumString(utils.AccLPF, new_acc_lpf) +
			" and gyroLPF: " + utils.getEnumString(utils.GyroLPF, new_gyro_lpf)
	});

	// Read current configuration so we modify only the necessary bits
	characteristic.read(function (error, data) {
		var conf_reg = null;
		var gyro_reg = null;
		var acc_reg = null;
		var acc_reg2 = null;

		conf_reg = data.slice(3, 4);
		gyro_reg = data.slice(4, 5);
		acc_reg = data.slice(5, 6);
		acc_reg2 = data.slice(6, 7);

		// Gyro full scale
		gyro_reg = (gyro_reg & 0xe7) | (gyro_full_scale << 3);

		// Acc full scale
		acc_reg = (acc_reg & 0xe7) | (acc_full_scale << 3);

		//Gyro LPF
		if (new_gyro_lpf == utils.GyroLPF.DISABLED) {
			gyro_reg = (gyro_reg & 0xfc) | 0x1;
		} else {
			gyro_reg = gyro_reg & 0xfc;
			conf_reg = (conf_reg & 0xf8) | new_gyro_lpf;
		}

		//Acc LPF
		if (new_acc_lpf == utils.AccLPF.DISABLED) {
			acc_reg2 = (acc_reg2 & 0xf7) | (0x1 << 3);
		} else {
			acc_reg2 = (acc_reg2 & 0xf7);
			acc_reg2 = (acc_reg2 & 0xf8) | new_acc_lpf;
		}

		var command = Buffer.from([0x59, 0x00, 0x04, 0x06, 0x08, 0x08, 0x06]);
		command.writeUInt8(conf_reg, 3);
		command.writeUInt8(gyro_reg, 4);
		command.writeUInt8(acc_reg, 5);
		command.writeUInt8(acc_reg2, 6);
		command.writeUInt8(utils.getCheckSum(command, 1), 1);
		characteristic.write(command, false, function (err) {
			if (!err) {
				logger.info("Written successfully to characteristic: " + characteristic.uuid);
				io.sockets.emit('status', { message: "IMU configuration written" });
				io.sockets.emit('characteristic', { target: "motion" });

				// Update global variables
				gyro_range = gyro_full_scale;
				accel_range = acc_full_scale;
				gyro_lpf = new_gyro_lpf;
				acc_lpf = new_acc_lpf;
				acc_factor = utils.getAccSensitivityFactor(accel_range);
				gyro_factor = utils.getGyroSensitivityFactor(gyro_range);
			} else {
				logger.error("Error writing sensor configuration");
			}
		})
	});
}

// Values in milliseconds
function writeAdvConnIntervals(characteristic, adv_min, adv_max, conn_min, conn_max) {
	if (100 <= adv_min && adv_min <= adv_max && adv_max <= 5000) {
		adv_min = Math.floor(adv_min / 0.625);
		adv_max = Math.floor(adv_max / 0.625);
	} else {
		return;
	}

	if (20 <= conn_min && conn_min <= conn_max && conn_max <= 2000 && (conn_max - conn_min) >= 20) {
		conn_min = Math.floor(conn_min / 1.25);
		conn_max = Math.floor(conn_max / 1.25);
	} else {
		return;
	}

	var command = Buffer.from([0x57, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
	command.writeUInt8(adv_min >> 8, 3);
	command.writeUInt8(adv_min & 0xff, 4);
	command.writeUInt8(adv_max >> 8, 5);
	command.writeUInt8(adv_max & 0xff, 6);
	command.writeUInt8(conn_min >> 8, 7);
	command.writeUInt8(conn_min & 0xff, 8);
	command.writeUInt8(conn_max >> 8, 9);
	command.writeUInt8(conn_max & 0xff, 10);
	command.writeUInt8(utils.getCheckSum(command, 1), 1);
	characteristic.write(command, false, function (err) {
		if (!err) {
			logger.info("Written successfully to characteristic: " + characteristic.uuid);
			io.sockets.emit('status', { message: "Advertisement and Connection intervals updated (re-connect to make them effective)" });
			io.sockets.emit('characteristic', { target: "ble" });
		} else {
			logger.error("Error writing Adv/Conn intervals");
		}
	})
}

function readFactoryCalibrationValues(characteristic) {
	characteristic.read(function (error, data) {
		data = data.slice(3, 15);
		// The gyro offset values are in 2's complement
		cal_gx = data.readInt16BE(0)
		cal_gy = data.readInt16BE(2)
		cal_gz = data.readInt16BE(4)

		// For the accelerometer the format are G in +-16G format. The register is initialized with OTP (One-Time Programmable) factory trim values.
		cal_ax = (data[6] << 8) | data[7];
		cal_ay = (data[8] << 8) | data[9];
		cal_az = (data[10] << 8) | data[11];

		logger.info("Factory calibration gyro: " + cal_gx + " " + cal_gy + " " + cal_gy);
		logger.info("Factory calibration acc: " + cal_ax + " " + cal_ay + " " + cal_az);

		// io.sockets.emit('status', { message: "Factory calibration gyroscope: " + cal_gx + " " + cal_gy + " " + cal_gy });
		io.sockets.emit('status', { message: "Factory calibration accelerometer: " + cal_ax + " " + cal_ay + " " + cal_az });
	});
}

function getStartSamplingCommand(sampling_rate) {
	var command = Buffer.from([0x53, 0x67, 0x02, 0x01, 0x64]);   // default 100Hz
	if (sampling_rate >= 1 && sampling_rate <= 200) {
		command.writeUInt8(sampling_rate, 4);
		command.writeUInt8(utils.getCheckSum(command, 1), 1);
	}

	return (command);
}

function stopSensing(control_characteristic, data_characteristic) {
	var stop_command = Buffer.from([0x53, 0x02, 0x02, 0x00, 0x00]);
	data_characteristic.unsubscribe();
	if (sensor_notification_handler != null) {
		data_characteristic.removeListener('data', sensor_notification_handler);
		sensor_notification_handler = null;
	}

	control_characteristic.write(stop_command, false, function (err) {
		if (!err) {
			logger.info("Sensor reading stopped");
		}
	});
}

/*
* Connect to the earbud and discover its services 
*/
function connectToPeripheral(peripheral) {
	logger.info("Trying to connect")
	io.sockets.emit('status', { message: "Earbud found." })
	io.sockets.emit('status', { message: "Trying to connect..." })
	earbud = peripheral
	peripheral.connect(function (err) {
		io.sockets.emit('status', { message: "Earbud connected!" });
		io.sockets.emit('eSense-connect', { isConnected: true });
		peripheral.discoverServices(['ff06'], function (err, services) {
			services.forEach(function (service) {
				logger.info('found service:', service.uuid);
				service.discoverCharacteristics(['ff07', 'ff08', 'ff09', 'ff0d', 'ff0e'], function (err, characteristics) {
					characteristics.forEach(function (characteristic) {
						logger.info("Found sensor characteristic : " + characteristic.uuid)
						if (characteristic.uuid == "ff07")
							control_characteristic = characteristic
						else if (characteristic.uuid == "ff08")
							data_characteristic = characteristic
						else if (characteristic.uuid == "ff09")
							subscribeToButtonEvents(characteristic)
						else if (characteristic.uuid == "ff0d")
							readFactoryCalibrationValues(characteristic)
						else if (characteristic.uuid == "ff0e") {
							sensor_config_characteristic = characteristic;
							readSensorConfiguration(sensor_config_characteristic);
						}
					})
				})
			})
		})
	})

	disconnect_handler = function () {
		logger.info('Peripheral disconnected ' + peripheral);
		io.sockets.emit('status', { message: "Earbud disconnected" })
		io.sockets.emit('eSense-connect', { isConnected: false });
		earbud = null;
		peripheral.removeListener('disconnect', disconnect_handler);
	};

	peripheral.on('disconnect', disconnect_handler);
}

function prepareNobleHandlers() {
	noble.on('stateChange', function (state) {
		if (state === 'poweredOn') {
			noble.startScanning([], true);
		} else {
			noble.stopScanning();
		}
	});

	noble.on('discover', function (peripheral) {
		if (bleScanEnabled) {
			if (peripheral.advertisement.localName == earbudName) {
				io.sockets.emit('rssi', peripheral.rssi > 0 ? -peripheral.rssi : peripheral.rssi)
			}
		}

		if (eSenseConnecting) {
			if (peripheral.advertisement.localName == earbudName && earbud == null) {
				connectToPeripheral(peripheral);
			}
		}
	})
}

/*
* Accumulates sensor readings to compute the average offset for all 6 axes 
*/
function findAxesOffset(control_characteristic, data_characteristic, imu_sampling_rate) {
	logger.info("Starting reading data to find offset");

	var start = getStartSamplingCommand(imu_sampling_rate);
	control_characteristic.write(start, false, function (err) {
		if (!err) {
			logger.info("Written successfully to characteristic: " + control_characteristic.uuid);
			data_characteristic.subscribe(function (err) {
				if (!err) {
					sensor_notification_handler = function (data, isNotification) {
						if (utils.checkCheckSum(data, 2) == true) {
							var readings = utils.getSensorReadings(data);

							if (samples_count <= CAL_SAMPLES_COUNT) {
								// Accumulate gyro and accelerometer readings
								gyro_sum_axis[0] += utils.convertGyroADCToDegPerSecond(readings[0], gyro_factor);
								gyro_sum_axis[1] += utils.convertGyroADCToDegPerSecond(readings[1], gyro_factor);
								gyro_sum_axis[2] += utils.convertGyroADCToDegPerSecond(readings[2], gyro_factor);

								acc_sum_axis[0] += utils.convertAccelADCToG(readings[3], acc_factor);
								acc_sum_axis[1] += utils.convertAccelADCToG(readings[4], acc_factor);
								acc_sum_axis[2] += utils.convertAccelADCToG(readings[5], acc_factor);

								samples_count++;
							}

							if (samples_count == CAL_SAMPLES_COUNT) {
								gx_offset = gyro_sum_axis[0] / samples_count;
								gy_offset = gyro_sum_axis[1] / samples_count;
								gz_offset = gyro_sum_axis[2] / samples_count;
								ax_offset = acc_sum_axis[0] / samples_count;
								ay_offset = acc_sum_axis[1] / samples_count;
								az_offset = 1 - (-acc_sum_axis[2] / samples_count);
								gyro_sum_axis = [0, 0, 0];
								acc_sum_axis = [0, 0, 0];
								samples_count = 0;

								io.sockets.emit('calibration', {});
								io.sockets.emit('status', { message: "Calibration finished." });

								io.sockets.emit('status', { message: "Gyro Offset x-axis (deg/s) " + gx_offset });
								io.sockets.emit('status', { message: "Gyro Offset y-axis (deg/s) " + gy_offset });
								io.sockets.emit('status', { message: "Gyro Offset z-axis (deg/s) " + gz_offset });

								io.sockets.emit('status', { message: "Acc Offset x-axis (g) " + ax_offset });
								io.sockets.emit('status', { message: "Acc Offset y-axis (g) " + ay_offset });
								io.sockets.emit('status', { message: "Acc Offset z-axis (g) " + az_offset });

								stopSensing(control_characteristic, data_characteristic);
							}
						} else {
							logger.error("Checksum failed!");
						}
					};

					data_characteristic.on('data', sensor_notification_handler);
					io.sockets.emit('status', { message: "Calibration of " + earbudName + " started." });
				}
			});
		}
		else logger.error("Error when starting IMU sampling");
	})
}

/*
* Enables IMU sampling and registers the handler to receive data when available
*/
function enableAndReadSensor(control_characteristic, data_characteristic, imu_sampling_rate) {
	logger.info("Received two UUIDs: " + control_characteristic.uuid + " and " + data_characteristic.uuid)
	var start = getStartSamplingCommand(imu_sampling_rate);
	control_characteristic.write(start, false, function (err) {
		if (!err) {
			logger.info("Written successfully to characteristic: " + control_characteristic.uuid)
			data_characteristic.subscribe(function (err) {
				if (!err) {
					sensor_notification_handler = function (data, isNotification) {
						if (utils.checkCheckSum(data, 2) == true) {
							var readings = utils.getSensorReadings(data);
							io.sockets.emit('gyro', {
								x: utils.convertGyroADCToDegPerSecond(readings[0], gyro_factor) - gx_offset,
								y: utils.convertGyroADCToDegPerSecond(readings[1], gyro_factor) - gy_offset,
								z: utils.convertGyroADCToDegPerSecond(readings[2], gyro_factor) - gz_offset
							});
							io.sockets.emit('acc', {
								x: utils.convertAccelADCToG(readings[3], acc_factor) - ax_offset,
								y: utils.convertAccelADCToG(readings[4], acc_factor) - ay_offset,
								z: utils.convertAccelADCToG(readings[5], acc_factor) - az_offset
							});
						} else {
							logger.error("Checksum failed!");
						}
					};

					data_characteristic.on('data', sensor_notification_handler);
				}
			});
		}
		else logger.error("Error when starting IMU sampling");
	})
}

/*
* Creates an AudioInput object for the system's default device with the specified sample rate
*/
function createAudioInput(audio_sample_rate) {
	// Create an instance of AudioInput, which is a ReadableStream
	var ai = new portAudio.AudioInput({
		channelCount: 1,
		sampleFormat: portAudio.SampleFormat16Bit,
		sampleRate: audio_sample_rate,
		deviceId: -1 // Use -1 or omit the deviceId to select the default device
	});

	// handle errors from the AudioInput
	ai.on('error', err => logger.error);

	ai.on('readable', function () {
		var chunk;
		while (null !== (chunk = ai.read())) {
			var f = { format: format.parse('int16 mono le ' + audio_sample_rate) };
			var buffer = createBuffer(chunk, f);
			io.sockets.emit('microphone', { x: buffer.getChannelData(0) });
		}
	})

	ai.on('end', function () {
		logger.info("Audio stream closed");
	});

	return (ai);
}

process.on('SIGINT', () => {
	logger.info('CTRL+C pressed...');
	killSensing()
});

function killSensing() {
	if (earbud != null)
		earbud.disconnect()
	if (audio_input != null)
		audio_input.quit()
	process.exit(0)
}

prepareNobleHandlers();
