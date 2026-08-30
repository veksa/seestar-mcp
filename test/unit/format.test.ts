import { describe, expect, it } from "vitest";
import {
	formatDeclination,
	formatDuration,
	formatFields,
	formatRightAscension,
	formatUnavailable,
} from "../../src/format.js";

describe("formatRightAscension", () => {
	it("renders hours, minutes and seconds", () => {
		// M42 sits at roughly 05h 35m 17s.
		expect(formatRightAscension(5.58825)).toBe("05h 35m 17.7s");
		expect(formatRightAscension(0)).toBe("00h 00m 00.0s");
		expect(formatRightAscension(12.5)).toBe("12h 30m 00.0s");
	});

	it("carries the rounding instead of printing 60 seconds", () => {
		expect(formatRightAscension(5.9999999)).toBe("06h 00m 00.0s");
		expect(formatRightAscension(23.9999999)).toBe("00h 00m 00.0s");
	});

	it("wraps values outside 0-24", () => {
		expect(formatRightAscension(25)).toBe("01h 00m 00.0s");
		expect(formatRightAscension(-1)).toBe("23h 00m 00.0s");
	});

	it("says so when the value is not a number", () => {
		expect(formatRightAscension(Number.NaN)).toBe("unknown");
	});
});

describe("formatDeclination", () => {
	it("keeps the sign and renders degrees, arcminutes and arcseconds", () => {
		expect(formatDeclination(22.0145)).toBe("+22° 00′ 52″");
		expect(formatDeclination(-5.39)).toBe("-05° 23′ 24″");
		expect(formatDeclination(0)).toBe("+00° 00′ 00″");
	});

	it("carries the rounding instead of printing 60 arcseconds", () => {
		expect(formatDeclination(41.999999)).toBe("+42° 00′ 00″");
	});

	it("keeps the minus sign for values just below zero", () => {
		expect(formatDeclination(-0.5)).toBe("-00° 30′ 00″");
	});
});

describe("formatDuration", () => {
	it("scales the unit to the length", () => {
		expect(formatDuration(45)).toBe("45s");
		expect(formatDuration(300)).toBe("5m 0s");
		expect(formatDuration(4320)).toBe("1h 12m");
	});

	it("says so when the value makes no sense", () => {
		expect(formatDuration(-1)).toBe("unknown");
	});
});

describe("formatFields", () => {
	it("aligns labels and drops the ones with no value", () => {
		const text = formatFields([
			["name", "Seestar"],
			["battery", undefined],
			["firmware", "4.11"],
		]);

		expect(text).toBe("name      Seestar\nfirmware  4.11");
	});

	it("returns nothing when there is nothing to show", () => {
		expect(formatFields([["name", undefined]])).toBe("");
	});
});

describe("formatUnavailable", () => {
	it("stays silent when everything was readable", () => {
		expect(formatUnavailable({})).toBe("");
	});

	it("lists what the device would not answer", () => {
		expect(formatUnavailable({ athome: "NotImplemented 0x400" })).toContain(
			"athome: NotImplemented 0x400",
		);
	});
});
