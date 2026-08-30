import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AlpacaClient } from "../../src/alpaca/client.js";
import { AlpacaDevice } from "../../src/alpaca/device.js";
import { Telescope } from "../../src/alpaca/devices/telescope.js";
import { describeServer, discoverServers } from "../../src/alpaca/discovery.js";
import { AlpacaDeviceError, AscomErrorCode } from "../../src/alpaca/errors.js";
import { expectFailure } from "../helpers.js";
import {
	type Simulator,
	simulatorAvailable,
	simulatorMissingMessage,
	startSimulator,
} from "./simulator.js";

/**
 * The Alpaca client against the reference implementation.
 *
 * Our own fake was written from the seestar_alp sources; this suite checks the same code against
 * the simulators the ASCOM Initiative ships, which is where a misreading of the specification would
 * show up.
 */

const available = simulatorAvailable();
if (!available) console.warn(simulatorMissingMessage());

let simulator: Simulator;
let client: AlpacaClient;
let telescope: Telescope;

beforeAll(async () => {
	if (!available) return;
	simulator = await startSimulator();
	client = new AlpacaClient({ host: simulator.host, port: simulator.port, timeoutMs: 10_000 });
	telescope = new Telescope(client, 0);
}, 90_000);

afterAll(async () => {
	await simulator?.close();
});

describe.skipIf(!available)("management API", () => {
	it("reports the API version", async () => {
		await expect(client.management<number[]>("apiversions")).resolves.toContain(1);
	});

	it("lists every simulated device", async () => {
		const described = await describeServer({ address: simulator.host, port: simulator.port });
		const types = (described.devices ?? []).map((device) => device.DeviceType.toLowerCase());

		expect(described.description?.ServerName).toBeTruthy();
		expect(types).toEqual(
			expect.arrayContaining(["telescope", "camera", "focuser", "filterwheel", "dome", "switch"]),
		);
	});

	it("answers a UDP discovery probe on the loopback interface", async () => {
		const servers = await discoverServers({
			addresses: ["127.0.0.1"],
			bindAddress: "127.0.0.1",
			timeoutMs: 2_000,
		});

		expect(servers.map((server) => server.port)).toContain(simulator.port);
	});
});

describe.skipIf(!available)("telescope", () => {
	beforeAll(async () => {
		await telescope.setConnected(true);
	});

	it("identifies itself", async () => {
		const described = await telescope.describe();

		expect(described.name).toBeTruthy();
		expect(described.interfaceVersion).toBeGreaterThanOrEqual(3);
		expect(described.connected).toBe(true);
	});

	it("reports a complete status", async () => {
		const status = await telescope.status();

		expect(status.connected).toBe(true);
		expect(typeof status.rightAscension).toBe("number");
		expect(typeof status.declination).toBe("number");
		expect(typeof status.slewing).toBe("boolean");
		expect(status.siteLatitude).toBeTypeOf("number");
	});

	it("reports its capabilities", async () => {
		const capabilities = await telescope.capabilities();

		expect(capabilities.canSlewAsync).toBe(true);
		expect(capabilities.canPark).toBe(true);
	});

	it("slews to coordinates and gets there", async () => {
		await telescope.unpark().catch(() => undefined);
		await telescope.setTracking(true);

		const target = { ra: (await telescope.rightAscension()) + 0.2, dec: 25 };
		await telescope.slewToCoordinates(target.ra, target.dec);
		const settled = await telescope.waitForSlewComplete({
			pollIntervalMs: 250,
			timeoutMs: 60_000,
		});

		expect(settled).toBe(true);
		expect(await telescope.rightAscension()).toBeCloseTo(target.ra, 2);
		expect(await telescope.declination()).toBeCloseTo(target.dec, 2);
	}, 90_000);

	it("rejects coordinates outside the valid range with InvalidValue", async () => {
		const error = await expectFailure(telescope.slewToCoordinates(30, 0), AlpacaDeviceError);
		expect(error.errorNumber).toBe(AscomErrorCode.InvalidValue);
	});

	it("parks and unparks — asynchronously, as the specification says", async () => {
		await telescope.park();

		// Park returns at once; atpark turns true when the mount has actually arrived.
		const parked = await waitFor(() => telescope.get<boolean>("atpark"), 60_000);
		expect(parked).toBe(true);

		await telescope.unpark();
		await expect(telescope.get<boolean>("atpark")).resolves.toBe(false);
	}, 90_000);

	it("reports an empty action list, and refuses an unknown action", async () => {
		await expect(telescope.supportedActions()).resolves.toBeInstanceOf(Array);

		const error = await expectFailure(telescope.action("no_such_action", ""), AlpacaDeviceError);
		expect(error.errorNumber).toBeGreaterThanOrEqual(AscomErrorCode.NotImplemented);
	});
});

/** Poll a getter until it reports true, or give up. */
async function waitFor(read: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await read()) return true;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return false;
}

describe.skipIf(!available)("other device types", () => {
	it("drives a focuser through the generic device layer", async () => {
		const focuser = new AlpacaDevice(client, "focuser", 0);
		await focuser.setConnected(true);

		const position = await focuser.get<number>("position");
		expect(typeof position).toBe("number");

		await focuser.put("move", { Position: position + 100 });
		await expect(focuser.get<boolean>("ismoving")).resolves.toBeTypeOf("boolean");
	}, 60_000);

	it("reads filter wheel names", async () => {
		const wheel = new AlpacaDevice(client, "filterwheel", 0);
		await wheel.setConnected(true);

		await expect(wheel.get<string[]>("names")).resolves.toBeInstanceOf(Array);
	});

	it("reads camera geometry", async () => {
		const camera = new AlpacaDevice(client, "camera", 0);
		await camera.setConnected(true);

		await expect(camera.get<number>("cameraxsize")).resolves.toBeGreaterThan(0);
	});
});
