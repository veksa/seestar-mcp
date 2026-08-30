/**
 * A simulated Seestar, good enough to develop against without hardware.
 *
 * Models what actually matters for this server: a mount that takes time to slew, the firmware event
 * stream that reports progress, an imaging session that accumulates frames, and the scheduler. The
 * shapes of the action results follow the real `seestar_alp` responses (see `Seestar Alpaca API.json`
 * and `device/telescope.py` in that project).
 *
 * Time is injectable so tests can be deterministic; by default everything is scaled down to
 * milliseconds instead of the minutes the real hardware takes.
 */

export interface SeestarSimOptions {
	/** How long a goto takes. Real hardware needs a minute or more; tests want milliseconds. */
	slewDurationMs?: number;
	/** How long the startup sequence takes. */
	startupDurationMs?: number;
	/** Interval at which a stacking session accumulates one frame. */
	stackFrameIntervalMs?: number;
	now?: () => number;
	latitude?: number;
	longitude?: number;
}

export interface FirmwareEvent {
	Event: string;
	state?: string;
	percent?: number;
	[key: string]: unknown;
}

interface Slew {
	fromRa: number;
	fromDec: number;
	toRa: number;
	toDec: number;
	startedAt: number;
	endsAt: number;
	/** `AutoGoto` for a plate-solved goto_target, `ScopeGoto` for a plain Alpaca slew. */
	event: string;
	targetName?: string;
}

interface StackSession {
	targetName: string;
	startedAt: number;
	sessionSeconds: number;
	gain: number;
	lpFilter: boolean;
	mosaic: { raPanels: number; decPanels: number; overlapPercent: number };
}

const DEFAULTS = {
	slewDurationMs: 120,
	startupDurationMs: 80,
	stackFrameIntervalMs: 20,
	latitude: 37.12,
	longitude: -123.45,
};

export class SeestarSim {
	private readonly options: Required<Omit<SeestarSimOptions, "now">> & {
		now: () => number;
	};

	// Mount
	rightAscension = 0;
	declination = 0;
	targetRightAscension = 0;
	targetDeclination = 0;
	tracking = false;
	atPark = true;
	atHome = false;
	siteLatitude: number;
	siteLongitude: number;
	siteElevation = 0;
	slewSettleTime = 0;

	// Camera / imaging
	gain = 80;
	exposureStackMs = 10_000;
	exposureContinuousMs = 500;
	lpFilterEnabled = false;
	ditherEnabled = true;
	dewHeaterPower = 0;
	wheelPosition = 1;
	focuserPosition = 1500;

	// Device
	batteryPercent = 92;
	firmwareVersion = "4.11";
	freeStorageMb = 51_200;

	/** Firmware events keyed the way `get_event_state` returns them. */
	private events = new Map<string, FirmwareEvent>();
	private slew: Slew | undefined;
	private startupEndsAt = 0;
	private stack: StackSession | undefined;
	private autoFocusEndsAt = 0;
	private parkEndsAt = 0;
	private lastImageIndex = 0;

	// Scheduler
	private schedule: { list: Array<Record<string, unknown>>; state: string } = {
		list: [],
		state: "stopped",
	};
	private scheduleItemId = 0;

	/** Every action the sim received, for assertions in tests. */
	readonly calls: Array<{ action: string; parameters: unknown }> = [];

	constructor(options: SeestarSimOptions = {}) {
		this.options = {
			slewDurationMs: options.slewDurationMs ?? DEFAULTS.slewDurationMs,
			startupDurationMs: options.startupDurationMs ?? DEFAULTS.startupDurationMs,
			stackFrameIntervalMs: options.stackFrameIntervalMs ?? DEFAULTS.stackFrameIntervalMs,
			latitude: options.latitude ?? DEFAULTS.latitude,
			longitude: options.longitude ?? DEFAULTS.longitude,
			now: options.now ?? Date.now,
		};
		this.siteLatitude = this.options.latitude;
		this.siteLongitude = this.options.longitude;
	}

	private now(): number {
		return this.options.now();
	}

	/** Apply everything that has become true since the last request. */
	settle(): void {
		const now = this.now();

		if (this.slew) {
			const { fromRa, fromDec, toRa, toDec, startedAt, endsAt, event } = this.slew;
			const span = Math.max(1, endsAt - startedAt);
			const progress = Math.min(1, (now - startedAt) / span);
			this.rightAscension = fromRa + (toRa - fromRa) * progress;
			this.declination = fromDec + (toDec - fromDec) * progress;

			if (progress >= 1) {
				this.rightAscension = toRa;
				this.declination = toDec;
				this.tracking = true;
				this.atPark = false;
				this.setEvent(event, { state: "complete", percent: 100 });
				this.slew = undefined;
			} else {
				this.setEvent(event, {
					state: "working",
					percent: Math.round(progress * 100),
				});
			}
		}

		if (this.startupEndsAt && now >= this.startupEndsAt) {
			this.startupEndsAt = 0;
			this.atPark = false;
			this.setEvent("Initialise", { state: "complete", percent: 100 });
		}

		if (this.parkEndsAt && now >= this.parkEndsAt) {
			this.parkEndsAt = 0;
			this.atPark = true;
			this.rightAscension = 0;
			this.declination = 0;
			this.setEvent("ScopeHome", { state: "complete", percent: 100 });
		}

		if (this.autoFocusEndsAt && now >= this.autoFocusEndsAt) {
			this.autoFocusEndsAt = 0;
			this.setEvent("AutoFocus", { state: "complete", percent: 100 });
		}

		if (this.stack) {
			const elapsed = now - this.stack.startedAt;
			const frames = Math.floor(elapsed / this.options.stackFrameIntervalMs);
			const done = elapsed >= this.stack.sessionSeconds * 1000;
			this.setEvent("Stack", {
				state: done ? "complete" : "working",
				stacked_frame: frames,
				dropped_frame: 0,
				target_name: this.stack.targetName,
			});
			if (frames > this.lastImageIndex) this.lastImageIndex = frames;
			if (done) this.stack = undefined;
		}
	}

	get slewing(): boolean {
		this.settle();
		// A mount on its way to the park position is still moving.
		return this.slew !== undefined || this.parkEndsAt !== 0;
	}

	get isStacking(): boolean {
		this.settle();
		return this.stack !== undefined;
	}

	/** The driver's own reply envelope: `{jsonrpc, TimeStamp, command, code, result}`. */
	private jsonResult(command: string, code: number, result: unknown): Record<string, unknown> {
		return { jsonrpc: "2.0", TimeStamp: this.now() / 1000, command, code, result };
	}

	/** Events keyed by name, plus the synthetic Scheduler and Mount entries the driver adds. */
	private eventMap(): Record<string, unknown> {
		const map: Record<string, unknown> = {};
		for (const [name, event] of this.events) map[name] = event;
		map.scheduler = {
			Event: "Scheduler",
			state: this.schedule.state,
			is_stacking: this.stack !== undefined,
			is_stacking_paused: false,
		};
		map.mount = { Event: "Mount", equ_mode: false };
		return map;
	}

	private setEvent(name: string, fields: Omit<FirmwareEvent, "Event">): void {
		this.events.set(name, { Event: name, ...fields });
	}

	/** Rough sidereal time, good enough for a simulator. */
	get siderealTime(): number {
		const hours = (this.now() / 3_600_000) % 24;
		return (hours + this.siteLongitude / 15 + 24) % 24;
	}

	/** Altitude/azimuth are not modelled properly; these are plausible stand-ins. */
	get altitude(): number {
		return this.atPark ? 0 : 45;
	}

	get azimuth(): number {
		return this.atPark ? 0 : 180;
	}

	startSlew(ra: number, dec: number, event = "ScopeGoto", targetName?: string): void {
		this.settle();
		const now = this.now();
		this.targetRightAscension = ra;
		this.targetDeclination = dec;
		this.slew = {
			fromRa: this.rightAscension,
			fromDec: this.declination,
			toRa: ra,
			toDec: dec,
			startedAt: now,
			endsAt: now + this.options.slewDurationMs,
			event,
			...(targetName ? { targetName } : {}),
		};
		this.atHome = false;
		this.setEvent(event, { state: "working", percent: 0 });
	}

	abortSlew(): void {
		this.settle();
		this.parkEndsAt = 0;
		if (this.slew) {
			this.setEvent(this.slew.event, { state: "cancel" });
			this.slew = undefined;
		}
	}

	/**
	 * Parking is asynchronous in ASCOM: the call returns at once and `atpark` turns true when the
	 * mount has actually got there. Modelled that way on purpose — clients that assume otherwise
	 * work against the real simulator and fail on hardware.
	 */
	park(): void {
		this.settle();
		this.slew = undefined;
		this.stack = undefined;
		this.tracking = false;
		this.parkEndsAt = this.now() + this.options.slewDurationMs;
		this.setEvent("ScopeHome", { state: "working", percent: 0 });
	}

	unpark(): void {
		this.parkEndsAt = 0;
		this.atPark = false;
	}

	findHome(): void {
		this.settle();
		this.atHome = true;
		this.setEvent("ScopeHome", { state: "complete" });
	}

	stopImaging(): void {
		this.settle();
		this.stack = undefined;
		this.slew = undefined;
		this.setEvent("View", { state: "cancel" });
	}

	/**
	 * Dispatch an Alpaca `action`, matching what `device/telescope.py` in seestar_alp handles.
	 * Unknown actions return `undefined`, which the HTTP layer turns into an empty result — the real
	 * server does the same rather than reporting an error.
	 */
	action(name: string, parameters: Record<string, unknown>): unknown {
		this.settle();
		this.calls.push({ action: name, parameters });

		switch (name) {
			case "method_sync":
				return this.methodSync(parameters);
			case "method_async":
				this.methodSync(parameters);
				return "async request sent.";
			case "get_event_state":
				// The driver returns a map keyed by event name, each value carrying its own Event field.
				return this.jsonResult("get_event_state", 0, this.eventMap());
			case "action_start_up_sequence": {
				if (typeof parameters.lat === "number" && parameters.lat !== 0) {
					this.siteLatitude = parameters.lat;
				}
				if (typeof parameters.lon === "number" && parameters.lon !== 0) {
					this.siteLongitude = parameters.lon;
				}
				this.startupEndsAt = this.now() + this.options.startupDurationMs;
				this.setEvent("Initialise", { state: "working", percent: 0 });
				return "Start up sequence started";
			}
			case "goto_target": {
				const { ra, dec } = this.resolveCoordinates(parameters);
				const targetName = String(parameters.target_name ?? "unnamed");
				this.startSlew(ra, dec, "AutoGoto", targetName);
				return "goto_target started";
			}
			case "stop_goto_target":
			case "force_stop_goto":
				this.abortSlew();
				return "goto stopped";
			case "is_goto":
				return this.slew !== undefined;
			case "is_goto_completed_ok":
				return this.slew === undefined && this.events.get("AutoGoto")?.state === "complete";
			case "start_stack": {
				this.startStack({
					target_name: this.stack?.targetName ?? "stack",
					gain: parameters.gain,
					session_time_sec: 600,
				});
				return "stack started";
			}
			case "start_mosaic":
			case "start_framed_mosaic":
			case "start_spectra": {
				// These build a one-item schedule, so they refuse while another one is running.
				if (this.schedule.state !== "stopped" && this.schedule.state !== "complete") {
					return this.jsonResult(
						name,
						-1,
						"An existing scheduler is active. Returned with no action.",
					);
				}
				const { ra, dec } = this.resolveCoordinates(parameters);
				if (ra >= 0) this.startSlew(ra, dec, "AutoGoto", String(parameters.target_name ?? ""));
				this.startStack(parameters);
				this.schedule = {
					list: [
						{
							schedule_item_id: `item-${++this.scheduleItemId}`,
							action: name,
							params: parameters,
						},
					],
					state: "working",
				};
				this.setEvent("Scheduler", { state: "working", is_stacking: true });
				return this.jsonResult(name, 0, { state: "working" });
			}
			case "adjust_focus": {
				const steps = Number(parameters.steps ?? 0);
				this.focuserPosition += steps;
				return this.focuserPosition;
			}
			case "action_set_dew_heater":
				this.dewHeaterPower = Number(parameters.heater ?? parameters.value ?? 0);
				return this.dewHeaterPower;
			case "action_set_exposure":
				this.exposureStackMs = Number(parameters.exp_ms ?? this.exposureStackMs);
				return this.exposureStackMs;
			case "play_sound":
				return { ok: true };
			case "get_last_image":
				return this.lastImage();
			case "get_pa_error":
				return { ok: true, error: "", pa_error: 0.02 };
			case "stop_plate_solve_loop":
				return { ok: true, error: "" };
			case "create_schedule":
				// The driver refuses to replace a schedule that is still running.
				if (this.schedule.state === "working") return "scheduler is still active";
				this.schedule = { list: [], state: "stopped" };
				return this.jsonResult(name, 0, this.schedule);
			case "get_schedule":
				return this.jsonResult(name, 0, {
					...this.schedule,
					is_stacking: this.isStacking,
					...(this.schedule.state === "working" && this.schedule.list[0]
						? { current_item_id: this.schedule.list[0].schedule_item_id }
						: {}),
				});
			case "add_schedule_item": {
				const item = {
					schedule_item_id: `item-${++this.scheduleItemId}`,
					...parameters,
				};
				this.schedule.list.push(item);
				return this.jsonResult(name, 0, this.schedule);
			}
			case "remove_schedule_item": {
				const id = String(parameters.schedule_item_id ?? "");
				this.schedule.list = this.schedule.list.filter((item) => item.schedule_item_id !== id);
				return this.jsonResult(name, 0, this.schedule);
			}
			case "start_scheduler":
				this.schedule.state = "working";
				this.setEvent("Scheduler", { state: "working" });
				return this.jsonResult(name, 0, this.schedule);
			case "stop_scheduler":
				this.schedule.state = "stopped";
				this.stack = undefined;
				this.setEvent("Scheduler", { state: "stopped" });
				return this.jsonResult(name, 0, this.schedule);
			case "pause_scheduler":
				this.schedule.state = "paused";
				return this.jsonResult(name, 0, this.schedule);
			case "continue_scheduler":
				this.schedule.state = "working";
				return this.jsonResult(name, 0, this.schedule);
			case "skip_scheduler_cur_item":
				this.schedule.list.shift();
				return this.jsonResult(name, 0, this.schedule);
			case "export_schedule":
				return this.schedule.list;
			case "import_schedule":
				this.schedule.list = Array.isArray(parameters.list)
					? (parameters.list as Array<Record<string, unknown>>)
					: [];
				return this.schedule;
			default:
				return undefined;
		}
	}

	/** The raw firmware JSON-RPC passthrough (`method_sync` / `method_async`). */
	private methodSync(parameters: Record<string, unknown>): unknown {
		const method = String(parameters.method ?? "");
		// The firmware replies in its own envelope and the driver passes it through untouched.
		return {
			jsonrpc: "2.0",
			TimeStamp: this.now() / 1000,
			method,
			code: 0,
			...(this.firmwareCall(method, parameters.params) as Record<string, unknown>),
		};
	}

	private firmwareCall(method: string, params: unknown): unknown {
		switch (method) {
			case "get_device_state":
				return {
					result: {
						device: {
							firmware_ver_string: this.firmwareVersion,
							name: "Seestar S50 Pro",
							product_model: "Seestar S50P",
						},
						pi_status: {
							battery_capacity: this.batteryPercent,
							charger_status: "Discharging",
						},
						storage: {
							storage_volume: [{ freeMB: this.freeStorageMb, name: "emmc" }],
						},
						mount: { equ_mode: false, move_type: "none" },
						setting: {
							exp_ms: {
								stack_l: this.exposureStackMs,
								continuous: this.exposureContinuousMs,
							},
							stack_lenhance: this.lpFilterEnabled,
						},
					},
				};
			case "get_view_state":
				return {
					result: {
						View: {
							stage: this.stack ? "Stack" : "Idle",
							mode: this.stack ? "star" : "",
							target_name: this.stack?.targetName ?? "",
							state: this.stack ? "working" : "idle",
						},
					},
				};
			case "scope_get_equ_coord":
			case "scope_get_ra_dec":
				return { result: { ra: this.rightAscension, dec: this.declination } };
			case "scope_get_track_state":
				return { result: this.tracking };
			case "scope_set_track_state":
				this.tracking = Boolean(params);
				return { result: this.tracking };
			case "scope_park":
				this.park();
				return { result: true };
			case "scope_sync": {
				if (Array.isArray(params) && params.length >= 2) {
					this.rightAscension = Number(params[0]);
					this.declination = Number(params[1]);
				}
				return { result: true };
			}
			case "scope_speed_move":
				return { result: true };
			case "get_setting":
				return {
					result: {
						exp_ms: {
							stack_l: this.exposureStackMs,
							continuous: this.exposureContinuousMs,
						},
						stack_lenhance: this.lpFilterEnabled,
						stack_dither: { enable: this.ditherEnabled, pix: 50, interval: 10 },
						auto_3ppa_calib: true,
					},
				};
			case "set_setting": {
				const settings = (params ?? {}) as Record<string, unknown>;
				const exposures = settings.exp_ms as { stack_l?: number; continuous?: number } | undefined;
				if (exposures?.stack_l !== undefined) this.exposureStackMs = exposures.stack_l;
				if (exposures?.continuous !== undefined) this.exposureContinuousMs = exposures.continuous;
				if (typeof settings.stack_lenhance === "boolean") {
					this.lpFilterEnabled = settings.stack_lenhance;
				}
				const dither = settings.stack_dither as { enable?: boolean } | undefined;
				if (dither?.enable !== undefined) this.ditherEnabled = dither.enable;
				return { result: true };
			}
			case "get_control_value":
				return { result: { value: this.gain } };
			case "set_control_value": {
				if (Array.isArray(params) && String(params[0]).toLowerCase() === "gain") {
					this.gain = Number(params[1]);
				}
				return { result: true };
			}
			case "get_focuser_position":
				return { result: this.focuserPosition };
			case "start_auto_focuse":
				this.autoFocusEndsAt = this.now() + this.options.slewDurationMs;
				this.setEvent("AutoFocus", { state: "working", percent: 0 });
				return { result: true };
			case "stop_auto_focuse":
				this.autoFocusEndsAt = 0;
				this.setEvent("AutoFocus", { state: "cancel" });
				return { result: true };
			case "get_wheel_position":
			case "get_wheel_state":
				return { result: { position: this.wheelPosition, state: "idle" } };
			case "set_wheel_position":
				if (Array.isArray(params)) this.wheelPosition = Number(params[0]);
				return { result: true };
			case "pi_output_set2": {
				const heater = (params as { heater?: { value?: number } } | undefined)?.heater;
				if (heater?.value !== undefined) this.dewHeaterPower = heater.value;
				return { result: true };
			}
			case "iscope_stop_view":
				this.stopImaging();
				return { result: true };
			case "start_solve":
				this.setEvent("PlateSolve", { state: "complete", percent: 100 });
				return { result: true };
			case "get_last_solve_result":
			case "get_solve_result":
				return {
					result: {
						ra: this.rightAscension,
						dec: this.declination,
						state: "complete",
					},
				};
			case "pi_is_verified":
				return { result: true };
			case "pi_shutdown":
			case "pi_reboot":
				this.park();
				return { result: true };
			case "get_albums":
				return {
					result: {
						path: "MyWorks",
						list: [
							{
								name: "Album",
								files: [{ name: "M31", thn: "M31_thn.jpg" }],
							},
						],
					},
				};
			default:
				return { result: {}, method };
		}
	}

	/** `ra: -1` means "wherever the scope is pointing" in the Seestar API. */
	private resolveCoordinates(parameters: Record<string, unknown>): {
		ra: number;
		dec: number;
	} {
		const ra = parseCoordinate(parameters.ra, this.rightAscension, 15);
		const dec = parseCoordinate(parameters.dec, this.declination, 1);
		return { ra, dec };
	}

	private startStack(parameters: Record<string, unknown>): void {
		const mosaic = {
			raPanels: Number(parameters.ra_num ?? 1),
			decPanels: Number(parameters.dec_num ?? 1),
			overlapPercent: Number(parameters.panel_overlap_percent ?? 0),
		};
		if (parameters.gain !== undefined) this.gain = Number(parameters.gain);
		this.stack = {
			targetName: String(parameters.target_name ?? "target"),
			startedAt: this.now(),
			sessionSeconds: Number(parameters.session_time_sec ?? 600),
			gain: this.gain,
			lpFilter: Boolean(parameters.is_use_lp_filter ?? this.lpFilterEnabled),
			mosaic,
		};
		this.setEvent("Stack", {
			state: "working",
			stacked_frame: 0,
			dropped_frame: 0,
		});
	}

	private lastImage(): { url: string; name: string } {
		const name = this.stack?.targetName ?? "M31";
		return {
			url: `http://seestar.local/MyWorks/${name}/Light_${name}_${this.lastImageIndex}.jpg`,
			name,
		};
	}
}

/**
 * Seestar accepts coordinates as numbers or as sexagesimal strings (`6h31m54.23s`, `+4d56m26.4s`),
 * and uses -1 to mean "keep the current position".
 */
function parseCoordinate(value: unknown, fallback: number, degreesPerUnit: number): number {
	if (value === undefined || value === null) return fallback;
	if (typeof value === "number") return value < 0 ? fallback : value;

	const text = String(value).trim();
	const match = text.match(/^([+-]?[\d.]+)[hd:\s]+([\d.]+)[m':\s]+([\d.]+)[s"]?$/i);
	if (!match) {
		const parsed = Number(text);
		return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
	}

	const [, degreesText = "0", minutesText = "0", secondsText = "0"] = match;
	const degrees = Number(degreesText);
	const sign = degreesText.trim().startsWith("-") ? -1 : 1;
	const magnitude = Math.abs(degrees) + Number(minutesText) / 60 + Number(secondsText) / 3600;
	// Callers pass 15 for RA (hours) and 1 for Dec (degrees) purely to document the unit.
	void degreesPerUnit;
	return sign * magnitude;
}
