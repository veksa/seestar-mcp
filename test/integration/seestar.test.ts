import { afterEach, describe, expect, it } from "vitest";
import { SeestarSim } from "../fake/seestar-sim.js";
import { type Harness, isError, startHarness, structuredOf, textOf } from "./harness.js";

let harness: Harness;

afterEach(async () => {
	await harness?.close();
});

async function connect(): Promise<void> {
	await harness.client.callTool({ name: "device_connect", arguments: {} });
}

describe("seestar_state", () => {
	it("reports battery, storage and firmware", async () => {
		harness = await startHarness();
		await connect();
		harness.fake.sim.batteryPercent = 64;

		const result = await harness.client.callTool({ name: "seestar_state", arguments: {} });

		expect(structuredOf(result)).toMatchObject({
			battery_percent: 64,
			firmware: "4.11",
			model: "Seestar S50P",
		});
		expect(textOf(result)).toContain("64%");
		expect(textOf(result)).toContain("GB");
	});
});

describe("seestar_startup", () => {
	it("starts the sequence and points at the event to watch", async () => {
		harness = await startHarness();
		await connect();

		const result = await harness.client.callTool({
			name: "seestar_startup",
			arguments: { latitude: 52.5, longitude: 13.4 },
		});

		expect(isError(result)).toBe(false);
		expect(textOf(result)).toContain("Initialise");
		expect(harness.fake.sim.siteLatitude).toBe(52.5);
		expect(harness.fake.sim.siteLongitude).toBe(13.4);
	});
});

describe("seestar_goto_target", () => {
	it("uses the plate-solving goto rather than a plain slew", async () => {
		harness = await startHarness();
		await connect();

		const result = await harness.client.callTool({
			name: "seestar_goto_target",
			arguments: { target_name: "M31", ra: 0.712, dec: 41.27, is_j2000: true },
		});

		expect(isError(result)).toBe(false);
		expect(harness.fake.sim.calls.at(-1)).toMatchObject({
			action: "goto_target",
			parameters: { target_name: "M31", is_j2000: true },
		});
		expect(textOf(result)).toContain("AutoGoto");
	});

	it("accepts sexagesimal coordinates", async () => {
		harness = await startHarness();
		await connect();

		const result = await harness.client.callTool({
			name: "seestar_goto_target",
			arguments: { target_name: "NGC2244", ra: "6h31m54.23s", dec: "+4d56m26.4s", is_j2000: true },
		});

		expect(isError(result)).toBe(false);
		// 6h31m54s is 6.5317 hours — the simulator parses it the way the firmware does.
		expect(harness.fake.sim.targetRightAscension).toBeCloseTo(6.5317, 3);
		expect(harness.fake.sim.targetDeclination).toBeCloseTo(4.9407, 3);
	});

	it("reports the goto as it progresses, then as complete", async () => {
		harness = await startHarness();
		await connect();

		await harness.client.callTool({
			name: "seestar_goto_target",
			arguments: { target_name: "M42", ra: 5.588, dec: -5.39 },
		});

		const during = await harness.client.callTool({ name: "seestar_events", arguments: {} });
		expect(textOf(during)).toContain("AutoGoto");
		expect(textOf(during)).toContain("working");

		await new Promise((resolve) => setTimeout(resolve, 200));

		const after = await harness.client.callTool({ name: "seestar_events", arguments: {} });
		expect(textOf(after)).toMatch(/AutoGoto\s+complete/);
	});

	it("can wait for the goto and report how it ended", async () => {
		harness = await startHarness();
		await connect();

		const result = await harness.client.callTool({
			name: "seestar_goto_target",
			arguments: { target_name: "M42", ra: 5.588, dec: -5.39, wait: true, timeout_s: 5 },
		});

		expect(structuredOf(result)).toMatchObject({ completed: true });
		expect(textOf(result)).toContain("AutoGoto complete");
		expect(harness.fake.sim.slewing).toBe(false);
	});

	it("says the goto is still running when the wait times out", async () => {
		harness = await startHarness({}, { sim: new SeestarSim({ slewDurationMs: 60_000 }) });
		await connect();

		const result = await harness.client.callTool({
			name: "seestar_goto_target",
			arguments: { target_name: "M42", ra: 5.588, dec: -5.39, wait: true, timeout_s: 5 },
		});

		expect(structuredOf(result)).toMatchObject({ completed: false });
		expect(textOf(result)).toContain("still running");
	});
});

describe("imaging", () => {
	it("starts a session and explains what to watch", async () => {
		harness = await startHarness();
		await connect();

		const result = await harness.client.callTool({
			name: "imaging_start",
			arguments: { target_name: "M31", ra: 0.712, dec: 41.27, session_minutes: 30, gain: 80 },
		});

		expect(isError(result)).toBe(false);
		expect(structuredOf(result)).toMatchObject({
			target_name: "M31",
			session_seconds: 1800,
			panels: 1,
		});
		expect(textOf(result)).toContain("30m");
		expect(harness.fake.sim.isStacking).toBe(true);
	});

	it("sends both panel_time_sec and session_time_sec, for old and new drivers", async () => {
		harness = await startHarness();
		await connect();

		await harness.client.callTool({
			name: "imaging_start",
			arguments: { target_name: "M31", session_minutes: 5 },
		});

		expect(harness.fake.sim.calls.at(-1)?.parameters).toMatchObject({
			panel_time_sec: 300,
			session_time_sec: 300,
		});
	});

	it("describes a mosaic as a mosaic", async () => {
		harness = await startHarness();
		await connect();

		const result = await harness.client.callTool({
			name: "imaging_start",
			arguments: { target_name: "Veil", ra_panels: 2, dec_panels: 3, session_minutes: 10 },
		});

		expect(structuredOf(result)).toMatchObject({ panels: 6 });
		expect(textOf(result)).toContain("2x3 mosaic");
	});

	it("says a session is already running instead of failing obscurely", async () => {
		harness = await startHarness();
		await connect();
		await harness.client.callTool({
			name: "imaging_start",
			arguments: { target_name: "M31", session_minutes: 30 },
		});

		const second = await harness.client.callTool({
			name: "imaging_start",
			arguments: { target_name: "M42", session_minutes: 30 },
		});

		expect(isError(second)).toBe(true);
		expect(textOf(second)).toContain("scheduler is active");
		expect(textOf(second)).toContain("imaging_stop");
	});

	it("stops the current view", async () => {
		harness = await startHarness();
		await connect();
		await harness.client.callTool({
			name: "imaging_start",
			arguments: { target_name: "M31", session_minutes: 30 },
		});

		await harness.client.callTool({ name: "imaging_stop", arguments: {} });

		expect(harness.fake.sim.isStacking).toBe(false);
	});

	it("waits for the plate solve to finish before reporting a result", async () => {
		harness = await startHarness();
		await connect();

		const result = await harness.client.callTool({
			name: "imaging_solve",
			arguments: { timeout_s: 5 },
		});

		expect(isError(result)).toBe(false);
		// Reading the result straight after start_solve would return the previous solve.
		expect(textOf(result)).not.toContain("Still solving");
		expect(textOf(result)).toContain("Plate solve result");
	});

	it("says there is no image yet instead of handing over a dead link", async () => {
		harness = await startHarness();
		await connect();

		const result = await harness.client.callTool({ name: "imaging_last_image", arguments: {} });

		expect(isError(result)).toBe(false);
		expect(textOf(result)).toContain("No image saved yet");
		expect(structuredOf(result).url).toBeUndefined();
	});

	it("returns the last image URL with the frame count", async () => {
		harness = await startHarness();
		await connect();
		await harness.client.callTool({
			name: "imaging_start",
			arguments: { target_name: "M31", session_minutes: 30 },
		});
		await new Promise((resolve) => setTimeout(resolve, 60));

		const result = await harness.client.callTool({
			name: "imaging_last_image",
			arguments: {},
		});

		const structured = structuredOf(result);
		// The URL points at the telescope's own file server, which the fake stands in for.
		expect(String(structured.url)).toContain("/MyWorks/M31/");
		expect(structured.stacked_frames).toBeGreaterThan(0);
	});
});

describe("settings and accessories", () => {
	it("changes only the settings it was given", async () => {
		harness = await startHarness();
		await connect();

		await harness.client.callTool({
			name: "seestar_set_settings",
			arguments: { stack_exposure_s: 30, gain: 120, lp_filter: true },
		});

		expect(harness.fake.sim.exposureStackMs).toBe(30_000);
		expect(harness.fake.sim.gain).toBe(120);
		expect(harness.fake.sim.lpFilterEnabled).toBe(true);
		// Never asked about, never touched.
		expect(harness.fake.sim.exposureContinuousMs).toBe(500);
	});

	it("reads the settings back", async () => {
		harness = await startHarness();
		await connect();
		harness.fake.sim.exposureStackMs = 20_000;

		const result = await harness.client.callTool({ name: "seestar_settings", arguments: {} });

		expect(structuredOf(result)).toMatchObject({ stack_exposure_ms: 20_000, gain: 80 });
		expect(textOf(result)).toContain("20s per frame");
	});

	it("moves the filter wheel", async () => {
		harness = await startHarness();
		await connect();

		await harness.client.callTool({
			name: "seestar_filter_wheel",
			arguments: { position: 2 },
		});

		expect(harness.fake.sim.wheelPosition).toBe(2);
	});

	it("sets dew heater power", async () => {
		harness = await startHarness();
		await connect();

		const result = await harness.client.callTool({
			name: "seestar_dew_heater",
			arguments: { power: 70 },
		});

		expect(harness.fake.sim.dewHeaterPower).toBe(70);
		expect(textOf(result)).toContain("70%");
	});

	it("nudges the focuser and reports the new position", async () => {
		harness = await startHarness();
		await connect();

		const result = await harness.client.callTool({
			name: "seestar_autofocus",
			arguments: { operation: "adjust", steps: 25 },
		});

		expect(harness.fake.sim.focuserPosition).toBe(1525);
		expect(textOf(result)).toContain("1525");
	});
});

describe("profiles and read-only mode", () => {
	it("keeps the Seestar tools out of the list in generic mode", async () => {
		harness = await startHarness({ profile: "generic" });

		const names = (await harness.client.listTools()).tools.map((tool) => tool.name);

		expect(names).toContain("telescope_status");
		expect(names).not.toContain("seestar_state");
		expect(names).not.toContain("imaging_start");
	});

	it("keeps reading but not imaging in read-only mode", async () => {
		harness = await startHarness({ readOnly: true });

		const names = (await harness.client.listTools()).tools.map((tool) => tool.name);

		expect(names).toContain("seestar_state");
		expect(names).toContain("seestar_events");
		expect(names).toContain("imaging_last_image");
		expect(names).not.toContain("imaging_start");
		expect(names).not.toContain("seestar_goto_target");
		expect(names).not.toContain("seestar_dew_heater");
	});
});
