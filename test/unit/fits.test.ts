import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isCfa, parseValue, readFitsHeader, readFrameInfo } from "../../src/processing/fits.js";
import { seestarLightCards, writeFits } from "../fake/fits.js";

let workDir: string;

beforeAll(async () => {
	workDir = await mkdtemp(join(tmpdir(), "seestar-fits-"));
});

afterAll(async () => {
	await rm(workDir, { recursive: true, force: true });
});

describe("parseValue", () => {
	it("reads quoted strings, including escaped quotes", () => {
		expect(parseValue("'M 31'              / target")).toBe("M 31");
		expect(parseValue("'it''s a comet'")).toBe("it's a comet");
		expect(parseValue("'  padded  '")).toBe("  padded");
	});

	it("reads booleans", () => {
		expect(parseValue("                   T")).toBe(true);
		expect(parseValue("                   F / no")).toBe(false);
	});

	it("reads numbers, including FORTRAN exponents", () => {
		expect(parseValue("                  16")).toBe(16);
		expect(parseValue("              12.5 / degrees")).toBe(12.5);
		expect(parseValue("            1.5D3")).toBe(1500);
		expect(parseValue("             -0.75")).toBe(-0.75);
	});

	it("returns nothing for an empty value", () => {
		expect(parseValue("      ")).toBeUndefined();
		expect(parseValue("   / only a comment")).toBeUndefined();
	});

	it("keeps an unquoted word it cannot classify", () => {
		expect(parseValue("  LIGHT / frame type")).toBe("LIGHT");
	});
});

describe("readFitsHeader", () => {
	it("reads the mandatory cards", async () => {
		const path = await writeFits(join(workDir, "plain.fit"), { width: 1080, height: 1920 });

		const header = await readFitsHeader(path);

		expect(header.cards.get("SIMPLE")).toBe(true);
		expect(header.cards.get("NAXIS1")).toBe(1080);
		expect(header.cards.get("NAXIS2")).toBe(1920);
	});

	it("stops at END and never reads the pixel data", async () => {
		const path = await writeFits(join(workDir, "big.fit"), {
			width: 200,
			height: 200,
			cards: { OBJECT: "M 42" },
		});

		const header = await readFitsHeader(path);

		expect(header.cards.get("OBJECT")).toBe("M 42");
		// Nothing from the data block leaked in as a card.
		expect(header.cards.size).toBeLessThan(20);
	});

	it("refuses a file that is not FITS", async () => {
		const path = await writeFits(join(workDir, "broken.fit"), { corrupt: true });

		await expect(readFitsHeader(path)).rejects.toThrow(/SIMPLE/);
	});

	it("collects COMMENT and HISTORY separately from values", async () => {
		const path = await writeFits(join(workDir, "commented.fit"), {
			cards: { COMMENT: "written by a test", HISTORY: "stacked 42 frames" },
		});

		const header = await readFitsHeader(path);

		expect(header.cards.has("COMMENT")).toBe(false);
		expect(header.comments.join(" ")).toContain("written by a test");
	});
});

describe("readFrameInfo", () => {
	it("pulls out what an astrophotographer asks about", async () => {
		const path = await writeFits(join(workDir, "light.fit"), {
			width: 1080,
			height: 1920,
			cards: seestarLightCards(),
		});

		const info = await readFrameInfo(path);

		expect(info).toMatchObject({
			width: 1080,
			height: 1920,
			object: "M 31",
			exposureSeconds: 10,
			gain: 80,
			temperatureC: 12.5,
			filter: "IRCUT",
			instrument: "Seestar S50",
			binning: 1,
			focalLengthMm: 250,
			imageType: "LIGHT",
		});
		expect(info.dateObs).toBe("2026-08-30T21:14:07.123");
		expect(info.sizeBytes).toBeGreaterThan(0);
	});

	it("reads the Bayer pattern, which decides whether the frames need demosaicing", async () => {
		const path = await writeFits(join(workDir, "cfa.fit"), { cards: seestarLightCards() });

		const info = await readFrameInfo(path);

		expect(info.bayerPattern).toBe("GRBG");
		expect(isCfa(info)).toBe(true);
	});

	it("does not call an already-demosaiced frame a mosaic", async () => {
		const colour = await writeFits(join(workDir, "colour.fit"), {
			cards: seestarLightCards({ NAXIS3: 3 }),
		});
		const mono = await writeFits(join(workDir, "mono.fit"), {
			cards: seestarLightCards({ BAYERPAT: undefined }),
		});

		// Three planes: something has demosaiced it already, whatever the header still says.
		expect(isCfa(await readFrameInfo(colour))).toBe(false);
		expect(isCfa(await readFrameInfo(mono))).toBe(false);
	});

	it("accepts the alternative keywords other capture software writes", async () => {
		const path = await writeFits(join(workDir, "alt.fit"), {
			cards: { EXPOSURE: 30, CCDTEMP: -5, CAMERA: "ASI533", NCOMBINE: 120 },
		});

		const info = await readFrameInfo(path);

		expect(info).toMatchObject({
			exposureSeconds: 30,
			temperatureC: -5,
			instrument: "ASI533",
			stackedFrames: 120,
		});
	});

	it("leaves out what the file does not say", async () => {
		const path = await writeFits(join(workDir, "bare.fit"));

		const info = await readFrameInfo(path);

		expect(info.object).toBeUndefined();
		expect(info.gain).toBeUndefined();
		expect(info.width).toBe(8);
	});
});
