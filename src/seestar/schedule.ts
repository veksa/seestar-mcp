import { type SeestarActions, SeestarError } from "./actions.js";

/**
 * The Seestar scheduler.
 *
 * A schedule is a list of items the telescope works through unattended: image this target for an
 * hour, refocus, wait until 01:00, image that one, shut down. `imaging_start` is a shortcut that
 * builds a one-item schedule, which is why it and the scheduler cannot run at the same time.
 */

/** Item kinds the driver executes, with the parameter names it expects. */
export type ScheduleAction =
	| "start_mosaic"
	| "start_spectra"
	| "auto_focus"
	| "adjust_focus"
	| "wait_for"
	| "wait_until"
	| "start_up_sequence"
	| "action_set_dew_heater"
	| "action_set_exposure"
	| "shutdown";

export interface ScheduleItem {
	id?: string;
	action?: string;
	params?: Record<string, unknown>;
	raw: Record<string, unknown>;
}

export interface ScheduleState {
	/** `stopped`, `working`, `stopping`, `complete` — the driver's own vocabulary. */
	state: string;
	items: ScheduleItem[];
	isStacking?: boolean;
	currentItemId?: string;
	raw: Record<string, unknown>;
}

export class SeestarSchedule {
	constructor(private readonly actions: SeestarActions) {}

	/**
	 * Every scheduler action answers with the schedule itself — except when the driver declines, and
	 * then it answers with a bare sentence such as "scheduler is still active". Parsing that as a
	 * schedule would report an empty list in state "unknown", so it becomes an error instead.
	 */
	private async run(
		action: string,
		parameters: Record<string, unknown> = {},
	): Promise<ScheduleState> {
		const raw = await this.actions.call<unknown>(action, parameters);
		if (typeof raw === "string") throw new SeestarError(action, raw);
		return parseSchedule(raw);
	}

	get(): Promise<ScheduleState> {
		return this.run("get_schedule");
	}

	/** Start a new, empty schedule. Refused while one is running. */
	create(): Promise<ScheduleState> {
		return this.run("create_schedule");
	}

	addItem(action: ScheduleAction, params: Record<string, unknown>): Promise<ScheduleState> {
		return this.run("add_schedule_item", { action, params });
	}

	removeItem(itemId: string): Promise<ScheduleState> {
		return this.run("remove_schedule_item", { schedule_item_id: itemId });
	}

	start(): Promise<ScheduleState> {
		return this.run("start_scheduler");
	}

	stop(): Promise<ScheduleState> {
		return this.run("stop_scheduler");
	}

	pause(): Promise<ScheduleState> {
		return this.run("pause_scheduler");
	}

	resume(): Promise<ScheduleState> {
		return this.run("continue_scheduler");
	}

	/** Abandon the item running now and move to the next one. */
	skip(): Promise<ScheduleState> {
		return this.run("skip_scheduler_cur_item");
	}
}

export function parseSchedule(raw: unknown): ScheduleState {
	const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const list = Array.isArray(record.list) ? (record.list as unknown[]) : [];

	return {
		state: typeof record.state === "string" ? record.state : "unknown",
		items: list.map((entry) => {
			const item = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
			return {
				...(typeof item.schedule_item_id === "string" ? { id: item.schedule_item_id } : {}),
				...(typeof item.action === "string" ? { action: item.action } : {}),
				...(item.params && typeof item.params === "object"
					? { params: item.params as Record<string, unknown> }
					: {}),
				raw: item,
			};
		}),
		...(typeof record.is_stacking === "boolean" ? { isStacking: record.is_stacking } : {}),
		...(typeof record.current_item_id === "string"
			? { currentItemId: record.current_item_id }
			: {}),
		raw: record,
	};
}

/** One line per item, with the detail that matters for that kind of item. */
export function renderSchedule(schedule: ScheduleState): string {
	const header = `state: ${schedule.state}${schedule.isStacking ? " (stacking)" : ""}`;
	if (schedule.items.length === 0) return `${header}\n\nThe schedule is empty.`;

	const lines = schedule.items.map((item, index) => {
		const marker = item.id && item.id === schedule.currentItemId ? "▶" : " ";
		const position = String(index + 1).padStart(2);
		const detail = describeItem(item);
		const id = item.id ? `  [${item.id}]` : "";
		return `${marker}${position}. ${item.action ?? "unknown"}${detail}${id}`;
	});

	return `${header}\n\n${lines.join("\n")}`;
}

function describeItem(item: ScheduleItem): string {
	const params = item.params ?? {};

	switch (item.action) {
		case "start_mosaic":
		case "start_spectra": {
			const seconds = Number(params.panel_time_sec ?? params.session_time_sec ?? 0);
			const panels = Number(params.ra_num ?? 1) * Number(params.dec_num ?? 1);
			const grid = panels > 1 ? `, ${params.ra_num}x${params.dec_num} mosaic` : "";
			return `: ${params.target_name ?? "?"}, ${Math.round(seconds / 60)} min${grid}`;
		}
		case "wait_for":
			return `: ${params.timer_sec ?? "?"}s`;
		case "wait_until":
			return `: ${params.local_time ?? "?"}`;
		case "auto_focus":
			return params.try_count ? `: ${params.try_count} tries` : "";
		case "adjust_focus":
			return `: ${params.steps ?? "?"} steps`;
		default:
			return "";
	}
}
