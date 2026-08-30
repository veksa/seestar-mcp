import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { renderSchedule, type ScheduleAction, SeestarSchedule } from "../seestar/schedule.js";
import type { Session } from "../session.js";
import { guard, textResult } from "./result.js";

/**
 * Scheduler tools: plan a night, then let the telescope run it unattended.
 *
 * The item parameters are named the way the driver expects them, but the tools take friendlier
 * arguments (minutes rather than seconds, a target name rather than a nested params object) so the
 * model does not have to know the wire format.
 */
export function registerSchedulerTools(server: McpServer, session: Session): void {
	const schedule = () => new SeestarSchedule(session.seestar().actions);

	server.registerTool(
		"schedule_get",
		{
			title: "Read the schedule",
			description:
				"The list of queued items and whether the scheduler is running. The item marked ▶ is " +
				"the one being worked on.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async () =>
			guard(async () => {
				const current = await schedule().get();
				return textResult(renderSchedule(current), {
					state: current.state,
					items: current.items.map((item) => ({
						id: item.id ?? null,
						action: item.action ?? null,
						params: item.params ?? {},
					})),
					...(current.isStacking !== undefined ? { is_stacking: current.isStacking } : {}),
				});
			}),
	);

	if (session.config.readOnly) return;

	server.registerTool(
		"schedule_create",
		{
			title: "Start a new schedule",
			description:
				"Clear the schedule and start a new, empty one. Refused while the scheduler is running " +
				"— stop it first.",
			inputSchema: z.object({}),
		},
		async () =>
			guard(async () => {
				const created = await schedule().create();
				return textResult(`New schedule created.\n\n${renderSchedule(created)}`);
			}),
	);

	server.registerTool(
		"schedule_add_item",
		{
			title: "Add a schedule item",
			description:
				"Append one step to the schedule. A night usually looks like: start_up_sequence, " +
				"wait_until dark, image a target, auto_focus, image another, shutdown.",
			inputSchema: z.object({
				action: z
					.enum([
						"start_mosaic",
						"start_spectra",
						"auto_focus",
						"adjust_focus",
						"wait_for",
						"wait_until",
						"start_up_sequence",
						"shutdown",
					])
					.describe("What this step does. start_mosaic images a target (1x1 grid = one field)."),
				target_name: z.string().optional().describe("For start_mosaic / start_spectra"),
				ra: z.union([z.number().min(0).max(24), z.string()]).optional(),
				dec: z.union([z.number().min(-90).max(90), z.string()]).optional(),
				is_j2000: z.boolean().optional(),
				session_minutes: z.number().min(0.5).max(600).optional().describe("Time per panel"),
				gain: z.number().int().min(0).max(300).optional(),
				lp_filter: z.boolean().optional(),
				ra_panels: z.number().int().min(1).max(10).optional(),
				dec_panels: z.number().int().min(1).max(10).optional(),
				panel_overlap_percent: z.number().int().min(0).max(100).optional(),
				local_time: z
					.string()
					.regex(/^\d{1,2}:\d{2}$/)
					.optional()
					.describe("For wait_until, in the telescope's local time, e.g. 22:30"),
				wait_seconds: z.number().int().min(1).max(86_400).optional().describe("For wait_for"),
				focus_steps: z.number().int().min(-2000).max(2000).optional().describe("For adjust_focus"),
				autofocus_tries: z.number().int().min(1).max(5).optional().describe("For auto_focus"),
				latitude: z.number().min(-90).max(90).optional().describe("For start_up_sequence"),
				longitude: z.number().min(-180).max(180).optional(),
			}),
		},
		async (input) =>
			guard(async () => {
				const params = buildItemParams(input);
				if (typeof params === "string") return textResult(params);

				const updated = await schedule().addItem(input.action as ScheduleAction, params);
				return textResult(`Added.\n\n${renderSchedule(updated)}`);
			}),
	);

	server.registerTool(
		"schedule_remove_item",
		{
			title: "Remove a schedule item",
			description:
				"Drop one item from the schedule by its id, as shown in square brackets by schedule_get. " +
				"Items that already ran cannot be removed.",
			inputSchema: z.object({ item_id: z.string() }),
		},
		async ({ item_id }) =>
			guard(async () => {
				const updated = await schedule().removeItem(item_id);
				return textResult(renderSchedule(updated));
			}),
	);

	server.registerTool(
		"schedule_control",
		{
			title: "Run or interrupt the schedule",
			description:
				"Start the scheduler, stop it, pause it, continue after a pause, or skip the item " +
				"running now.",
			inputSchema: z.object({
				operation: z.enum(["start", "stop", "pause", "continue", "skip"]),
			}),
		},
		async ({ operation }) =>
			guard(async () => {
				const scheduler = schedule();
				const updated = await {
					start: () => scheduler.start(),
					stop: () => scheduler.stop(),
					pause: () => scheduler.pause(),
					continue: () => scheduler.resume(),
					skip: () => scheduler.skip(),
				}[operation]();

				const note =
					operation === "start"
						? "\n\nThe telescope now works through the list on its own. Follow it with seestar_events."
						: "";

				return textResult(`${renderSchedule(updated)}${note}`, { state: updated.state });
			}),
	);
}

type ItemInput = {
	action: string;
	target_name?: string;
	ra?: number | string;
	dec?: number | string;
	is_j2000?: boolean;
	session_minutes?: number;
	gain?: number;
	lp_filter?: boolean;
	ra_panels?: number;
	dec_panels?: number;
	panel_overlap_percent?: number;
	local_time?: string;
	wait_seconds?: number;
	focus_steps?: number;
	autofocus_tries?: number;
	latitude?: number;
	longitude?: number;
};

/** Build the driver's parameter object, or return a sentence explaining what is missing. */
function buildItemParams(input: ItemInput): Record<string, unknown> | string {
	switch (input.action) {
		case "start_mosaic":
		case "start_spectra": {
			if (!input.target_name) return "start_mosaic needs a target_name.";
			const seconds = Math.round((input.session_minutes ?? 10) * 60);
			return {
				target_name: input.target_name,
				ra: input.ra ?? -1,
				dec: input.dec ?? -1,
				is_j2000: input.is_j2000 ?? false,
				is_use_lp_filter: input.lp_filter ?? false,
				panel_time_sec: seconds,
				session_time_sec: seconds,
				ra_num: input.ra_panels ?? 1,
				dec_num: input.dec_panels ?? 1,
				panel_overlap_percent: input.panel_overlap_percent ?? 20,
				gain: input.gain ?? 80,
			};
		}
		case "wait_until":
			if (!input.local_time) return "wait_until needs local_time, e.g. 22:30.";
			return { local_time: input.local_time };
		case "wait_for":
			if (input.wait_seconds === undefined) return "wait_for needs wait_seconds.";
			return { timer_sec: input.wait_seconds };
		case "auto_focus":
			return { try_count: input.autofocus_tries ?? 1 };
		case "adjust_focus":
			if (input.focus_steps === undefined) return "adjust_focus needs focus_steps.";
			return { steps: input.focus_steps };
		case "start_up_sequence":
			return { lat: input.latitude ?? 0, lon: input.longitude ?? 0 };
		default:
			return {};
	}
}
