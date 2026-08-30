import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AlpacaClient } from "../../src/alpaca/client.js";
import { AlpacaDevice } from "../../src/alpaca/device.js";
import { SeestarActions, SeestarError, unwrap } from "../../src/seestar/actions.js";
import { type FakeAlpaca, startFakeAlpaca } from "../fake/alpaca-server.js";
import { expectFailure } from "../helpers.js";

describe("unwrap", () => {
	it("passes through values that carry no envelope", () => {
		expect(unwrap("x", "started")).toBe("started");
		expect(unwrap("x", 42)).toBe(42);
		expect(unwrap("x", false)).toBe(false);
		expect(unwrap("x", { url: "http://scope/a.jpg" })).toEqual({ url: "http://scope/a.jpg" });
	});

	it("peels the driver and firmware envelopes", () => {
		expect(
			unwrap("x", { jsonrpc: "2.0", command: "get_schedule", code: 0, result: { a: 1 } }),
		).toEqual({ a: 1 });
		expect(unwrap("x", { jsonrpc: "2.0", method: "get_setting", code: 0, result: true })).toBe(
			true,
		);
	});

	it("turns a refusal into an error", () => {
		expect(() =>
			unwrap("start_mosaic", {
				code: -1,
				result: "An existing scheduler is active. Returned with no action.",
			}),
		).toThrow(SeestarError);
	});

	it("turns a firmware error member into an error", () => {
		const error = (() => {
			try {
				unwrap("method_sync", { error: { message: "device busy" }, code: 5 });
			} catch (thrown) {
				return thrown as SeestarError;
			}
			throw new Error("expected a failure");
		})();

		expect(error.message).toContain("device busy");
		expect(error.code).toBe(5);
	});
});

describe("SeestarActions", () => {
	let fake: FakeAlpaca;
	let actions: SeestarActions;

	beforeEach(async () => {
		fake = await startFakeAlpaca();
		fake.setConnected(1, true);
		const client = new AlpacaClient({ host: fake.host, port: fake.port, timeoutMs: 1_000 });
		actions = new SeestarActions(new AlpacaDevice(client, "telescope", 1));
	});

	afterEach(async () => {
		await fake.close();
	});

	it("sends the action name and JSON parameters the driver expects", async () => {
		await actions.call("goto_target", { target_name: "M31", ra: 0.71, dec: 41.2, is_j2000: true });

		const request = fake.requests.at(-1);
		expect(request?.params.Action).toBe("goto_target");
		expect(JSON.parse(request?.params.Parameters ?? "{}")).toEqual({
			target_name: "M31",
			ra: 0.71,
			dec: 41.2,
			is_j2000: true,
		});
	});

	it("wraps a firmware method in method_sync and returns its result", async () => {
		const state = await actions.methodSync<Record<string, unknown>>("get_device_state");

		expect(fake.sim.calls.at(-1)).toEqual({
			action: "method_sync",
			parameters: { method: "get_device_state" },
		});
		expect(state).toHaveProperty("device");
	});

	it("passes firmware params through untouched", async () => {
		await actions.methodSync("set_control_value", ["gain", 120]);

		expect(fake.sim.calls.at(-1)?.parameters).toEqual({
			method: "set_control_value",
			params: ["gain", 120],
		});
		expect(fake.sim.gain).toBe(120);
	});

	it("does not wait for an async method", async () => {
		await expect(actions.methodAsync("start_solve")).resolves.toBe("async request sent.");
	});

	it("reports a refused action as a SeestarError", async () => {
		await actions.call("start_mosaic", { target_name: "M31", session_time_sec: 60 });

		const error = await expectFailure(
			actions.call("start_mosaic", { target_name: "M42", session_time_sec: 60 }),
			SeestarError,
		);
		expect(error.message).toContain("existing scheduler is active");
	});
});
