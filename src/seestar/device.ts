import type { SeestarActions } from "./actions.js";
import { parseEvents, type SeestarEvent } from "./events.js";

/**
 * High-level Seestar operations.
 *
 * One layer above the raw actions: named methods, typed arguments, and the firmware's nested reply
 * shapes flattened into something a tool can render without knowing the protocol.
 */

export interface SeestarState {
	name?: string;
	model?: string;
	firmware?: string;
	batteryPercent?: number;
	charging?: boolean;
	temperatureC?: number;
	freeStorageMb?: number;
	totalStorageMb?: number;
	equatorialMode?: boolean;
	raw: Record<string, unknown>;
}

export interface ViewState {
	/** `Stack`, `AutoGoto`, `AutoFocus`, `Idle`… — what the telescope is busy with. */
	stage?: string;
	mode?: string;
	targetName?: string;
	state?: string;
	raw: Record<string, unknown>;
}

export interface SeestarSettings {
	stackExposureMs?: number;
	previewExposureMs?: number;
	gain?: number;
	lpFilter?: boolean;
	dither?: { enabled?: boolean; pixels?: number; intervalFrames?: number };
	raw: Record<string, unknown>;
}

export interface GotoTargetOptions {
	targetName: string;
	ra: number | string;
	dec: number | string;
	isJ2000?: boolean;
}

export interface ImagingOptions {
	targetName: string;
	/** Numbers are RA hours / Dec degrees; strings may be sexagesimal (`6h31m54s`). */
	ra?: number | string;
	dec?: number | string;
	isJ2000?: boolean;
	sessionSeconds?: number;
	gain?: number;
	lpFilter?: boolean;
	/** Mosaic grid. 1x1 — the default — is a single framing. */
	raPanels?: number;
	decPanels?: number;
	panelOverlapPercent?: number;
	autofocus?: boolean;
}

export interface LastImage {
	url: string;
	/**
	 * Null when the album holds no matching frame yet — the driver builds this reply by scanning the
	 * newest album and leaves the name unset if nothing matches, so an empty session reports null
	 * here and a URL that points at nothing.
	 */
	name: string | null;
}

/** `-1` is how the Seestar API says "wherever the telescope is already pointing". */
const CURRENT_POSITION = -1;

export class SeestarDevice {
	constructor(readonly actions: SeestarActions) {}

	/** Unfold the arm, level, and calibrate. Nothing else works until this has run. */
	startup(latitude?: number, longitude?: number): Promise<unknown> {
		return this.actions.call("action_start_up_sequence", {
			lat: latitude ?? 0,
			lon: longitude ?? 0,
		});
	}

	/**
	 * Go to a target and centre it.
	 *
	 * Unlike a plain Alpaca slew this plate-solves and corrects, which is what makes a Seestar land
	 * on the object rather than near it.
	 */
	gotoTarget(options: GotoTargetOptions): Promise<unknown> {
		return this.actions.call("goto_target", {
			target_name: options.targetName,
			ra: options.ra,
			dec: options.dec,
			is_j2000: options.isJ2000 ?? false,
		});
	}

	stopGoto(force = false): Promise<unknown> {
		return this.actions.call(force ? "force_stop_goto" : "stop_goto_target", {});
	}

	isGoto(): Promise<boolean> {
		return this.actions.call<boolean>("is_goto", {});
	}

	async events(): Promise<SeestarEvent[]> {
		return parseEvents(await this.actions.call("get_event_state", {}));
	}

	/** Battery, storage, firmware, mount mode. */
	async state(): Promise<SeestarState> {
		const raw = await this.actions.methodSync<Record<string, unknown>>("get_device_state");
		return parseState(raw ?? {});
	}

	async viewState(): Promise<ViewState> {
		const raw = await this.actions.methodSync<Record<string, unknown>>("get_view_state");
		const view = (raw?.View ?? {}) as Record<string, unknown>;
		return {
			...text("stage", view.stage),
			...text("mode", view.mode),
			...text("targetName", view.target_name),
			...text("state", view.state),
			raw: raw ?? {},
		};
	}

	/**
	 * Start an imaging session.
	 *
	 * `start_mosaic` is the general entry point: with a 1x1 grid it is an ordinary single-target
	 * session, and the driver builds a one-item schedule out of it either way. It refuses while
	 * another schedule is running.
	 */
	startImaging(options: ImagingOptions): Promise<unknown> {
		const sessionSeconds = options.sessionSeconds ?? 600;
		return this.actions.call("start_mosaic", {
			target_name: options.targetName,
			ra: options.ra ?? CURRENT_POSITION,
			dec: options.dec ?? CURRENT_POSITION,
			is_j2000: options.isJ2000 ?? false,
			is_use_lp_filter: options.lpFilter ?? false,
			is_use_autofocus: options.autofocus ?? false,
			// Newer drivers want panel_time_sec; session_time_sec is kept for older ones.
			panel_time_sec: sessionSeconds,
			session_time_sec: sessionSeconds,
			ra_num: options.raPanels ?? 1,
			dec_num: options.decPanels ?? 1,
			panel_overlap_percent: options.panelOverlapPercent ?? 20,
			gain: options.gain ?? 80,
		});
	}

	/** Restart stacking on whatever the telescope is already looking at. */
	startStack(gain?: number, restart = true): Promise<unknown> {
		return this.actions.call("start_stack", {
			...(gain !== undefined ? { gain } : {}),
			restart,
		});
	}

	/** Stop the current view. `stage` narrows it, e.g. `Stack` or `AutoGoto`. */
	stopImaging(stage?: string): Promise<unknown> {
		return this.actions.methodSync("iscope_stop_view", stage ? { stage } : undefined);
	}

	/** The most recent frame, as a URL served by the telescope itself. */
	lastImage(options: { subframe?: boolean; thumbnail?: boolean } = {}): Promise<LastImage> {
		return this.actions.call<LastImage>("get_last_image", {
			is_subframe: options.subframe ?? false,
			is_thumb: options.thumbnail ?? false,
		});
	}

	startAutofocus(): Promise<unknown> {
		return this.actions.methodSync("start_auto_focuse");
	}

	stopAutofocus(): Promise<unknown> {
		return this.actions.methodSync("stop_auto_focuse");
	}

	adjustFocus(steps: number): Promise<unknown> {
		return this.actions.call("adjust_focus", { steps });
	}

	focuserPosition(): Promise<number> {
		return this.actions.methodSync<number>("get_focuser_position");
	}

	async settings(): Promise<SeestarSettings> {
		const [raw, gain] = await Promise.all([
			this.actions.methodSync<Record<string, unknown>>("get_setting"),
			this.actions
				.methodSync<{ value?: number } | number>("get_control_value", ["gain"])
				.catch(() => undefined),
		]);
		return parseSettings(raw ?? {}, gain);
	}

	/** Only the settings that were asked for are sent; the firmware merges the rest. */
	async updateSettings(update: {
		stackExposureMs?: number;
		previewExposureMs?: number;
		lpFilter?: boolean;
		dither?: { enabled?: boolean; pixels?: number; intervalFrames?: number };
		gain?: number;
	}): Promise<void> {
		const settings: Record<string, unknown> = {};

		if (update.stackExposureMs !== undefined || update.previewExposureMs !== undefined) {
			settings.exp_ms = {
				...(update.stackExposureMs !== undefined ? { stack_l: update.stackExposureMs } : {}),
				...(update.previewExposureMs !== undefined ? { continuous: update.previewExposureMs } : {}),
			};
		}
		if (update.lpFilter !== undefined) settings.stack_lenhance = update.lpFilter;
		if (update.dither) {
			settings.stack_dither = {
				...(update.dither.enabled !== undefined ? { enable: update.dither.enabled } : {}),
				...(update.dither.pixels !== undefined ? { pix: update.dither.pixels } : {}),
				...(update.dither.intervalFrames !== undefined
					? { interval: update.dither.intervalFrames }
					: {}),
			};
		}

		if (Object.keys(settings).length > 0) {
			await this.actions.methodSync("set_setting", settings);
		}
		if (update.gain !== undefined) {
			await this.actions.methodSync("set_control_value", ["gain", update.gain]);
		}
	}

	wheelState(): Promise<unknown> {
		return this.actions.methodSync("get_wheel_state");
	}

	setWheelPosition(position: number): Promise<unknown> {
		return this.actions.methodSync("set_wheel_position", [position]);
	}

	/** Dew heater power, 0-100. */
	setDewHeater(power: number): Promise<unknown> {
		return this.actions.methodSync("pi_output_set2", {
			heater: { state: power > 0, value: power },
		});
	}

	solve(): Promise<unknown> {
		return this.actions.methodSync("start_solve");
	}

	lastSolveResult(): Promise<unknown> {
		return this.actions.methodSync("get_last_solve_result");
	}

	shutdown(): Promise<unknown> {
		return this.actions.methodSync("pi_shutdown");
	}

	reboot(): Promise<unknown> {
		return this.actions.methodSync("pi_reboot");
	}
}

function parseState(raw: Record<string, unknown>): SeestarState {
	const device = (raw.device ?? {}) as Record<string, unknown>;
	const pi = (raw.pi_status ?? {}) as Record<string, unknown>;
	const storage = (raw.storage ?? {}) as Record<string, unknown>;
	const mount = (raw.mount ?? {}) as Record<string, unknown>;
	const volumes = Array.isArray(storage.storage_volume)
		? (storage.storage_volume as Array<Record<string, unknown>>)
		: [];
	const volume = volumes[0] ?? {};
	const charger = typeof pi.charger_status === "string" ? pi.charger_status : undefined;

	return {
		...text("name", device.name),
		...text("model", device.product_model),
		...text("firmware", device.firmware_ver_string),
		...number("batteryPercent", pi.battery_capacity),
		...(charger ? { charging: charger.toLowerCase() !== "discharging" } : {}),
		...number("temperatureC", pi.temp),
		...number("freeStorageMb", volume.freeMB),
		...number("totalStorageMb", volume.totalMB),
		...(typeof mount.equ_mode === "boolean" ? { equatorialMode: mount.equ_mode } : {}),
		raw,
	};
}

function parseSettings(
	raw: Record<string, unknown>,
	gain: { value?: number } | number | undefined,
): SeestarSettings {
	const exposures = (raw.exp_ms ?? {}) as Record<string, unknown>;
	const dither = (raw.stack_dither ?? {}) as Record<string, unknown>;
	const gainValue = typeof gain === "number" ? gain : gain?.value;

	return {
		...number("stackExposureMs", exposures.stack_l),
		...number("previewExposureMs", exposures.continuous),
		...number("gain", gainValue),
		...(typeof raw.stack_lenhance === "boolean" ? { lpFilter: raw.stack_lenhance } : {}),
		dither: {
			...(typeof dither.enable === "boolean" ? { enabled: dither.enable } : {}),
			...number("pixels", dither.pix),
			...number("intervalFrames", dither.interval),
		},
		raw,
	};
}

function text<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
	return typeof value === "string" && value ? ({ [key]: value } as Record<K, string>) : {};
}

function number<K extends string>(key: K, value: unknown): Partial<Record<K, number>> {
	return typeof value === "number" ? ({ [key]: value } as Record<K, number>) : {};
}
