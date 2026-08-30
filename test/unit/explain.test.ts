import { describe, expect, it } from "vitest";
import {
	AlpacaDeviceError,
	AlpacaHttpError,
	AlpacaTransportError,
	AscomErrorCode,
} from "../../src/alpaca/errors.js";
import { SeestarError } from "../../src/seestar/actions.js";
import { SessionError } from "../../src/session.js";
import { explain } from "../../src/tools/result.js";

/**
 * The text a failing tool returns is the product surface: it is what the model reads before deciding
 * what to do next. Each of these asserts that the message names a way forward.
 */
describe("explain", () => {
	it("passes a session error through unchanged — it already says what to do", () => {
		expect(explain(new SessionError("No device selected. Run alpaca_discover…"))).toBe(
			"No device selected. Run alpaca_discover…",
		);
	});

	it("tells the caller to connect when the device is not connected", () => {
		const text = explain(
			new AlpacaDeviceError(AscomErrorCode.NotConnected, "Not connected.", {
				deviceType: "telescope",
				deviceNumber: 1,
			}),
		);

		expect(text).toContain("NotConnected");
		expect(text).toContain("device_connect");
	});

	it("explains a parked mount and names the tool that fixes it", () => {
		const text = explain(new AlpacaDeviceError(AscomErrorCode.InvalidWhileParked, "parked", {}));

		expect(text).toContain("parked");
		expect(text).toContain("telescope_unpark");
	});

	it("points at the Seestar tools when the driver does not implement something", () => {
		const text = explain(new AlpacaDeviceError(AscomErrorCode.NotImplemented, "nope", {}));
		expect(text).toContain("seestar_*");
	});

	it("reminds the caller of the units on an invalid value", () => {
		const text = explain(new AlpacaDeviceError(AscomErrorCode.InvalidValue, "bad", {}));
		expect(text).toContain("hours");
	});

	it("suggests stopping the running session when the scheduler is busy", () => {
		const text = explain(
			new SeestarError("start_mosaic", "An existing scheduler is active. Returned with no action."),
		);

		expect(text).toContain("imaging_stop");
	});

	it("does not invent advice for other Seestar failures", () => {
		const text = explain(new SeestarError("goto_target", "target below horizon"));

		expect(text).toBe("goto_target failed: target below horizon");
	});

	it("blames the network, not the telescope, when nothing answered", () => {
		const text = explain(
			new AlpacaTransportError("connection refused", {
				url: "http://192.168.1.20:5555/api/v1/telescope/1/connected",
			}),
		);

		expect(text).toContain("192.168.1.20:5555");
		expect(text).toContain("seestar_alp");
	});

	it("suggests patience on a timeout, since plate solving is slow", () => {
		const text = explain(
			new AlpacaTransportError("request timed out after 10000ms", {}, { timedOut: true }),
		);

		expect(text).toContain("plate-solving");
		expect(text).toContain("--timeout");
	});

	it("reads a 404 as the wrong device rather than a broken telescope", () => {
		const text = explain(
			new AlpacaHttpError(404, "not found", { deviceType: "camera", deviceNumber: 0 }),
		);

		expect(text).toContain("device type and number");
	});

	it("falls back to the message for anything else", () => {
		expect(explain(new Error("boom"))).toBe("boom");
		expect(explain("just a string")).toBe("just a string");
	});
});
