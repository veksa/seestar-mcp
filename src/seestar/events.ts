import type { SeestarActions } from "./actions.js";

/**
 * The firmware event stream.
 *
 * Everything slow on a Seestar — going to a target, plate solving, focusing, stacking — reports
 * progress as an event rather than by blocking. `get_event_state` returns the latest state of each
 * event, keyed by name, and polling it is the only way to know whether an operation finished.
 */

export interface SeestarEvent {
	name: string;
	/** `working`, `complete`, `cancel`, `fail` — the firmware's own vocabulary. */
	state?: string;
	percent?: number;
	raw: Record<string, unknown>;
}

/** Events worth surfacing first, in the order a session goes through them. */
const INTERESTING_ORDER = [
	"Initialise",
	"ScopeHome",
	"AutoGoto",
	"PlateSolve",
	"3PPA",
	"EqModePA",
	"AutoFocus",
	"DarkLibrary",
	"Stack",
	"View",
	"Scheduler",
	"Mount",
];

/**
 * Normalise whatever `get_event_state` returned.
 *
 * The driver returns a map keyed by event name, where each value carries its own `Event` field. A
 * list is accepted too, since that is the obvious alternative shape and costs nothing to support.
 */
export function parseEvents(raw: unknown): SeestarEvent[] {
	if (!raw || typeof raw !== "object") return [];

	const entries: SeestarEvent[] = [];
	const collect = (key: string, value: unknown) => {
		if (!value || typeof value !== "object") return;
		const record = value as Record<string, unknown>;
		entries.push({
			name: typeof record.Event === "string" ? record.Event : key,
			...(typeof record.state === "string" ? { state: record.state } : {}),
			...(typeof record.percent === "number" ? { percent: record.percent } : {}),
			raw: record,
		});
	};

	if (Array.isArray(raw)) {
		raw.forEach((value, index) => {
			collect(String(index), value);
		});
	} else {
		const container = raw as Record<string, unknown>;
		const list = container.List;
		if (Array.isArray(list))
			list.forEach((value, index) => {
				collect(String(index), value);
			});
		else for (const [key, value] of Object.entries(container)) collect(key, value);
	}

	// The driver copies EqModePA into 3PPA, so the same polar alignment shows up twice.
	const seen = new Set<string>();
	return entries.filter((event) => {
		const key = `${event.name}:${event.state ?? ""}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function findEvent(events: SeestarEvent[], name: string): SeestarEvent | undefined {
	return events.find((event) => event.name.toLowerCase() === name.toLowerCase());
}

/** Sort so the events a person cares about come first, unknown ones after. */
export function orderEvents(events: SeestarEvent[]): SeestarEvent[] {
	return [...events].sort((left, right) => {
		const leftIndex = INTERESTING_ORDER.indexOf(left.name);
		const rightIndex = INTERESTING_ORDER.indexOf(right.name);
		if (leftIndex === -1 && rightIndex === -1) return left.name.localeCompare(right.name);
		if (leftIndex === -1) return 1;
		if (rightIndex === -1) return -1;
		return leftIndex - rightIndex;
	});
}

/** One line per event: `AutoGoto      working 40%`. */
export function renderEvents(events: SeestarEvent[]): string {
	if (events.length === 0) return "No events reported yet.";

	const ordered = orderEvents(events);
	const width = Math.max(...ordered.map((event) => event.name.length));

	return ordered
		.map((event) => {
			const details = [event.state ?? "", event.percent !== undefined ? `${event.percent}%` : ""]
				.filter(Boolean)
				.join(" ");
			const extra = summariseExtras(event);
			return `${event.name.padEnd(width)}  ${details}${extra}`.trimEnd();
		})
		.join("\n");
}

/** The few extra fields worth showing inline, per event type. */
function summariseExtras(event: SeestarEvent): string {
	const raw = event.raw;
	const parts: string[] = [];

	if (event.name === "Stack") {
		if (typeof raw.stacked_frame === "number") parts.push(`${raw.stacked_frame} frames stacked`);
		if (typeof raw.dropped_frame === "number" && raw.dropped_frame > 0) {
			parts.push(`${raw.dropped_frame} dropped`);
		}
		if (typeof raw.target_name === "string" && raw.target_name) parts.push(String(raw.target_name));
	}

	if (event.name === "Scheduler" && typeof raw.is_stacking === "boolean") {
		parts.push(raw.is_stacking ? "stacking" : "idle");
	}

	if (event.name === "3PPA" || event.name === "EqModePA") {
		const alt = raw.eq_offset_alt;
		const az = raw.eq_offset_az;
		if (typeof alt === "number" && typeof az === "number") {
			parts.push(`offset alt ${alt.toFixed(2)}°, az ${az.toFixed(2)}°`);
		}
	}

	return parts.length > 0 ? `  (${parts.join(", ")})` : "";
}

export interface WaitOptions {
	timeoutMs?: number;
	pollIntervalMs?: number;
	signal?: AbortSignal;
}

export interface WaitResult {
	/** True when the event reached the state we were waiting for. */
	done: boolean;
	event: SeestarEvent | undefined;
	events: SeestarEvent[];
	/** Set when the event ended in `cancel` or `fail` instead. */
	failed?: boolean;
}

const TERMINAL_FAILURE_STATES = new Set(["cancel", "fail", "error"]);

/**
 * Poll `get_event_state` until one event reaches `complete` (or fails).
 *
 * Callers own the timeout: a goto takes under a minute, a stacking session can take hours, and the
 * MCP tool decides which of those it is willing to wait for.
 */
export async function waitForEvent(
	actions: SeestarActions,
	name: string,
	options: WaitOptions = {},
): Promise<WaitResult> {
	const pollIntervalMs = options.pollIntervalMs ?? 1_000;
	const deadline = Date.now() + (options.timeoutMs ?? 120_000);
	let events: SeestarEvent[] = [];

	while (Date.now() < deadline) {
		if (options.signal?.aborted) break;

		events = parseEvents(await actions.call("get_event_state", {}));
		const event = findEvent(events, name);

		if (event?.state === "complete") return { done: true, event, events };
		if (event?.state && TERMINAL_FAILURE_STATES.has(event.state)) {
			return { done: false, failed: true, event, events };
		}

		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}

	return { done: false, event: findEvent(events, name), events };
}
