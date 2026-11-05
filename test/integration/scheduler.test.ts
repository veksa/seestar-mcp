import { afterEach, describe, expect, it } from "vitest";
import { type Harness, isError, startHarness, structuredOf, textOf } from "./harness.js";

let harness: Harness;

afterEach(async () => {
	await harness?.close();
});

async function connect(): Promise<void> {
	await harness.client.callTool({ name: "device_connect", arguments: {} });
}

async function addItem(args: Record<string, unknown>): Promise<unknown> {
	return harness.client.callTool({ name: "schedule_add_item", arguments: args });
}

describe("schedule", () => {
	it("starts empty and says so", async () => {
		harness = await startHarness();
		await connect();

		const result = await harness.client.callTool({ name: "schedule_get", arguments: {} });

		expect(textOf(result)).toContain("The schedule is empty");
		expect(structuredOf(result)).toMatchObject({ state: "stopped", items: [] });
	});

	it("builds a night out of friendly arguments", async () => {
		harness = await startHarness();
		await connect();

		await addItem({ action: "start_up_sequence", latitude: 52.5, longitude: 13.4 });
		await addItem({ action: "wait_until", local_time: "22:30" });
		await addItem({
			action: "start_mosaic",
			target_name: "M31",
			ra: 0.712,
			dec: 41.27,
			is_j2000: true,
			session_minutes: 45,
		});
		await addItem({ action: "auto_focus", autofocus_tries: 2 });
		const last = await addItem({ action: "shutdown" });

		const text = textOf(last);
		expect(text).toContain("start_up_sequence");
		expect(text).toContain("wait_until: 22:30");
		expect(text).toContain("start_mosaic: M31, 45 min");
		expect(text).toContain("auto_focus: 2 tries");
		expect(text).toContain("shutdown");
	});

	it("translates minutes into the seconds the driver wants, for old and new drivers", async () => {
		harness = await startHarness();
		await connect();

		await addItem({ action: "start_mosaic", target_name: "M42", session_minutes: 20 });

		expect(harness.fake.sim.calls.at(-1)?.parameters).toMatchObject({
			action: "start_mosaic",
			params: { panel_time_sec: 1200, session_time_sec: 1200, target_name: "M42" },
		});
	});

	it("asks for the missing argument instead of sending a broken item", async () => {
		harness = await startHarness();
		await connect();

		const result = await addItem({ action: "wait_until" });

		expect(textOf(result)).toContain("needs local_time");
		expect(harness.fake.sim.calls.some((call) => call.action === "add_schedule_item")).toBe(false);
	});

	it("removes an item by id", async () => {
		harness = await startHarness();
		await connect();
		await addItem({ action: "wait_for", wait_seconds: 60 });
		await addItem({ action: "shutdown" });

		const before = structuredOf(
			await harness.client.callTool({ name: "schedule_get", arguments: {} }),
		);
		const items = before.items as Array<{ id: string }>;
		expect(items).toHaveLength(2);

		const result = await harness.client.callTool({
			name: "schedule_remove_item",
			arguments: { item_id: items[0]?.id as string },
		});

		expect(textOf(result)).not.toContain("wait_for");
		expect(textOf(result)).toContain("shutdown");
	});

	it("runs, pauses, continues and stops", async () => {
		harness = await startHarness();
		await connect();
		await addItem({ action: "start_mosaic", target_name: "M31", session_minutes: 30 });

		const started = await harness.client.callTool({
			name: "schedule_control",
			arguments: { operation: "start" },
		});
		expect(structuredOf(started)).toMatchObject({ state: "working" });
		expect(textOf(started)).toContain("seestar_events");

		const paused = await harness.client.callTool({
			name: "schedule_control",
			arguments: { operation: "pause" },
		});
		expect(structuredOf(paused)).toMatchObject({ state: "paused" });

		await harness.client.callTool({
			name: "schedule_control",
			arguments: { operation: "continue" },
		});
		const stopped = await harness.client.callTool({
			name: "schedule_control",
			arguments: { operation: "stop" },
		});
		expect(structuredOf(stopped)).toMatchObject({ state: "stopped" });
	});

	it("marks the item being worked on", async () => {
		harness = await startHarness();
		await connect();
		await addItem({ action: "start_mosaic", target_name: "M31", session_minutes: 30 });
		await harness.client.callTool({ name: "schedule_control", arguments: { operation: "start" } });

		const result = await harness.client.callTool({ name: "schedule_get", arguments: {} });

		expect(textOf(result)).toContain("▶");
	});

	it("reports the driver's refusal instead of showing an empty schedule", async () => {
		harness = await startHarness();
		await connect();
		await addItem({ action: "start_mosaic", target_name: "M31", session_minutes: 30 });
		await harness.client.callTool({ name: "schedule_control", arguments: { operation: "start" } });

		const result = await harness.client.callTool({ name: "schedule_create", arguments: {} });

		expect(isError(result)).toBe(true);
		expect(textOf(result)).toContain("scheduler is still active");
		expect(textOf(result)).not.toContain("The schedule is empty");
	});

	it("is hidden in read-only mode except for reading it", async () => {
		harness = await startHarness({ readOnly: true });

		const names = (await harness.client.listTools()).tools.map((tool) => tool.name);

		expect(names).toContain("schedule_get");
		expect(names).not.toContain("schedule_add_item");
		expect(names).not.toContain("schedule_control");
	});
});

describe("seestar_raw", () => {
	it("sends a firmware method the dedicated tools do not cover", async () => {
		harness = await startHarness();
		await connect();

		const result = await harness.client.callTool({
			name: "seestar_raw",
			arguments: { method: "get_camera_info" },
		});

		expect(isError(result)).toBe(false);
		expect(harness.fake.sim.calls.at(-1)).toEqual({
			action: "method_sync",
			parameters: { method: "get_camera_info" },
		});
	});

	it("passes array params through", async () => {
		harness = await startHarness();
		await connect();

		await harness.client.callTool({
			name: "seestar_raw",
			arguments: { method: "set_control_value", params: '["gain", 200]' },
		});

		expect(harness.fake.sim.gain).toBe(200);
	});

	it("rejects params that are not JSON", async () => {
		harness = await startHarness();
		await connect();

		const result = await harness.client.callTool({
			name: "seestar_raw",
			arguments: { method: "set_setting", params: "gain=200" },
		});

		expect(isError(result)).toBe(true);
		expect(textOf(result)).toContain("valid JSON");
	});

	it("can be switched off", async () => {
		harness = await startHarness({ allowRaw: false });

		const names = (await harness.client.listTools()).tools.map((tool) => tool.name);
		expect(names).not.toContain("seestar_raw");
	});
});

describe("seestar_power", () => {
	it("is not offered unless destructive tools are allowed", async () => {
		harness = await startHarness();

		const names = (await harness.client.listTools()).tools.map((tool) => tool.name);
		expect(names).not.toContain("seestar_power");
	});

	it("requires an explicit confirmation", async () => {
		harness = await startHarness({ allowDestructive: true });
		await connect();

		const result = await harness.client.callTool({
			name: "seestar_power",
			arguments: { operation: "shutdown" },
		});

		expect(isError(result)).toBe(true);
		// Only the driver probe (test_connection) may have reached the firmware.
		const sent = harness.fake.sim.calls.filter(
			(call) =>
				call.action === "method_sync" &&
				(call.parameters as { method?: string }).method !== "test_connection",
		);
		expect(sent).toEqual([]);
	});

	it("shuts down when confirmed", async () => {
		harness = await startHarness({ allowDestructive: true });
		await connect();

		const result = await harness.client.callTool({
			name: "seestar_power",
			arguments: { operation: "shutdown", confirm: true },
		});

		expect(isError(result)).toBe(false);
		expect(textOf(result)).toContain("switched on by hand");
		expect(harness.fake.sim.calls.at(-1)).toEqual({
			action: "method_sync",
			parameters: { method: "pi_shutdown" },
		});
	});
});
