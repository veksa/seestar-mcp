import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { formatDuration } from "../format.js";
import { findEvent } from "../seestar/events.js";
import type { Session } from "../session.js";
import { guard, textResult } from "./result.js";

/**
 * Imaging tools.
 *
 * On a Seestar everything goes through `start_mosaic`, even a single target: the driver turns the
 * request into a one-item schedule and runs it. That is also why it refuses while another schedule
 * is active, which the tools surface rather than hide.
 */
export function registerImagingTools(server: McpServer, session: Session): void {
	if (session.config.readOnly) {
		registerReadOnlyImagingTools(server, session);
		return;
	}

	server.registerTool(
		"imaging_start",
		{
			title: "Start imaging",
			description:
				"Point at a target and start a stacking session. With the default 1x1 grid this is an " +
				"ordinary single-target session; larger grids capture a mosaic. Omit ra and dec to image " +
				"wherever the telescope is already pointing. Follow the Stack event with seestar_events.",
			inputSchema: z.object({
				target_name: z.string().describe("Used for the folder and file names on the telescope"),
				ra: z
					.union([z.number().min(0).max(24), z.string()])
					.optional()
					.describe("Right ascension in hours, or sexagesimal. Omit to use the current position."),
				dec: z.union([z.number().min(-90).max(90), z.string()]).optional(),
				is_j2000: z.boolean().optional().describe("True for catalogue (J2000) coordinates"),
				session_minutes: z
					.number()
					.min(0.5)
					.max(600)
					.optional()
					.describe("How long to image each panel. Default 10 minutes."),
				gain: z.number().int().min(0).max(300).optional().describe("Default 80"),
				lp_filter: z.boolean().optional().describe("Use the light-pollution filter"),
				autofocus: z.boolean().optional().describe("Run autofocus before imaging"),
				ra_panels: z.number().int().min(1).max(10).optional().describe("Mosaic columns, default 1"),
				dec_panels: z.number().int().min(1).max(10).optional().describe("Mosaic rows, default 1"),
				panel_overlap_percent: z.number().int().min(0).max(100).optional(),
			}),
		},
		async (input) =>
			guard(async () => {
				const sessionSeconds = Math.round((input.session_minutes ?? 10) * 60);
				const panels = (input.ra_panels ?? 1) * (input.dec_panels ?? 1);

				await session.seestar().startImaging({
					targetName: input.target_name,
					...(input.ra !== undefined ? { ra: input.ra } : {}),
					...(input.dec !== undefined ? { dec: input.dec } : {}),
					...(input.is_j2000 !== undefined ? { isJ2000: input.is_j2000 } : {}),
					sessionSeconds,
					...(input.gain !== undefined ? { gain: input.gain } : {}),
					...(input.lp_filter !== undefined ? { lpFilter: input.lp_filter } : {}),
					...(input.autofocus !== undefined ? { autofocus: input.autofocus } : {}),
					...(input.ra_panels !== undefined ? { raPanels: input.ra_panels } : {}),
					...(input.dec_panels !== undefined ? { decPanels: input.dec_panels } : {}),
					...(input.panel_overlap_percent !== undefined
						? { panelOverlapPercent: input.panel_overlap_percent }
						: {}),
				});

				const shape =
					panels > 1
						? `${input.ra_panels ?? 1}x${input.dec_panels ?? 1} mosaic, ${formatDuration(sessionSeconds)} per panel`
						: formatDuration(sessionSeconds);

				return textResult(
					`Imaging ${input.target_name} — ${shape}.\n\n` +
						"The telescope goes to the target, plate-solves and starts stacking. " +
						"Poll seestar_events for the Stack event, and imaging_last_image for a picture.",
					{
						target_name: input.target_name,
						session_seconds: sessionSeconds,
						panels,
					},
				);
			}),
	);

	server.registerTool(
		"imaging_start_stack",
		{
			title: "Start stacking here",
			description:
				"Start (or restart) stacking on whatever the telescope is already pointing at, without " +
				"a goto. Use imaging_start to image a named target.",
			inputSchema: z.object({
				gain: z.number().int().min(0).max(300).optional(),
				restart: z.boolean().optional().describe("Discard the current stack and start over"),
			}),
		},
		async ({ gain, restart }) =>
			guard(async () => {
				await session.seestar().startStack(gain, restart ?? true);
				return textResult("Stacking started. Poll seestar_events for the Stack event.");
			}),
	);

	server.registerTool(
		"imaging_stop",
		{
			title: "Stop imaging",
			description:
				"Stop the current view: stacking, a goto, or the dark-library routine. The telescope " +
				"stays where it is.",
			inputSchema: z.object({
				stage: z
					.enum(["Stack", "AutoGoto", "AutoFocus", "DarkLibrary", "ContinuousExposure"])
					.optional()
					.describe("Stop only this stage. Omit to stop whatever is running."),
			}),
		},
		async ({ stage }) =>
			guard(async () => {
				await session.seestar().stopImaging(stage);
				return textResult(stage ? `Stopped ${stage}.` : "Imaging stopped.");
			}),
	);

	server.registerTool(
		"imaging_solve",
		{
			title: "Plate solve",
			description:
				"Plate-solve the current field and report where the telescope is actually pointing.",
			inputSchema: z.object({
				read_only: z
					.boolean()
					.optional()
					.describe("Only read the last result instead of solving again"),
			}),
		},
		async ({ read_only }) =>
			guard(async () => {
				const seestar = session.seestar();
				if (!read_only) await seestar.solve();
				const result = await seestar.lastSolveResult();
				return textResult(`Plate solve result:\n${JSON.stringify(result, null, 2)}`, {
					result: result as unknown,
				});
			}),
	);

	registerReadOnlyImagingTools(server, session);
}

/** Tools that only read — registered in every mode. */
function registerReadOnlyImagingTools(server: McpServer, session: Session): void {
	server.registerTool(
		"imaging_last_image",
		{
			title: "Last captured image",
			description:
				"The URL of the most recent frame, served by the telescope itself. Also reports how " +
				"many frames the current session has stacked.",
			inputSchema: z.object({
				thumbnail: z
					.boolean()
					.optional()
					.describe("Return the thumbnail instead of the full frame"),
				subframe: z.boolean().optional().describe("Return the sub-frame variant"),
			}),
			outputSchema: z.object({
				url: z.string(),
				name: z.string(),
				stacked_frames: z.number().optional(),
			}),
			annotations: { readOnlyHint: true },
		},
		async ({ thumbnail, subframe }) =>
			guard(async () => {
				const seestar = session.seestar();
				const [image, events] = await Promise.all([
					seestar.lastImage({
						...(thumbnail !== undefined ? { thumbnail } : {}),
						...(subframe !== undefined ? { subframe } : {}),
					}),
					seestar.events().catch(() => []),
				]);

				const stack = findEvent(events, "Stack");
				const stacked = stack?.raw.stacked_frame;
				const stackedFrames = typeof stacked === "number" ? stacked : undefined;

				const lines = [
					`${image.name}: ${image.url}`,
					stackedFrames === undefined
						? ""
						: `${stackedFrames} frames stacked so far in this session.`,
					"",
					"The URL is served by the telescope on your local network — open it to view the image.",
				].filter(Boolean);

				return textResult(lines.join("\n"), {
					url: image.url,
					name: image.name,
					...(stackedFrames !== undefined ? { stacked_frames: stackedFrames } : {}),
				});
			}),
	);
}
