import { afterEach, describe, expect, it } from "vitest";
import { type Harness, isError, startHarness, structuredOf, textOf } from "./harness.js";

let harness: Harness;

afterEach(async () => {
	await harness?.close();
});

/** Connect the way a host would: through the tool, not by poking the fake. */
async function connect(): Promise<void> {
	await harness.client.callTool({ name: "device_connect", arguments: {} });
}

describe("tool listing", () => {
	it("advertises the discovery and telescope tools", async () => {
		harness = await startHarness();

		const { tools } = await harness.client.listTools();
		const names = tools.map((tool) => tool.name);

		expect(names).toEqual(
			expect.arrayContaining([
				"alpaca_discover",
				"alpaca_devices",
				"device_connect",
				"device_info",
				"telescope_status",
				"telescope_goto",
				"telescope_abort",
				"telescope_park",
			]),
		);
	});

	it("documents that right ascension is in hours", async () => {
		harness = await startHarness();

		const { tools } = await harness.client.listTools();
		const goto = tools.find((tool) => tool.name === "telescope_goto");
		const schema = goto?.inputSchema as
			| { properties?: Record<string, { description?: string }> }
			| undefined;

		expect(schema?.properties?.ra?.description).toMatch(/hours/i);
	});

	it("hides everything that moves the telescope in read-only mode", async () => {
		harness = await startHarness({ readOnly: true });

		const names = (await harness.client.listTools()).tools.map((tool) => tool.name);

		expect(names).toContain("telescope_status");
		expect(names).not.toContain("telescope_goto");
		expect(names).not.toContain("telescope_park");
		expect(names).not.toContain("telescope_action");
	});

	it("hides the raw action tool when raw access is off", async () => {
		harness = await startHarness({ allowRaw: false });

		const names = (await harness.client.listTools()).tools.map((tool) => tool.name);
		expect(names).not.toContain("telescope_action");
	});
});

describe("device_connect", () => {
	it("connects and reports what it found", async () => {
		harness = await startHarness();

		const result = await harness.client.callTool({ name: "device_connect", arguments: {} });

		expect(isError(result)).toBe(false);
		expect(structuredOf(result)).toMatchObject({
			device_type: "telescope",
			device_number: 1,
			connected: true,
			is_seestar: true,
		});
		expect(textOf(result)).toContain("seestar");
	});

	it("disconnects on request", async () => {
		harness = await startHarness();
		await connect();

		const result = await harness.client.callTool({
			name: "device_connect",
			arguments: { connected: false },
		});

		expect(structuredOf(result)).toMatchObject({ connected: false });
	});

	it("does not claim a generic Alpaca device is a Seestar", async () => {
		// "Alpaca" appears in the identity of every Alpaca device there is, so detection must key on
		// the one word that is actually specific.
		harness = await startHarness(
			{},
			{
				serverName: "ASCOM Alpaca Simulators",
				identity: {
					name: "Alpaca Telescope Simulator",
					description: "ASCOM Alpaca Simulators",
					driverInfo: "Alpaca Telescope Simulator, ASCOM Initiative",
				},
			},
		);

		const result = await harness.client.callTool({ name: "device_connect", arguments: {} });

		expect(structuredOf(result)).toMatchObject({ is_seestar: false });
		expect(textOf(result)).toContain("generic Alpaca device");
	});

	it("warns when device 0 on seestar_alp is the federation", async () => {
		harness = await startHarness({ deviceNumber: 0 });

		const result = await harness.client.callTool({ name: "device_connect", arguments: {} });

		expect(textOf(result)).toContain("federation");
		expect(textOf(result)).toContain("device_number: 1");
	});

	it("tells the Seestar's built-in Alpaca server apart from seestar_alp", async () => {
		harness = await startHarness(
			{},
			{
				builtin: true,
				identity: {
					name: "Seestar S50_1a2b3c4d Telescope",
					description: "Seestar S50_1a2b3c4d Telescope",
					driverInfo: "Telescope V3",
				},
			},
		);

		const result = await harness.client.callTool({ name: "device_connect", arguments: {} });

		expect(structuredOf(result)).toMatchObject({ is_seestar: false, driver_kind: "builtin" });
		expect(textOf(result)).toContain("built-in Alpaca server");
	});

	it("points the seestar_* tools elsewhere on the built-in server", async () => {
		harness = await startHarness(
			{},
			{ builtin: true, identity: { name: "Seestar S50_1a2b3c4d Telescope" } },
		);
		await connect();

		const result = await harness.client.callTool({ name: "seestar_state", arguments: {} });

		expect(isError(result)).toBe(true);
		expect(textOf(result)).toContain("built-in Alpaca server");
		expect(textOf(result)).toContain("telescope_*");
	});

	it("recognises the real driver's own description as a Seestar", async () => {
		harness = await startHarness();

		const result = await harness.client.callTool({ name: "device_connect", arguments: {} });

		expect(structuredOf(result)).toMatchObject({ is_seestar: true, driver_kind: "seestar_alp" });
	});
});

describe("a password-protected server", () => {
	const credentials = { username: "User", password: "s3cret" };

	it("explains how to pass the password", async () => {
		harness = await startHarness({}, { credentials });

		const result = await harness.client.callTool({ name: "device_connect", arguments: {} });

		expect(isError(result)).toBe(true);
		expect(textOf(result)).toContain("--password");
	});

	it("connects with the password", async () => {
		harness = await startHarness({ password: "s3cret" }, { credentials });

		const result = await harness.client.callTool({ name: "device_connect", arguments: {} });

		expect(isError(result)).toBe(false);
		expect(structuredOf(result)).toMatchObject({ connected: true });
	});
});

describe("telescope_status", () => {
	it("explains what to do when no device has been selected", async () => {
		harness = await startHarness({ host: undefined });

		const result = await harness.client.callTool({ name: "telescope_status", arguments: {} });

		expect(isError(result)).toBe(true);
		expect(textOf(result)).toContain("alpaca_discover");
		expect(textOf(result)).toContain("device_connect");
	});

	it("says the device is not connected rather than reporting a broken telescope", async () => {
		harness = await startHarness();

		const result = await harness.client.callTool({ name: "telescope_status", arguments: {} });

		expect(structuredOf(result)).toMatchObject({ connected: false });
		expect(textOf(result)).toContain("run device_connect");
	});

	it("reports coordinates in both raw and readable form", async () => {
		harness = await startHarness();
		await connect();
		harness.fake.sim.unpark();
		harness.fake.sim.rightAscension = 5.588;
		harness.fake.sim.declination = -5.39;

		const result = await harness.client.callTool({ name: "telescope_status", arguments: {} });

		expect(structuredOf(result)).toMatchObject({
			connected: true,
			right_ascension_hours: 5.588,
			declination_degrees: -5.39,
			at_park: false,
		});
		expect(textOf(result)).toContain("05h 35m");
		expect(textOf(result)).toContain("-05°");
	});
});

describe("telescope_goto", () => {
	it("rejects coordinates outside the valid range before reaching the device", async () => {
		harness = await startHarness();
		await connect();

		const result = await harness.client.callTool({
			name: "telescope_goto",
			arguments: { ra: 30, dec: 0 },
		});

		expect(isError(result)).toBe(true);
		expect(textOf(result)).toMatch(/validation|too big|<=24/i);
		expect(harness.fake.requests.some((r) => r.path.includes("slew"))).toBe(false);
	});

	it("starts a slew and returns immediately", async () => {
		harness = await startHarness();
		await connect();
		harness.fake.sim.unpark();

		const result = await harness.client.callTool({
			name: "telescope_goto",
			arguments: { ra: 5.5, dec: 22 },
		});

		expect(isError(result)).toBe(false);
		expect(textOf(result)).toContain("Slewing to");
		expect(harness.fake.sim.slewing).toBe(true);
	});

	it("waits for the slew when asked, and reports the final position", async () => {
		harness = await startHarness();
		await connect();
		harness.fake.sim.unpark();

		const result = await harness.client.callTool({
			name: "telescope_goto",
			arguments: { ra: 5.5, dec: 22, wait: true, timeout_s: 5 },
		});

		expect(structuredOf(result)).toMatchObject({
			completed: true,
			slewing: false,
			right_ascension_hours: 5.5,
			declination_degrees: 22,
		});
	});

	it("explains the park state instead of failing silently", async () => {
		harness = await startHarness();
		await connect();

		const result = await harness.client.callTool({
			name: "telescope_goto",
			arguments: { ra: 5.5, dec: 22 },
		});

		expect(isError(result)).toBe(true);
		expect(textOf(result)).toContain("parked");
		expect(textOf(result)).toContain("telescope_unpark");
	});
});

describe("mount control", () => {
	it("parks, unparks and toggles tracking", async () => {
		harness = await startHarness();
		await connect();

		await harness.client.callTool({ name: "telescope_unpark", arguments: {} });
		expect(harness.fake.sim.atPark).toBe(false);

		await harness.client.callTool({
			name: "telescope_set_tracking",
			arguments: { enabled: true },
		});
		expect(harness.fake.sim.tracking).toBe(true);

		// Parking is asynchronous, in the fake as on real hardware: the call returns at once and
		// telescope_status is how you learn it has arrived — exactly what the tool tells you to do.
		await harness.client.callTool({ name: "telescope_park", arguments: {} });
		expect(harness.fake.sim.tracking).toBe(false);

		await new Promise((resolve) => setTimeout(resolve, 200));
		const status = await harness.client.callTool({ name: "telescope_status", arguments: {} });
		expect(structuredOf(status)).toMatchObject({ at_park: true, slewing: false });
	});

	it("aborts a slew in progress", async () => {
		harness = await startHarness();
		await connect();
		harness.fake.sim.unpark();
		harness.fake.sim.startSlew(12, 40);

		await harness.client.callTool({ name: "telescope_abort", arguments: {} });

		expect(harness.fake.sim.slewing).toBe(false);
	});

	it("syncs without moving the mount", async () => {
		harness = await startHarness();
		await connect();

		await harness.client.callTool({
			name: "telescope_sync",
			arguments: { ra: 3, dec: 10 },
		});

		expect(harness.fake.sim.rightAscension).toBe(3);
		expect(harness.fake.sim.declination).toBe(10);
		expect(harness.fake.sim.slewing).toBe(false);
	});
});

describe("telescope_action", () => {
	it("passes a raw action through to the driver", async () => {
		harness = await startHarness();
		await connect();

		const result = await harness.client.callTool({
			name: "telescope_action",
			arguments: {
				action: "method_sync",
				parameters: JSON.stringify({ method: "get_device_state" }),
			},
		});

		expect(isError(result)).toBe(false);
		expect(textOf(result)).toContain("firmware_ver_string");
		expect(harness.fake.sim.calls.at(-1)?.action).toBe("method_sync");
	});
});

describe("device_info", () => {
	it("warns that an empty action list means nothing on seestar_alp", async () => {
		harness = await startHarness();
		await connect();

		const result = await harness.client.callTool({ name: "device_info", arguments: {} });

		expect(textOf(result)).toContain("none advertised");
		expect(structuredOf(result)).toMatchObject({ supported_actions: [] });
	});
});

describe("alpaca_devices", () => {
	it("lists the devices a server exposes", async () => {
		harness = await startHarness();

		const result = await harness.client.callTool({
			name: "alpaca_devices",
			arguments: { host: harness.fake.host, port: harness.fake.port },
		});

		expect(textOf(result)).toContain("telescope/1");
		expect(structuredOf(result).devices).toHaveLength(2);
	});

	it("reports an unreachable server without throwing", async () => {
		harness = await startHarness();

		const result = await harness.client.callTool({
			name: "alpaca_devices",
			arguments: { host: "127.0.0.1", port: 1 },
		});

		expect(textOf(result)).toContain("Could not read");
	});
});
