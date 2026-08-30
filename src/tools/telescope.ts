import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { TelescopeStatus } from "../alpaca/devices/telescope.js";
import {
	formatBoolean,
	formatDeclination,
	formatDegrees,
	formatFields,
	formatRightAscension,
	formatUnavailable,
} from "../format.js";
import type { Session } from "../session.js";
import { guard, textResult } from "./result.js";

const raSchema = z.number().min(0).max(24).describe("Right ascension in HOURS (0-24), not degrees");

const decSchema = z.number().min(-90).max(90).describe("Declination in degrees (-90 to 90)");

const statusOutput = z.object({
	connected: z.boolean(),
	right_ascension_hours: z.number().optional(),
	declination_degrees: z.number().optional(),
	altitude_degrees: z.number().optional(),
	azimuth_degrees: z.number().optional(),
	slewing: z.boolean().optional(),
	tracking: z.boolean().optional(),
	at_park: z.boolean().optional(),
	at_home: z.boolean().optional(),
	site_latitude: z.number().optional(),
	site_longitude: z.number().optional(),
	unavailable: z.record(z.string(), z.string()),
});

/** Standard ASCOM telescope tools. They work against any Alpaca mount, Seestar included. */
export function registerTelescopeTools(server: McpServer, session: Session): void {
	const { readOnly, allowRaw } = session.config;

	server.registerTool(
		"telescope_status",
		{
			title: "Telescope status",
			description:
				"Where the telescope is pointing and what it is doing: coordinates, slewing, tracking, " +
				"park state and site location. Read this before and after any movement.",
			inputSchema: z.object({}),
			outputSchema: statusOutput,
			annotations: { readOnlyHint: true },
		},
		async () =>
			guard(async () => {
				const status = await session.telescope().status();
				// A disconnected device answers a handful of properties and refuses the rest, which
				// reads like a broken telescope unless we say what it actually means.
				const hint = status.connected
					? ""
					: "\n\nThe device is not connected — run device_connect.";
				return textResult(`${renderStatus(status)}${hint}`, toStructuredStatus(status));
			}),
	);

	if (readOnly) return;

	server.registerTool(
		"telescope_goto",
		{
			title: "Slew to coordinates",
			description:
				"Slew the telescope to equatorial coordinates and return immediately. For a Seestar, " +
				"prefer seestar_goto_target: it plate-solves and centres the target, which a raw slew " +
				"does not. Poll telescope_status to see when the slew finishes.",
			inputSchema: z.object({
				ra: raSchema,
				dec: decSchema,
				wait: z
					.boolean()
					.optional()
					.describe("Wait for the slew to finish before returning. Default false."),
				timeout_s: z.number().min(1).max(600).optional().describe("Wait timeout, default 120s."),
			}),
			annotations: { idempotentHint: false },
		},
		async ({ ra, dec, wait, timeout_s }) =>
			guard(async () => {
				const telescope = session.telescope();
				await telescope.slewToCoordinates(ra, dec);

				const destination = `RA ${formatRightAscension(ra)}  Dec ${formatDeclination(dec)}`;
				if (!wait) {
					return textResult(
						`Slewing to ${destination}.\n\nPoll telescope_status until slewing is false.`,
						{ right_ascension_hours: ra, declination_degrees: dec, waited: false },
					);
				}

				const settled = await telescope.waitForSlewComplete({
					timeoutMs: (timeout_s ?? 120) * 1000,
				});
				const status = await telescope.status();

				return textResult(
					settled
						? `Slew finished.\n\n${renderStatus(status)}`
						: `Still slewing after ${timeout_s ?? 120}s.\n\n${renderStatus(status)}`,
					{ ...toStructuredStatus(status), waited: true, completed: settled },
				);
			}),
	);

	server.registerTool(
		"telescope_sync",
		{
			title: "Sync to coordinates",
			description:
				"Tell the telescope that it is currently pointing at these coordinates. Corrects the " +
				"pointing model; it does not move the mount.",
			inputSchema: z.object({ ra: raSchema, dec: decSchema }),
		},
		async ({ ra, dec }) =>
			guard(async () => {
				await session.telescope().syncToCoordinates(ra, dec);
				return textResult(
					`Synced to RA ${formatRightAscension(ra)}  Dec ${formatDeclination(dec)}.`,
					{ right_ascension_hours: ra, declination_degrees: dec },
				);
			}),
	);

	server.registerTool(
		"telescope_abort",
		{
			title: "Stop moving",
			description: "Abort a slew in progress. Safe to call at any time; tracking is unaffected.",
			inputSchema: z.object({}),
		},
		async () =>
			guard(async () => {
				await session.telescope().abortSlew();
				return textResult("Slew aborted.");
			}),
	);

	server.registerTool(
		"telescope_park",
		{
			title: "Park the telescope",
			description:
				"Move the telescope to its park position and stop tracking. On a Seestar this closes " +
				"the arm — the usual way to end a session.",
			inputSchema: z.object({}),
		},
		async () =>
			guard(async () => {
				await session.telescope().park();
				return textResult("Parked. Tracking is off; unpark before slewing again.");
			}),
	);

	server.registerTool(
		"telescope_unpark",
		{
			title: "Unpark the telescope",
			description: "Release the park state so the telescope can move again.",
			inputSchema: z.object({}),
		},
		async () =>
			guard(async () => {
				await session.telescope().unpark();
				return textResult("Unparked.");
			}),
	);

	server.registerTool(
		"telescope_find_home",
		{
			title: "Find the home position",
			description: "Send the telescope to its mechanical home position.",
			inputSchema: z.object({}),
		},
		async () =>
			guard(async () => {
				await session.telescope().findHome();
				return textResult("Homing. Poll telescope_status until at_home is true.");
			}),
	);

	server.registerTool(
		"telescope_set_tracking",
		{
			title: "Turn tracking on or off",
			description:
				"Enable or disable sidereal tracking. Tracking must be on to keep a target centred " +
				"while imaging.",
			inputSchema: z.object({ enabled: z.boolean() }),
		},
		async ({ enabled }) =>
			guard(async () => {
				await session.telescope().setTracking(enabled);
				return textResult(`Tracking ${enabled ? "on" : "off"}.`, { tracking: enabled });
			}),
	);

	if (!allowRaw) return;

	server.registerTool(
		"telescope_action",
		{
			title: "Raw Alpaca action",
			description:
				"Invoke a driver-specific Alpaca action by name. An escape hatch for anything the " +
				"dedicated tools do not cover — note that seestar_alp advertises no actions even though " +
				"it implements many, so nothing here is discoverable.",
			inputSchema: z.object({
				action: z.string().describe("Action name, e.g. method_sync or start_mosaic"),
				parameters: z
					.string()
					.optional()
					.describe("Parameters as a JSON string, exactly as the driver expects them"),
			}),
		},
		async ({ action, parameters }) =>
			guard(async () => {
				const result = await session.device().action(action, parameters ?? "");
				return textResult(
					`${action} returned:\n${typeof result === "string" ? result : JSON.stringify(result, null, 2)}`,
					{ action, result: result as unknown },
				);
			}),
	);
}

function renderStatus(status: TelescopeStatus): string {
	const body = formatFields([
		["name", status.name],
		[
			"right ascension",
			status.rightAscension === undefined
				? undefined
				: `${formatRightAscension(status.rightAscension)}  (${status.rightAscension.toFixed(4)} h)`,
		],
		[
			"declination",
			status.declination === undefined
				? undefined
				: `${formatDeclination(status.declination)}  (${status.declination.toFixed(4)}°)`,
		],
		["altitude", status.altitude === undefined ? undefined : formatDegrees(status.altitude)],
		["azimuth", status.azimuth === undefined ? undefined : formatDegrees(status.azimuth)],
		["slewing", formatBoolean(status.slewing, "yes — still moving", "no")],
		["tracking", formatBoolean(status.tracking, "on", "off")],
		["parked", formatBoolean(status.atPark, "yes", "no")],
		["at home", formatBoolean(status.atHome, "yes", "no")],
		[
			"site",
			status.siteLatitude === undefined || status.siteLongitude === undefined
				? undefined
				: `${status.siteLatitude.toFixed(4)}, ${status.siteLongitude.toFixed(4)}`,
		],
	]);

	return `${body}${formatUnavailable(status.unavailable)}`;
}

function toStructuredStatus(status: TelescopeStatus): Record<string, unknown> {
	return {
		connected: status.connected,
		...defined("right_ascension_hours", status.rightAscension),
		...defined("declination_degrees", status.declination),
		...defined("altitude_degrees", status.altitude),
		...defined("azimuth_degrees", status.azimuth),
		...defined("slewing", status.slewing),
		...defined("tracking", status.tracking),
		...defined("at_park", status.atPark),
		...defined("at_home", status.atHome),
		...defined("site_latitude", status.siteLatitude),
		...defined("site_longitude", status.siteLongitude),
		unavailable: status.unavailable,
	};
}

function defined<T>(key: string, value: T | undefined): Record<string, T> {
	return value === undefined ? {} : { [key]: value };
}
