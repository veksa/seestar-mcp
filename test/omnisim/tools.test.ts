import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectClient, isError, structuredOf, textOf } from "../mcp-client.js";
import {
	type Simulator,
	simulatorAvailable,
	simulatorMissingMessage,
	startSimulator,
} from "./simulator.js";

/**
 * The MCP tools against the reference Alpaca implementation.
 *
 * This is the generic half of the server: a telescope that is not a Seestar, plus focuser and filter
 * wheel reached through the generic tools. If the Seestar-specific work ever leaked into the shared
 * layer, these tests are where it would show.
 */

const available = simulatorAvailable();
if (!available) console.warn(simulatorMissingMessage());

let simulator: Simulator;
let client: Client;

beforeAll(async () => {
	if (!available) return;
	simulator = await startSimulator();
	client = await connectClient({
		host: simulator.host,
		port: simulator.port,
		// The ASCOM simulators number every device 0, unlike seestar_alp.
		deviceNumber: 0,
		profile: "generic",
		timeoutMs: 15_000,
	});
	await client.callTool({ name: "device_connect", arguments: {} });
}, 90_000);

afterAll(async () => {
	await client?.close();
	await simulator?.close();
});

describe.skipIf(!available)("generic profile", () => {
	it("offers the standard tools and none of the Seestar ones", async () => {
		const names = (await client.listTools()).tools.map((tool) => tool.name);

		expect(names).toEqual(
			expect.arrayContaining([
				"telescope_status",
				"telescope_goto",
				"alpaca_get_property",
				"alpaca_put",
			]),
		);
		expect(names).not.toContain("seestar_state");
		expect(names).not.toContain("imaging_start");
	});

	it("does not mistake the simulator for a Seestar", async () => {
		const result = await client.callTool({ name: "device_connect", arguments: {} });

		expect(structuredOf(result)).toMatchObject({ is_seestar: false, connected: true });
		expect(textOf(result)).toContain("generic Alpaca device");
	});

	it("describes the device", async () => {
		const result = await client.callTool({ name: "device_info", arguments: {} });

		expect(isError(result)).toBe(false);
		expect(textOf(result)).toMatch(/telescope/i);
	});

	it("lists the simulated devices", async () => {
		const result = await client.callTool({
			name: "alpaca_devices",
			arguments: { host: simulator.host, port: simulator.port },
		});

		expect(textOf(result)).toContain("camera/0");
		expect(textOf(result)).toContain("focuser/0");
	});
});

describe.skipIf(!available)("telescope tools", () => {
	it("reports a readable status", async () => {
		const result = await client.callTool({ name: "telescope_status", arguments: {} });

		expect(structuredOf(result)).toMatchObject({ connected: true });
		expect(textOf(result)).toMatch(/right ascension\s+\d{2}h \d{2}m/);
	});

	it("slews and waits for the mount to arrive", async () => {
		await client.callTool({ name: "telescope_unpark", arguments: {} });
		await client.callTool({ name: "telescope_set_tracking", arguments: { enabled: true } });

		const result = await client.callTool({
			name: "telescope_goto",
			arguments: { ra: 12.5, dec: 15, wait: true, timeout_s: 120 },
		});

		expect(structuredOf(result)).toMatchObject({ completed: true, slewing: false });
		expect(structuredOf(result).right_ascension_hours).toBeCloseTo(12.5, 2);
	}, 180_000);

	it("refuses coordinates outside the valid range before they reach the mount", async () => {
		const result = await client.callTool({
			name: "telescope_goto",
			arguments: { ra: 25, dec: 0 },
		});

		expect(isError(result)).toBe(true);
	});
});

describe.skipIf(!available)("generic tools", () => {
	it("reads a property from another device type", async () => {
		await client.callTool({
			name: "alpaca_put",
			arguments: { device_type: "focuser", method: "connected", params: '{"Connected": true}' },
		});

		const result = await client.callTool({
			name: "alpaca_get_property",
			arguments: { device_type: "focuser", property: "position" },
		});

		expect(isError(result)).toBe(false);
		expect(structuredOf(result).value).toBeTypeOf("number");
	});

	it("moves a focuser through the generic write tool", async () => {
		const before = structuredOf(
			await client.callTool({
				name: "alpaca_get_property",
				arguments: { device_type: "focuser", property: "position" },
			}),
		).value as number;

		const result = await client.callTool({
			name: "alpaca_put",
			arguments: {
				device_type: "focuser",
				method: "move",
				params: `{"Position": ${before + 500}}`,
			},
		});

		expect(isError(result)).toBe(false);
	});

	it("explains a malformed params object instead of sending it", async () => {
		const result = await client.callTool({
			name: "alpaca_put",
			arguments: { device_type: "focuser", method: "move", params: "Position=500" },
		});

		expect(isError(result)).toBe(true);
		expect(textOf(result)).toContain("JSON object");
	});

	it("passes an Alpaca error through with its ASCOM name", async () => {
		const result = await client.callTool({
			name: "alpaca_get_property",
			arguments: { device_type: "telescope", property: "nosuchproperty" },
		});

		expect(isError(result)).toBe(true);
	});
});
