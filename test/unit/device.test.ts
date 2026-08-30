import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AlpacaClient } from "../../src/alpaca/client.js";
import { AlpacaDevice } from "../../src/alpaca/device.js";
import { AscomErrorCode } from "../../src/alpaca/errors.js";
import { type FakeAlpaca, startFakeAlpaca } from "../fake/alpaca-server.js";

let fake: FakeAlpaca;
let telescope: AlpacaDevice;

beforeEach(async () => {
	fake = await startFakeAlpaca();
	const client = new AlpacaClient({
		host: fake.host,
		port: fake.port,
		timeoutMs: 1_000,
	});
	telescope = new AlpacaDevice(client, "telescope", 1);
});

afterEach(async () => {
	await fake.close();
});

describe("AlpacaDevice", () => {
	it("connects and disconnects", async () => {
		await expect(telescope.isConnected()).resolves.toBe(false);

		await telescope.setConnected(true);
		await expect(telescope.isConnected()).resolves.toBe(true);

		await telescope.setConnected(false);
		await expect(telescope.isConnected()).resolves.toBe(false);
	});

	it("identifies itself as type/number", () => {
		expect(telescope.id).toBe("telescope/1");
	});

	it("reports an empty supportedactions list, as seestar_alp does", async () => {
		await expect(telescope.supportedActions()).resolves.toEqual([]);
	});

	it("passes actions through with their parameters as a JSON string", async () => {
		await telescope.setConnected(true);

		const result = await telescope.action(
			"method_sync",
			JSON.stringify({ method: "scope_get_equ_coord" }),
		);

		expect(fake.sim.calls.at(-1)).toEqual({
			action: "method_sync",
			parameters: { method: "scope_get_equ_coord" },
		});
		expect(result).toMatchObject({ result: { ra: 0, dec: 0 } });
	});

	it("describes everything it can reach in one pass", async () => {
		await telescope.setConnected(true);

		const described = await telescope.describe();

		expect(described).toMatchObject({
			deviceType: "telescope",
			deviceNumber: 1,
			name: "Seestar 1",
			interfaceVersion: 3,
			connected: true,
			supportedActions: [],
		});
		expect(described.unavailable).toEqual({});
	});

	it("collects failures instead of giving up on the whole description", async () => {
		await telescope.setConnected(true);
		fake.failNext({
			errorNumber: AscomErrorCode.NotImplemented,
			errorMessage: "nope",
		});

		const described = await telescope.describe();

		expect(Object.keys(described.unavailable)).toHaveLength(1);
		expect(Object.values(described.unavailable)[0]).toContain("NotImplemented");
		expect(described.deviceNumber).toBe(1);
	});
});
