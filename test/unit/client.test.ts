import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AlpacaClient } from "../../src/alpaca/client.js";
import {
	AlpacaDeviceError,
	AlpacaHttpError,
	AlpacaTransportError,
	AscomErrorCode,
} from "../../src/alpaca/errors.js";
import { type FakeAlpaca, startFakeAlpaca } from "../fake/alpaca-server.js";
import { expectFailure } from "../helpers.js";

let fake: FakeAlpaca;
let client: AlpacaClient;

beforeEach(async () => {
	fake = await startFakeAlpaca();
	fake.setConnected(1, true);
	client = new AlpacaClient({
		host: fake.host,
		port: fake.port,
		clientId: 42,
		timeoutMs: 1_000,
	});
});

afterEach(async () => {
	await fake.close();
});

describe("AlpacaClient", () => {
	it("reads a property and unwraps Value", async () => {
		fake.sim.rightAscension = 5.5;
		await expect(client.get("telescope", 1, "rightascension")).resolves.toBe(5.5);
	});

	it("lowercases the method in the URL but keeps parameter names as given", async () => {
		fake.sim.unpark();
		await client.put("telescope", 1, "SlewToCoordinatesAsync", {
			RightAscension: 3,
			Declination: 20,
		});

		const request = fake.requests.at(-1);
		expect(request?.path).toBe("/api/v1/telescope/1/slewtocoordinatesasync");
		expect(request?.params.RightAscension).toBe("3");
		expect(request?.params.Declination).toBe("20");
	});

	it("sends booleans capitalised, the way ASCOM clients do", async () => {
		await client.put("telescope", 1, "tracking", { Tracking: true });
		expect(fake.requests.at(-1)?.params.Tracking).toBe("True");

		await client.put("telescope", 1, "tracking", { Tracking: false });
		expect(fake.requests.at(-1)?.params.Tracking).toBe("False");
	});

	it("stamps every request with ClientID and a rising ClientTransactionID", async () => {
		await client.get("telescope", 1, "connected");
		await client.get("telescope", 1, "connected");

		const [first, second] = fake.requests.slice(-2);
		expect(first?.params.ClientID).toBe("42");
		expect(second?.params.ClientID).toBe("42");
		expect(Number(second?.params.ClientTransactionID)).toBeGreaterThan(
			Number(first?.params.ClientTransactionID),
		);
	});

	it("turns a non-zero ErrorNumber into an AlpacaDeviceError", async () => {
		fake.setConnected(1, false);

		const error = await expectFailure(
			client.get("telescope", 1, "rightascension"),
			AlpacaDeviceError,
		);
		expect(error.errorNumber).toBe(AscomErrorCode.NotConnected);
		expect(error.errorName).toBe("NotConnected");
		expect(error.message).toContain("telescope/1/rightascension");
	});

	it("raises AlpacaHttpError for a bad status", async () => {
		fake.failNext({ status: 404, times: 3 });

		const error = await expectFailure(client.get("telescope", 1, "connected"), AlpacaHttpError);
		expect(error.status).toBe(404);
	});

	it("raises AlpacaTransportError when the body is not JSON", async () => {
		fake.failNext({ garbage: true, times: 3 });

		const error = await expectFailure(
			client.get("telescope", 1, "connected"),
			AlpacaTransportError,
		);
		expect(error.message).toContain("not JSON");
	});

	it("raises AlpacaTransportError on timeout", async () => {
		fake.failNext({ delayMs: 200, times: 3 });

		const error = await expectFailure(
			client.get("telescope", 1, "connected", {}, { timeoutMs: 40, retries: 0 }),
			AlpacaTransportError,
		);
		expect(error.timedOut).toBe(true);
	});

	it("retries a GET after a server error and succeeds", async () => {
		fake.failNext({ status: 502 });

		await expect(client.get("telescope", 1, "connected")).resolves.toBe(true);
		expect(fake.requests.filter((r) => r.path.endsWith("/connected"))).toHaveLength(2);
	});

	it("does not retry a GET that timed out, because a stuck server stays stuck", async () => {
		fake.failNext({ delayMs: 300, times: 3 });
		const before = fake.requests.length;

		await expectFailure(
			client.get("telescope", 1, "connected", {}, { timeoutMs: 40 }),
			AlpacaTransportError,
		);

		expect(fake.requests.length - before).toBe(1);
	});

	it("does not retry a PUT, because commands are not idempotent", async () => {
		fake.setConnected(1, true);
		fake.sim.unpark();
		fake.failNext({ status: 502 });

		await expect(
			client.put("telescope", 1, "slewtocoordinatesasync", {
				RightAscension: 1,
				Declination: 1,
			}),
		).rejects.toBeInstanceOf(AlpacaHttpError);

		const slews = fake.requests.filter((r) => r.path.endsWith("/slewtocoordinatesasync"));
		expect(slews).toHaveLength(1);
	});

	it("does not retry a device error", async () => {
		fake.failNext({
			errorNumber: AscomErrorCode.InvalidValue,
			errorMessage: "nope",
			times: 5,
		});

		await expect(client.get("telescope", 1, "connected")).rejects.toBeInstanceOf(AlpacaDeviceError);
		expect(fake.requests.filter((r) => r.path.endsWith("/connected"))).toHaveLength(1);
	});

	it("reads the management API", async () => {
		await expect(client.management<number[]>("apiversions")).resolves.toEqual([1]);
	});
});

describe("AlpacaClient authorization", () => {
	it("sends HTTP Basic credentials to a protected server", async () => {
		const protectedFake = await startFakeAlpaca({
			credentials: { username: "User", password: "s3cret" },
		});
		try {
			protectedFake.setConnected(1, true);
			protectedFake.sim.rightAscension = 7.25;
			const authorised = new AlpacaClient({
				host: protectedFake.host,
				port: protectedFake.port,
				auth: { username: "User", password: "s3cret" },
			});

			await expect(authorised.get("telescope", 1, "rightascension")).resolves.toBe(7.25);
		} finally {
			await protectedFake.close();
		}
	});

	it("reports a missing password as HTTP 401", async () => {
		const protectedFake = await startFakeAlpaca({
			credentials: { username: "User", password: "s3cret" },
		});
		try {
			const anonymous = new AlpacaClient({ host: protectedFake.host, port: protectedFake.port });

			const error = await expectFailure(
				anonymous.get("telescope", 1, "rightascension"),
				AlpacaHttpError,
			);
			expect(error.status).toBe(401);
		} finally {
			await protectedFake.close();
		}
	});
});
