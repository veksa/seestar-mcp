#!/usr/bin/env node
/**
 * A stand-in for the Seestar firmware's JSON-RPC endpoint (TCP 4700), for the built-in Alpaca server.
 *
 * The Seestar's own Alpaca server runs on the telescope and talks to the firmware over
 * 127.0.0.1:4700, so in the test stand this runs inside the same container. It answers the methods
 * that server sends, in the shapes it parses, and keeps just enough state for a mount, a focuser, a
 * filter wheel and a dew heater to behave plausibly.
 *
 * Plain JavaScript with no dependencies: it runs on the stock Node in the container image.
 * Usage: node firmware.mjs [port]
 */

import { createServer } from "node:net";

const port = Number(process.argv[2] ?? 4700);
/** How long a goto takes, so Slewing is observable. */
const SLEW_MS = Number(process.env.FAKE_SLEW_MS ?? 1500);

const state = {
	ra: 5.5,
	dec: 20,
	alt: 45,
	az: 180,
	parked: true,
	tracking: false,
	trackModes: ["sidereal", "lunar", "solar"],
	trackIndex: 0,
	moving: "none",
	wheel: 1,
	focuser: 1600,
	focuserMax: 2600,
	gain: 80,
	exposureMs: 10000,
	heater: false,
	location: [-0.1, 51.5],
	timeZone: "Etc/UTC",
};

function now() {
	return new Date().toISOString();
}

function deviceState() {
	return {
		device: {
			product_model: "Seestar S50",
			firmware_ver_string: "7.18",
			can_wide_cam_af: false,
			firmware_platform: 0,
		},
		ap: { ssid: "S50_fake0001" },
		mount: {
			move_type: state.moving,
			close: state.parked,
			tracking: state.tracking,
			equ_mode: false,
		},
		camera: { chip_size: [1080, 1920], pixel_size_um: 2.9 },
		setting: { heater_enable: state.heater },
		pi_status: {
			is_overtemp: false,
			temp: 38.5,
			charger_status: "Discharging",
			battery_capacity: 87,
			charge_online: false,
			is_typec_connected: false,
			battery_overtemp: false,
			battery_temp: 27,
			battery_temp_type: "normal",
		},
	};
}

/** The answer to one request: a result, or an error message. */
function handle(method, params) {
	switch (method) {
		case "test_connection":
			return { result: "server connected!" };
		case "pi_is_verified":
			return { result: true };
		case "get_device_state":
			return { result: deviceState() };
		case "get_app_state":
			return { result: { page: "preview" } };
		case "get_camera_info":
			return {
				result: {
					chip_size: [1080, 1920],
					bins: [1, 2],
					pixel_size_um: 2.9,
					unity_gain: 80,
					has_cooler: false,
					is_color: true,
					is_usb3_host: false,
					has_hpc: false,
					debayer_pattern: "GR",
				},
			};
		case "get_controls":
			return {
				result: [
					{ name: "Gain", min: 0, max: 200, default_value: 80, read_only: false },
					{ name: "Exposure", min: 32, max: 60000000, default_value: 10000, read_only: false },
					{ name: "Temperature", min: -500, max: 1000, default_value: 20, read_only: true },
				],
			};
		case "get_control_value": {
			const name = Array.isArray(params) ? String(params[0]) : "";
			if (name === "Gain") return { result: { name: "Gain", type: "int", value: state.gain } };
			if (name.toLowerCase() === "temperature")
				return { result: { name: "Temperature", type: "real", value: 21.5 } };
			return { error: `unknown control ${name}` };
		}
		case "set_control_value": {
			const [name, value] = Array.isArray(params) ? params : [];
			if (name === "Gain") state.gain = Number(value);
			if (name === "Exposure") state.exposureMs = Number(value);
			return { result: 0 };
		}
		case "get_user_location":
			return { result: state.location };
		case "set_user_location":
			if (params && typeof params === "object" && !Array.isArray(params)) {
				state.location = [Number(params.lon), Number(params.lat)];
			}
			return { result: 0 };
		case "pi_get_time": {
			const date = new Date();
			return {
				result: {
					year: date.getUTCFullYear(),
					mon: date.getUTCMonth() + 1,
					day: date.getUTCDate(),
					hour: date.getUTCHours(),
					min: date.getUTCMinutes(),
					sec: date.getUTCSeconds(),
					time_zone: state.timeZone,
				},
			};
		}
		case "pi_set_time":
			return { result: 0 };
		case "scope_get_ra_dec":
		case "scope_get_equ_coord":
			return { result: [state.ra, state.dec] };
		case "scope_get_horiz_coord":
			return { result: [state.alt, state.az] };
		case "scope_is_moving":
			return { result: state.moving };
		case "scope_get_pierside":
			return { result: "East" };
		case "scope_get_mode":
			return { result: "alt_az" };
		case "scope_get_track_state":
			// When not tracking, the firmware says why next to the result, and the server requires it.
			return state.tracking
				? { result: true }
				: { result: false, extra: { track_error: "tracking is off", track_code: 0 } };
		case "scope_set_track_state":
			if (state.parked) return { error: "fail to operate" };
			state.tracking = Array.isArray(params) ? params[0] === true || params[0] === "true" : false;
			return { result: 0 };
		case "scope_get_track_mode":
			return { result: { list: state.trackModes, index: state.trackIndex } };
		case "scope_set_track_mode": {
			const index = state.trackModes.indexOf(Array.isArray(params) ? String(params[0]) : "");
			if (index >= 0) state.trackIndex = index;
			return { result: 0 };
		}
		case "scope_goto": {
			// Whether the real firmware unfolds a closed arm for a goto is not known yet (see
			// docs/hardware-checklist.md); the built-in server's Unpark only clears a flag, so a goto is
			// the one way it has to open the scope. Assume the firmware obliges.
			const [ra, dec] = Array.isArray(params) ? params.map(Number) : [];
			state.parked = false;
			state.moving = "goto";
			setTimeout(() => {
				state.ra = ra;
				state.dec = dec;
				state.moving = "none";
				broadcast({ Event: "ScopeGoto", Timestamp: now(), state: "complete", equ_mode: false });
			}, SLEW_MS).unref();
			broadcast({ Event: "ScopeGoto", Timestamp: now(), state: "working" });
			return { result: 0 };
		}
		case "scope_sync": {
			const [ra, dec] = Array.isArray(params) ? params.map(Number) : [];
			state.ra = ra;
			state.dec = dec;
			return { result: 0 };
		}
		case "scope_move":
		case "scope_speed_move":
			state.moving = "none";
			return { result: 0 };
		case "scope_park":
			state.moving = "none";
			state.tracking = false;
			state.parked = true;
			broadcast({ Event: "ScopeHome", Timestamp: now(), state: "complete" });
			return { result: 0 };
		case "iscope_stop_view":
			state.moving = "none";
			return { result: 0 };
		case "get_wheel_position":
			return { result: state.wheel };
		case "set_wheel_position":
			state.wheel = Array.isArray(params) ? Number(params[0]) : state.wheel;
			broadcast({ Event: "WheelMove", Timestamp: now(), state: "complete", position: state.wheel });
			return { result: 0 };
		case "get_focuser_position":
			return { result: state.focuser };
		case "get_focuser_state":
			return { result: { state: "idle", max_step_range: state.focuserMax } };
		case "move_focuser":
			state.focuser = Array.isArray(params) ? Number(params[0]) : state.focuser;
			return { result: 0 };
		case "open_focuser":
		case "stop_focuser":
			return { result: 0 };
		case "pi_output_set2":
			state.heater = Boolean(params?.heater?.state);
			return { result: 0 };
		case "set_page":
		case "set_setting":
		case "start_exposure":
		case "stop_exposure":
		case "save_image":
			return { result: 0 };
		default:
			return { error: `method ${method} not supported by the fake firmware` };
	}
}

const sockets = new Set();
/** Methods whose next answer is deliberately malformed. */
const malformed = new Set();

function send(socket, message) {
	socket.write(`${JSON.stringify(message)}\r\n`);
}

function broadcast(event) {
	for (const socket of sockets) send(socket, event);
}

/** Unpark as the real scope does once its startup has run; exposed for the tests through a method. */
function extra(method, params) {
	if (method === "fake_set_state") {
		Object.assign(state, params);
		return { result: 0 };
	}
	// Answer the next call of a method with a result of the wrong shape, as a firmware update might.
	if (method === "fake_malform") {
		malformed.add(String(params?.method));
		return { result: 0 };
	}
	return undefined;
}

const server = createServer((socket) => {
	sockets.add(socket);
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (!line) continue;

			let request;
			try {
				request = JSON.parse(line);
			} catch {
				process.stderr.write(`fake firmware: unparsable request ${line}\n`);
				continue;
			}

			const answer =
				extra(request.method, request.params) ?? handle(request.method, request.params);
			const broken = malformed.delete(request.method);
			const reply = broken
				? // No "code" and a result of the wrong type: every parser on the other side trips on it.
					{ jsonrpc: "2.0", Timestamp: now(), method: request.method, result: "?", id: request.id }
				: {
						jsonrpc: "2.0",
						Timestamp: now(),
						method: request.method,
						...(answer.error
							? { error: answer.error, code: 103 }
							: { result: answer.result, code: 0 }),
						...answer.extra,
						id: request.id,
					};
			if (process.env.FAKE_FIRMWARE_LOG)
				process.stderr.write(`4700 <- ${line}\n4700 -> ${JSON.stringify(reply)}\n`);
			send(socket, reply);
		}
	});
	socket.on("close", () => sockets.delete(socket));
	socket.on("error", () => sockets.delete(socket));
});

server.listen(port, "127.0.0.1", () => {
	process.stderr.write(`fake firmware listening on 127.0.0.1:${port}\n`);
});
