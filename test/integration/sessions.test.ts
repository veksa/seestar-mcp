import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadProcessingConfig } from "../../src/processing/config.js";
import { seestarLightCards, writeFits } from "../fake/fits.js";
import { connectProcessingClient, isError, structuredOf, textOf } from "../mcp-client.js";

/**
 * Looking at a session on disk.
 *
 * The frames are real FITS files written by the fixture builder, so the header reader is exercised
 * end to end — target, exposure, gain and integration time come out of actual files.
 */

let workDir: string;
let client: Client | undefined;

beforeAll(async () => {
	workDir = await mkdtemp(join(tmpdir(), "astro-sessions-"));

	// A normal session: ten ten-second frames of M 31.
	for (let index = 1; index <= 10; index++) {
		await writeFits(join(workDir, "M31", "raw", `light_${String(index).padStart(4, "0")}.fit`), {
			width: 1080,
			height: 1920,
			cards: seestarLightCards({ "CCD-TEMP": 10 + index / 10 }),
		});
	}

	// A session where the exposure changed part-way through.
	await writeFits(join(workDir, "mixed", "raw", "a.fit"), {
		cards: seestarLightCards({ EXPTIME: 10, OBJECT: "M 42" }),
	});
	await writeFits(join(workDir, "mixed", "raw", "b.fit"), {
		cards: seestarLightCards({ EXPTIME: 30, OBJECT: "M 42" }),
	});

	// A session with only the stacked JPEG the telescope produced.
	await mkdir(join(workDir, "jpeg-only", "raw"), { recursive: true });
	await writeFile(join(workDir, "jpeg-only", "raw", "stacked.jpg"), "not really a jpeg");
});

afterAll(async () => {
	await rm(workDir, { recursive: true, force: true });
});

afterEach(async () => {
	await client?.close();
	client = undefined;
});

async function connect(overrides: Record<string, unknown> = {}): Promise<Client> {
	const config = { ...loadProcessingConfig([], { ASTRO_WORK_DIR: workDir }), ...overrides };
	client = await connectProcessingClient(config);
	return client;
}

describe("session_list", () => {
	it("lists the sessions with their frame counts", async () => {
		const connected = await connect();

		const result = await connected.callTool({ name: "session_list", arguments: {} });

		const sessions = structuredOf(result).sessions as Array<{ name: string; fits_files: number }>;
		expect(sessions.map((entry) => entry.name).sort()).toEqual(["M31", "jpeg-only", "mixed"]);
		expect(sessions.find((entry) => entry.name === "M31")?.fits_files).toBe(10);
		expect(textOf(result)).toContain("10 FITS");
	});

	it("says where it looked when there is nothing", async () => {
		const empty = await mkdtemp(join(tmpdir(), "astro-empty-"));
		const connected = await connect({ workDir: empty });

		const result = await connected.callTool({ name: "session_list", arguments: {} });

		expect(textOf(result)).toContain("No sessions in");
		expect(textOf(result)).toContain("imaging_download");
		await rm(empty, { recursive: true, force: true });
	});
});

describe("astro_inspect", () => {
	it("reports what was shot, from the FITS headers alone", async () => {
		const connected = await connect();

		const result = await connected.callTool({
			name: "astro_inspect",
			arguments: { session: "M31" },
		});

		expect(isError(result)).toBe(false);
		expect(structuredOf(result)).toMatchObject({
			frames: 10,
			object: "M 31",
			exposure_seconds: [10],
			gains: [80],
			filters: ["IRCUT"],
			integration_seconds: 100,
		});
		expect(textOf(result)).toContain("1m 40s");
		expect(textOf(result)).toContain("1080x1920");
		// The fixtures warm the sensor by a tenth of a degree per frame.
		expect(textOf(result)).toContain("10.1°C to 11°C");
	});

	it("warns when the exposure changed mid-session", async () => {
		const connected = await connect();

		const result = await connected.callTool({
			name: "astro_inspect",
			arguments: { session: "mixed" },
		});

		expect(structuredOf(result).exposure_seconds).toEqual(expect.arrayContaining([10, 30]));
		expect(textOf(result)).toContain("exposure changed");
	});

	it("explains an album of JPEGs with no frames to stack", async () => {
		const connected = await connect();

		const result = await connected.callTool({
			name: "astro_inspect",
			arguments: { session: "jpeg-only" },
		});

		expect(structuredOf(result)).toMatchObject({ frames: 0, image_files: 1 });
		expect(textOf(result)).toContain("Save each frame");
	});

	it("accepts a plain path as well as a session name", async () => {
		const connected = await connect();

		const result = await connected.callTool({
			name: "astro_inspect",
			arguments: { path: join(workDir, "M31", "raw") },
		});

		expect(structuredOf(result)).toMatchObject({ frames: 10 });
	});

	it("stops after the requested number of frames", async () => {
		const connected = await connect();

		const result = await connected.callTool({
			name: "astro_inspect",
			arguments: { session: "M31", limit: 3 },
		});

		expect(structuredOf(result)).toMatchObject({ frames: 3, integration_seconds: 30 });
	});

	it("asks for an argument instead of guessing", async () => {
		const connected = await connect();

		const result = await connected.callTool({ name: "astro_inspect", arguments: {} });

		expect(isError(result)).toBe(true);
		expect(textOf(result)).toContain("session_list");
	});
});

describe("astro_inspect on already-stacked masters", () => {
	it("does not add up the exposures of masters, and says what they are", async () => {
		// What PixInsight writes after integrating a Seestar session: EXPTIME is the exposure of one
		// sub-frame, and adding two of those together would claim a minute for hours of data.
		await writeFits(join(workDir, "masters", "process", "ircut.fit"), {
			cards: seestarLightCards({
				IMAGETYP: "Master Light",
				OBJECT: "Unknown",
				EXPTIME: 30,
				RA: 92.3057207825894,
				DEC: 15.7949383453664,
			}),
		});
		await writeFits(join(workDir, "masters", "process", "lp.fit"), {
			cards: seestarLightCards({ IMAGETYP: "Master Light", OBJECT: "Unknown", EXPTIME: 30 }),
		});

		const connected = await connect();
		const result = await connected.callTool({
			name: "astro_inspect",
			arguments: { session: "masters" },
		});

		expect(structuredOf(result)).toMatchObject({ frames: 2, masters: true });
		expect(structuredOf(result).integration_seconds).toBeUndefined();
		expect(textOf(result)).toContain("already integrated");
		expect(textOf(result)).toContain("30s per sub-frame");
		// "Unknown" is not a target name; the coordinates are what identifies the field.
		expect(textOf(result)).toContain("RA 06h 09m 13.4s");
		expect(textOf(result)).toContain("Dec +15° 47′ 42″");
	});
});
