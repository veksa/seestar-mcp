import { describe, expect, it } from "vitest";
import {
	AlpacaDeviceError,
	AlpacaHttpError,
	AlpacaTransportError,
	AscomErrorCode,
	describeErrorNumber,
	isNotConnected,
	isNotImplemented,
} from "../../src/alpaca/errors.js";

describe("describeErrorNumber", () => {
	it("names the standard ASCOM codes", () => {
		expect(describeErrorNumber(AscomErrorCode.NotConnected)).toBe("NotConnected");
		expect(describeErrorNumber(AscomErrorCode.InvalidValue)).toBe("InvalidValue");
		expect(describeErrorNumber(AscomErrorCode.NotImplemented)).toBe("NotImplemented");
	});

	it("recognises the driver-specific range", () => {
		expect(describeErrorNumber(0x500)).toBe("DriverError");
		expect(describeErrorNumber(0xfff)).toBe("DriverError");
	});

	it("falls back for anything else", () => {
		expect(describeErrorNumber(7)).toBe("UnknownError");
	});
});

describe("AlpacaDeviceError", () => {
	it("reads like something a person can act on", () => {
		const error = new AlpacaDeviceError(AscomErrorCode.NotConnected, "Not connected.", {
			deviceType: "telescope",
			deviceNumber: 1,
			method: "rightascension",
		});

		expect(error.message).toBe("NotConnected 0x407: Not connected. (telescope/1/rightascension)");
		expect(error.name).toBe("AlpacaDeviceError");
	});

	it("survives without a message from the device", () => {
		const error = new AlpacaDeviceError(0x500, "", {});
		expect(error.message).toBe("DriverError 0x500: no message");
	});
});

describe("error predicates", () => {
	it("spots a disconnected device", () => {
		expect(isNotConnected(new AlpacaDeviceError(AscomErrorCode.NotConnected, "", {}))).toBe(true);
		expect(isNotConnected(new AlpacaDeviceError(AscomErrorCode.InvalidValue, "", {}))).toBe(false);
		expect(isNotConnected(new Error("boom"))).toBe(false);
	});

	it("spots an unimplemented member", () => {
		expect(isNotImplemented(new AlpacaDeviceError(AscomErrorCode.NotImplemented, "", {}))).toBe(
			true,
		);
		expect(
			isNotImplemented(new AlpacaDeviceError(AscomErrorCode.ActionNotImplemented, "", {})),
		).toBe(true);
		expect(isNotImplemented(new AlpacaDeviceError(AscomErrorCode.InvalidValue, "", {}))).toBe(
			false,
		);
	});
});

describe("transport and http errors", () => {
	it("keeps the status and body", () => {
		const error = new AlpacaHttpError(503, "  service unavailable  ", {
			method: "connected",
		});
		expect(error.status).toBe(503);
		expect(error.message).toBe("HTTP 503 (connected): service unavailable");
	});

	it("records whether it timed out", () => {
		const error = new AlpacaTransportError("request timed out after 10ms", {}, { timedOut: true });
		expect(error.timedOut).toBe(true);
	});
});
