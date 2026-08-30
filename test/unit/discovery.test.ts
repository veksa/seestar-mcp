import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	broadcastAddresses,
	describeServer,
	discover,
	discoverServers,
} from "../../src/alpaca/discovery.js";
import { type FakeAlpaca, startFakeAlpaca } from "../fake/alpaca-server.js";

let fake: FakeAlpaca;

beforeEach(async () => {
	fake = await startFakeAlpaca({ discovery: true });
});

afterEach(async () => {
	await fake.close();
});

/** Probing loopback only keeps the suite off the network (and out of the firewall dialog). */
const loopback = () => ({
	addresses: ["127.0.0.1"],
	bindAddress: "127.0.0.1",
	discoveryPort: fake.discoveryPort as number,
	timeoutMs: 400,
});

describe("discoverServers", () => {
	it("finds a server that answers the UDP probe", async () => {
		const servers = await discoverServers(loopback());

		expect(servers).toContainEqual({ address: "127.0.0.1", port: fake.port });
	});

	it("returns nothing when no one answers", async () => {
		const servers = await discoverServers({
			addresses: ["127.0.0.1"],
			bindAddress: "127.0.0.1",
			// A port nothing is listening on.
			discoveryPort: fake.port,
			timeoutMs: 200,
		});

		expect(servers).toEqual([]);
	});

	it("stops early when aborted", async () => {
		const controller = new AbortController();
		const started = Date.now();
		const pending = discoverServers({
			...loopback(),
			timeoutMs: 5_000,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 50);

		await pending;
		expect(Date.now() - started).toBeLessThan(2_000);
	});
});

describe("describeServer", () => {
	it("reads the management API", async () => {
		const described = await describeServer({
			address: fake.host,
			port: fake.port,
		});

		expect(described.description?.ServerName).toBe("seestar_alp (fake)");
		expect(described.devices).toEqual([
			{
				DeviceName: "Seestar Federation",
				DeviceType: "Telescope",
				DeviceNumber: 0,
				UniqueID: "fake-seestar-0",
			},
			{
				DeviceName: "Seestar 1",
				DeviceType: "Telescope",
				DeviceNumber: 1,
				UniqueID: "fake-seestar-1",
			},
		]);
	});

	it("reports the reason instead of throwing when the server is unreachable", async () => {
		const described = await describeServer({ address: "127.0.0.1", port: 1 }, { timeoutMs: 300 });

		expect(described.devices).toBeUndefined();
		expect(described.error).toBeTruthy();
	});
});

describe("discover", () => {
	it("finds the server and lists its devices", async () => {
		const [server] = await discover(loopback());

		expect(server?.port).toBe(fake.port);
		expect(server?.devices?.map((device) => device.DeviceNumber)).toEqual([0, 1]);
	});
});

describe("broadcastAddresses", () => {
	it("always includes the global broadcast address", () => {
		expect(broadcastAddresses()).toContain("255.255.255.255");
	});

	it("returns well-formed IPv4 addresses", () => {
		for (const address of broadcastAddresses()) {
			expect(address).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
		}
	});
});
