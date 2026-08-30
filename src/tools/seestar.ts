import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { formatFields } from "../format.js";
import { renderEvents, type SeestarEvent, waitForEvent } from "../seestar/events.js";
import type { Session } from "../session.js";
import { guard, textResult } from "./result.js";

/**
 * Seestar-specific tools.
 *
 * These go through the driver's `action` endpoint rather than standard ASCOM properties, which is
 * where everything that makes a Seestar a Seestar lives: the startup sequence, plate-solved gotos,
 * the filter wheel, the dew heater, and the firmware event stream.
 */
export function registerSeestarTools(server: McpServer, session: Session): void {
	const { readOnly } = session.config;

	server.registerTool(
		"seestar_state",
		{
			title: "Seestar device state",
			description:
				"Battery, storage, firmware and mount mode. Check the battery before starting a long " +
				"session — the telescope will stop mid-session when it runs out.",
			inputSchema: z.object({}),
			outputSchema: z.object({
				name: z.string().optional(),
				model: z.string().optional(),
				firmware: z.string().optional(),
				battery_percent: z.number().optional(),
				charging: z.boolean().optional(),
				temperature_c: z.number().optional(),
				free_storage_mb: z.number().optional(),
				equatorial_mode: z.boolean().optional(),
			}),
			annotations: { readOnlyHint: true },
		},
		async () =>
			guard(async () => {
				const state = await session.seestar().state();

				const text = formatFields([
					["model", state.model ?? state.name],
					["firmware", state.firmware],
					[
						"battery",
						state.batteryPercent === undefined
							? undefined
							: `${state.batteryPercent}%${state.charging ? " (charging)" : ""}`,
					],
					["temperature", state.temperatureC === undefined ? undefined : `${state.temperatureC}°C`],
					[
						"free storage",
						state.freeStorageMb === undefined
							? undefined
							: `${(state.freeStorageMb / 1024).toFixed(1)} GB`,
					],
					[
						"mount mode",
						state.equatorialMode === undefined
							? undefined
							: state.equatorialMode
								? "equatorial"
								: "alt-az",
					],
				]);

				return textResult(text, {
					...pick("name", state.name),
					...pick("model", state.model),
					...pick("firmware", state.firmware),
					...pick("battery_percent", state.batteryPercent),
					...pick("charging", state.charging),
					...pick("temperature_c", state.temperatureC),
					...pick("free_storage_mb", state.freeStorageMb),
					...pick("equatorial_mode", state.equatorialMode),
				});
			}),
	);

	server.registerTool(
		"seestar_events",
		{
			title: "Operation progress",
			description:
				"The firmware event stream: what the telescope is doing and how far along it is. This " +
				"is the way to follow a goto, an autofocus, a plate solve or a stacking session — poll " +
				"it instead of waiting.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async () =>
			guard(async () => {
				const events = await session.seestar().events();
				return textResult(renderEvents(events), {
					events: events.map((event) => ({
						name: event.name,
						...pick("state", event.state),
						...pick("percent", event.percent),
					})),
				});
			}),
	);

	server.registerTool(
		"seestar_view_state",
		{
			title: "Current view",
			description:
				"What the telescope is currently looking at and in which stage (Stack, AutoGoto, Idle).",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async () =>
			guard(async () => {
				const view = await session.seestar().viewState();
				return textResult(
					formatFields([
						["stage", view.stage ?? "idle"],
						["target", view.targetName],
						["mode", view.mode],
						["state", view.state],
					]),
					{
						...pick("stage", view.stage),
						...pick("target_name", view.targetName),
						...pick("mode", view.mode),
						...pick("state", view.state),
					},
				);
			}),
	);

	server.registerTool(
		"seestar_settings",
		{
			title: "Imaging settings",
			description:
				"Read the exposure, gain, light-pollution filter and dithering settings the telescope " +
				"will use for the next session.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async () =>
			guard(async () => {
				const settings = await session.seestar().settings();
				return textResult(
					formatFields([
						[
							"stack exposure",
							settings.stackExposureMs === undefined
								? undefined
								: `${settings.stackExposureMs / 1000}s per frame`,
						],
						[
							"preview exposure",
							settings.previewExposureMs === undefined
								? undefined
								: `${settings.previewExposureMs}ms`,
						],
						["gain", settings.gain?.toString()],
						[
							"LP filter",
							settings.lpFilter === undefined ? undefined : settings.lpFilter ? "on" : "off",
						],
						[
							"dither",
							settings.dither?.enabled === undefined
								? undefined
								: settings.dither.enabled
									? `on, ${settings.dither.pixels ?? "?"} px every ${settings.dither.intervalFrames ?? "?"} frames`
									: "off",
						],
					]),
					{
						...pick("stack_exposure_ms", settings.stackExposureMs),
						...pick("preview_exposure_ms", settings.previewExposureMs),
						...pick("gain", settings.gain),
						...pick("lp_filter", settings.lpFilter),
						dither: settings.dither ?? {},
					},
				);
			}),
	);

	if (readOnly) return;

	server.registerTool(
		"seestar_startup",
		{
			title: "Run the startup sequence",
			description:
				"Unfold the arm, level the mount and calibrate. Run this first in a session — most " +
				"other operations fail until it has completed. Follow progress with seestar_events " +
				"(the Initialise event).",
			inputSchema: z.object({
				latitude: z
					.number()
					.min(-90)
					.max(90)
					.optional()
					.describe("Observing site latitude. Omit to use the telescope's configured location."),
				longitude: z.number().min(-180).max(180).optional(),
			}),
		},
		async ({ latitude, longitude }) =>
			guard(async () => {
				const result = await session.seestar().startup(latitude, longitude);
				return textResult(
					`Startup sequence started.\n\nPoll seestar_events until Initialise reports complete.\n\n${describe(result)}`,
				);
			}),
	);

	server.registerTool(
		"seestar_goto_target",
		{
			title: "Go to a target",
			description:
				"Point the telescope at a target and centre it using plate solving. Prefer this over " +
				"telescope_goto on a Seestar: a plain slew lands close, this lands on the object. " +
				"Follow the AutoGoto event with seestar_events.",
			inputSchema: z.object({
				target_name: z.string().describe("Name for the target, used in file names, e.g. M31"),
				ra: z
					.union([z.number().min(0).max(24), z.string()])
					.describe("Right ascension in hours, or sexagesimal like 6h31m54.23s"),
				dec: z
					.union([z.number().min(-90).max(90), z.string()])
					.describe("Declination in degrees, or sexagesimal like +4d56m26.4s"),
				is_j2000: z
					.boolean()
					.optional()
					.describe("True when the coordinates are J2000 (catalogue) rather than of-date"),
				wait: z
					.boolean()
					.optional()
					.describe("Wait for the goto to finish. Default false — poll seestar_events instead."),
				timeout_s: z.number().min(5).max(900).optional().describe("Wait timeout, default 180s."),
			}),
		},
		async ({ target_name, ra, dec, is_j2000, wait, timeout_s }) =>
			guard(async () => {
				const result = await session.seestar().gotoTarget({
					targetName: target_name,
					ra,
					dec,
					...(is_j2000 !== undefined ? { isJ2000: is_j2000 } : {}),
				});

				// The driver answers `false` when a goto is already running rather than failing.
				if (result === false) {
					return textResult(
						"The telescope is already in a goto. Stop it with seestar_stop_goto, or wait for the " +
							"AutoGoto event to complete.",
					);
				}

				const started = { target_name, ra, dec, is_j2000: is_j2000 ?? false };
				if (!wait) {
					return textResult(
						`Going to ${target_name}.\n\nPoll seestar_events until AutoGoto reports complete.`,
						started,
					);
				}

				const outcome = await settle(session, "AutoGoto", timeout_s ?? 180);
				return textResult(`${outcome.text}\n\n${renderEvents(outcome.events)}`, {
					...started,
					completed: outcome.done,
				});
			}),
	);

	server.registerTool(
		"seestar_stop_goto",
		{
			title: "Stop a goto",
			description: "Interrupt a goto in progress.",
			inputSchema: z.object({
				force: z
					.boolean()
					.optional()
					.describe("Force the mount to stop even if it is mid-correction"),
			}),
		},
		async ({ force }) =>
			guard(async () => {
				await session.seestar().stopGoto(force ?? false);
				return textResult("Goto stopped.");
			}),
	);

	server.registerTool(
		"seestar_autofocus",
		{
			title: "Autofocus",
			description:
				"Start or stop the autofocus routine, or nudge the focuser by a number of steps. " +
				"Follow the AutoFocus event with seestar_events.",
			inputSchema: z.object({
				operation: z
					.enum(["start", "stop", "adjust", "position"])
					.describe("start/stop the routine, adjust by steps, or read the current position"),
				steps: z
					.number()
					.int()
					.min(-2000)
					.max(2000)
					.optional()
					.describe("Steps to move when operation is adjust; negative moves inward"),
			}),
		},
		async ({ operation, steps }) =>
			guard(async () => {
				const seestar = session.seestar();

				switch (operation) {
					case "start":
						await seestar.startAutofocus();
						return textResult("Autofocus started. Poll seestar_events for the AutoFocus event.");
					case "stop":
						await seestar.stopAutofocus();
						return textResult("Autofocus stopped.");
					case "adjust": {
						if (steps === undefined) {
							return textResult("Pass steps to adjust the focuser, e.g. steps: 20.");
						}
						const position = await seestar.adjustFocus(steps);
						return textResult(`Focuser moved by ${steps} steps. Now at ${describe(position)}.`);
					}
					default: {
						const position = await seestar.focuserPosition();
						return textResult(`Focuser position: ${describe(position)}`, {
							position: position as unknown,
						});
					}
				}
			}),
	);

	server.registerTool(
		"seestar_set_settings",
		{
			title: "Change imaging settings",
			description:
				"Set exposure, gain, the light-pollution filter or dithering. Only the fields you pass " +
				"are changed.",
			inputSchema: z.object({
				stack_exposure_s: z
					.number()
					.min(0.1)
					.max(60)
					.optional()
					.describe("Exposure per stacked frame, in seconds (10 or 30 are typical)"),
				preview_exposure_ms: z.number().min(1).max(5000).optional(),
				gain: z.number().int().min(0).max(300).optional().describe("Sensor gain, typically 80"),
				lp_filter: z.boolean().optional().describe("Light-pollution filter"),
				dither_enabled: z.boolean().optional(),
				dither_pixels: z.number().int().min(1).max(500).optional(),
				dither_interval_frames: z.number().int().min(1).max(100).optional(),
			}),
		},
		async (input) =>
			guard(async () => {
				const dither = {
					...(input.dither_enabled !== undefined ? { enabled: input.dither_enabled } : {}),
					...(input.dither_pixels !== undefined ? { pixels: input.dither_pixels } : {}),
					...(input.dither_interval_frames !== undefined
						? { intervalFrames: input.dither_interval_frames }
						: {}),
				};

				await session.seestar().updateSettings({
					...(input.stack_exposure_s !== undefined
						? { stackExposureMs: Math.round(input.stack_exposure_s * 1000) }
						: {}),
					...(input.preview_exposure_ms !== undefined
						? { previewExposureMs: input.preview_exposure_ms }
						: {}),
					...(input.gain !== undefined ? { gain: input.gain } : {}),
					...(input.lp_filter !== undefined ? { lpFilter: input.lp_filter } : {}),
					...(Object.keys(dither).length > 0 ? { dither } : {}),
				});

				return textResult("Settings updated. Read them back with seestar_settings.");
			}),
	);

	server.registerTool(
		"seestar_filter_wheel",
		{
			title: "Filter wheel",
			description:
				"Read or move the filter wheel. Position 1 is the clear/IR-cut slot, 2 the " +
				"light-pollution filter, 3 the dark slot used for building a dark library.",
			inputSchema: z.object({
				position: z.number().int().min(1).max(3).optional().describe("Omit to read the position"),
			}),
		},
		async ({ position }) =>
			guard(async () => {
				const seestar = session.seestar();
				if (position === undefined) {
					const state = await seestar.wheelState();
					return textResult(`Filter wheel: ${describe(state)}`, { state: state as unknown });
				}
				await seestar.setWheelPosition(position);
				return textResult(`Filter wheel moved to position ${position}.`, { position });
			}),
	);

	server.registerTool(
		"seestar_dew_heater",
		{
			title: "Dew heater",
			description:
				"Set dew heater power from 0 to 100. Run it when the lens fogs up on a humid night.",
			inputSchema: z.object({ power: z.number().int().min(0).max(100) }),
		},
		async ({ power }) =>
			guard(async () => {
				await session.seestar().setDewHeater(power);
				return textResult(power === 0 ? "Dew heater off." : `Dew heater at ${power}%.`, { power });
			}),
	);
}

/**
 * Wait for one firmware event to finish, and describe how it went.
 *
 * The poll interval is derived from the timeout so a short wait stays responsive without hammering
 * a telescope that is going to take minutes.
 */
async function settle(
	session: Session,
	eventName: string,
	timeoutSeconds: number,
): Promise<{ done: boolean; text: string; events: SeestarEvent[] }> {
	const timeoutMs = timeoutSeconds * 1000;
	const result = await waitForEvent(session.seestar().actions, eventName, {
		timeoutMs,
		pollIntervalMs: Math.max(100, Math.min(1_000, timeoutMs / 10)),
	});

	const text = result.done
		? `${eventName} complete.`
		: result.failed
			? `${eventName} did not finish: the telescope reported ${result.event?.state}.`
			: `Still working after ${timeoutSeconds}s — the operation is still running.`;

	return { done: result.done, text, events: result.events };
}

function pick<T>(key: string, value: T | undefined): Record<string, T> {
	return value === undefined ? {} : { [key]: value };
}

function describe(value: unknown): string {
	if (value === null || value === undefined) return "ok";
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return JSON.stringify(value);
}
