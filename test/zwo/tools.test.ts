import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectClient, isError, structuredOf, textOf } from "../mcp-client.js";
import { type Stand, standUnavailable, startStand } from "./stand.js";

/**
 * The MCP tools against the Seestar's built-in Alpaca server — ZWO's own code, with only the
 * firmware under it faked.
 *
 * Run with `yarn test:zwo`. Needs Docker and a copy of the server (see stand.ts); skips otherwise.
 */

if (standUnavailable) console.warn(standUnavailable);
const skip = standUnavailable !== undefined;

describe.skipIf(skip)("built-in server, default settings", () => {
	let stand: Stand;
	let client: Client;

	beforeAll(async () => {
		stand = await startStand();
		// No port or device number: the defaults are the built-in server's.
		client = await connectClient({ host: stand.host, port: stand.port, timeoutMs: 15_000 });
	}, 600_000);

	afterAll(async () => {
		await client?.close();
		await stand?.close();
	});

	it("connects with the defaults and recognises the built-in server", async () => {
		const result = await client.callTool({ name: "device_connect", arguments: {} });

		expect(isError(result)).toBe(false);
		expect(structuredOf(result)).toMatchObject({
			device_number: 0,
			connected: true,
			is_seestar: false,
			driver_kind: "builtin",
		});
		expect(textOf(result)).toContain("Seestar S50_fake0001 Telescope");
	});

	it("lists every device the server offers, all numbered 0", async () => {
		const result = await client.callTool({
			name: "alpaca_devices",
			arguments: { host: stand.host, port: stand.port },
		});

		for (const device of ["telescope/0", "camera/0", "focuser/0", "filterwheel/0", "switch/0"]) {
			expect(textOf(result)).toContain(device);
		}
	});

	it("reports a readable telescope status", async () => {
		const result = await client.callTool({ name: "telescope_status", arguments: {} });

		expect(isError(result)).toBe(false);
		expect(textOf(result)).toMatch(/right ascension\s+05h 30m/);
	});

	it("slews and waits for the slew to finish", async () => {
		const result = await client.callTool({
			name: "telescope_goto",
			arguments: { ra: 12.5, dec: 15, wait: true, timeout_s: 60 },
		});

		expect(isError(result)).toBe(false);
		expect(textOf(result)).toMatch(/right ascension\s+12h 30m/);
	});

	it("turns the seestar_* tools away with directions instead of a bare error", async () => {
		const result = await client.callTool({ name: "seestar_state", arguments: {} });

		expect(isError(result)).toBe(true);
		expect(textOf(result)).toContain("built-in Alpaca server");
		expect(textOf(result)).toContain("alpaca_get_property");
	});

	it("reaches the focuser through the generic tools", async () => {
		await client.callTool({
			name: "alpaca_put",
			arguments: { device_type: "focuser", method: "connected", params: '{"Connected": true}' },
		});

		const result = await client.callTool({
			name: "alpaca_get_property",
			arguments: { device_type: "focuser", property: "position" },
		});

		expect(isError(result)).toBe(false);
		expect(textOf(result)).toContain("1600");
	});
});

describe.skipIf(skip)("built-in server with a password", () => {
	let stand: Stand;

	beforeAll(async () => {
		stand = await startStand({ password: "s3cret" });
	}, 600_000);

	afterAll(async () => {
		await stand?.close();
	});

	it("says a password is needed when none is given", async () => {
		const client = await connectClient({ host: stand.host, port: stand.port });
		try {
			const result = await client.callTool({ name: "device_connect", arguments: {} });

			expect(isError(result)).toBe(true);
			expect(textOf(result)).toContain("--password");
		} finally {
			await client.close();
		}
	});

	it("connects with the password", async () => {
		const client = await connectClient({
			host: stand.host,
			port: stand.port,
			password: "s3cret",
			timeoutMs: 15_000,
		});
		try {
			const result = await client.callTool({ name: "device_connect", arguments: {} });

			expect(isError(result)).toBe(false);
			expect(structuredOf(result)).toMatchObject({ driver_kind: "builtin" });
		} finally {
			await client.close();
		}
	});
});
