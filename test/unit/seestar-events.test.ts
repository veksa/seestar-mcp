import { describe, expect, it, vi } from "vitest";
import type { SeestarActions } from "../../src/seestar/actions.js";
import {
	findEvent,
	orderEvents,
	parseEvents,
	renderEvents,
	waitForEvent,
} from "../../src/seestar/events.js";

/** The shape seestar_alp actually returns: a map keyed by event name. */
const driverShape = {
	AutoGoto: { Event: "AutoGoto", state: "working", percent: 40 },
	Stack: { Event: "Stack", state: "working", stacked_frame: 12, dropped_frame: 2 },
	scheduler: { Event: "Scheduler", state: "running", is_stacking: true },
	mount: { Event: "Mount", equ_mode: false },
};

describe("parseEvents", () => {
	it("reads the driver's map of events", () => {
		const events = parseEvents(driverShape);

		expect(events.map((event) => event.name)).toEqual(
			expect.arrayContaining(["AutoGoto", "Stack", "Scheduler", "Mount"]),
		);
		expect(findEvent(events, "AutoGoto")).toMatchObject({ state: "working", percent: 40 });
	});

	it("prefers the embedded Event name over the key", () => {
		const events = parseEvents({ scheduler: { Event: "Scheduler", state: "running" } });
		expect(events[0]?.name).toBe("Scheduler");
	});

	it("accepts a list as well", () => {
		const events = parseEvents({ List: [{ Event: "AutoFocus", state: "complete" }] });
		expect(findEvent(events, "autofocus")?.state).toBe("complete");
	});

	it("drops the duplicate the driver makes by copying EqModePA into 3PPA", () => {
		const events = parseEvents({
			EqModePA: { Event: "3PPA", state: "complete" },
			"3PPA": { Event: "3PPA", state: "complete" },
		});

		expect(events).toHaveLength(1);
	});

	it("survives junk", () => {
		expect(parseEvents(undefined)).toEqual([]);
		expect(parseEvents("nope")).toEqual([]);
		expect(parseEvents({ broken: null })).toEqual([]);
	});
});

describe("renderEvents", () => {
	it("puts the interesting events first and spells out the stack", () => {
		const text = renderEvents(parseEvents(driverShape));
		const lines = text.split("\n");

		expect(lines[0]).toContain("AutoGoto");
		expect(text).toContain("40%");
		expect(text).toContain("12 frames stacked");
		expect(text).toContain("2 dropped");
	});

	it("says so when there is nothing yet", () => {
		expect(renderEvents([])).toBe("No events reported yet.");
	});

	it("sorts unknown events after known ones", () => {
		const ordered = orderEvents(
			parseEvents({ Wibble: { Event: "Wibble" }, Stack: { Event: "Stack" } }),
		);
		expect(ordered.map((event) => event.name)).toEqual(["Stack", "Wibble"]);
	});
});

describe("waitForEvent", () => {
	/** A stand-in that answers `get_event_state` from a scripted sequence. */
	function actionsReturning(...states: string[]): SeestarActions {
		const queue = [...states];
		return {
			call: vi.fn(async () => {
				const state = queue.length > 1 ? queue.shift() : queue[0];
				return { AutoGoto: { Event: "AutoGoto", state } };
			}),
		} as unknown as SeestarActions;
	}

	it("returns as soon as the event completes", async () => {
		const result = await waitForEvent(
			actionsReturning("working", "working", "complete"),
			"AutoGoto",
			{
				pollIntervalMs: 1,
				timeoutMs: 1_000,
			},
		);

		expect(result.done).toBe(true);
		expect(result.event?.state).toBe("complete");
	});

	it("stops on a cancelled event instead of waiting out the timeout", async () => {
		const result = await waitForEvent(actionsReturning("cancel"), "AutoGoto", {
			pollIntervalMs: 1,
			timeoutMs: 1_000,
		});

		expect(result.done).toBe(false);
		expect(result.failed).toBe(true);
	});

	it("gives up after the timeout and reports the last state seen", async () => {
		const result = await waitForEvent(actionsReturning("working"), "AutoGoto", {
			pollIntervalMs: 5,
			timeoutMs: 40,
		});

		expect(result.done).toBe(false);
		expect(result.failed).toBeUndefined();
		expect(result.event?.state).toBe("working");
	});
});
