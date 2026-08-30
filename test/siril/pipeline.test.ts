import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadProcessingConfig } from "../../src/processing/config.js";
import { readFrameInfo } from "../../src/processing/fits.js";
import { seestarLightCards, writeStarfieldFits } from "../fake/fits.js";
import { connectProcessingClient, isError, structuredOf, textOf } from "../mcp-client.js";

/**
 * The pipeline against a real Siril.
 *
 * Everything else is tested against fakes; this is the suite that proves the generated scripts are
 * ones Siril actually accepts. Frames are synthetic star fields, each shifted a little, so
 * registration has something real to solve. Run with `yarn test:siril`.
 */

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function findSiril(): string | undefined {
	if (process.env.SIRIL_PATH && existsSync(process.env.SIRIL_PATH)) return process.env.SIRIL_PATH;

	const manifest = join(projectRoot, ".cache", "siril", "current.json");
	if (!existsSync(manifest)) return undefined;

	try {
		const { executable } = JSON.parse(readFileSync(manifest, "utf8")) as { executable: string };
		return existsSync(executable) ? executable : undefined;
	} catch {
		return undefined;
	}
}

const sirilPath = findSiril();
if (!sirilPath) {
	console.warn("Siril not found — run `yarn siril:fetch` (or set SIRIL_PATH) to run these tests.");
}

let workDir: string;
let client: Client;

beforeAll(async () => {
	if (!sirilPath) return;

	workDir = await mkdtemp(join(tmpdir(), "siril-pipeline-"));

	// Eight frames of the same field, each nudged by a pixel or two.
	for (let index = 1; index <= 8; index++) {
		await writeStarfieldFits(
			join(workDir, "M31", "raw", `light_${String(index).padStart(3, "0")}.fit`),
			{
				width: 320,
				height: 320,
				offsetX: index % 3,
				offsetY: (index % 2) * 2,
				seed: index,
				// Synthetic frames are grey, not a mosaic; the CFA path is covered on its own below.
				cards: seestarLightCards({ BAYERPAT: undefined }),
			},
		);
	}

	// The same field again, but labelled the way a Seestar labels a sub-frame: one plane carrying a
	// Bayer mosaic. Stacking these has to produce three channels, not one.
	for (let index = 1; index <= 8; index++) {
		await writeStarfieldFits(
			join(workDir, "M16", "raw", `light_${String(index).padStart(3, "0")}.fit`),
			{
				width: 320,
				height: 320,
				offsetX: index % 3,
				offsetY: (index % 2) * 2,
				seed: index,
				cards: seestarLightCards({ OBJECT: "M 16" }),
			},
		);
	}

	client = await connectProcessingClient({
		...loadProcessingConfig([], { ASTRO_WORK_DIR: workDir }),
		sirilPath,
		timeoutMs: 300_000,
	});
}, 120_000);

afterAll(async () => {
	await client?.close();
	if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe.skipIf(!sirilPath)("astro_tools against the real Siril", () => {
	it("finds it and reads its version", async () => {
		const result = await client.callTool({ name: "astro_tools", arguments: {} });

		expect(structuredOf(result)).toMatchObject({ ready: true });
		expect(textOf(result)).toMatch(/siril 1\.\d/i);
	});
});

describe.skipIf(!sirilPath)("astro_stack", () => {
	it("aligns and stacks the frames into a FITS file", async () => {
		const result = await client.callTool({
			name: "astro_stack",
			arguments: { session: "M31", wait: true, timeout_s: 300 },
		});

		expect(isError(result)).toBe(false);
		const output = (structuredOf(result).result as { output?: string })?.output;
		expect(output).toBeTruthy();

		const info = await stat(output as string);
		expect(info.size).toBeGreaterThan(1000);
	}, 300_000);

	it("reports a Siril error instead of pretending it worked", async () => {
		const result = await client.callTool({
			name: "astro_run_script",
			arguments: { session: "M31", commands: ["nosuchcommand"], wait: true, timeout_s: 60 },
		});

		expect(isError(result)).toBe(true);
		expect(textOf(result)).toMatch(/unknown command|Error in line/i);
	}, 120_000);
});

describe.skipIf(!sirilPath)("one-shot-colour frames", () => {
	it("demosaics them, so the stack comes out in colour rather than as a grey mosaic", async () => {
		const result = await client.callTool({
			name: "astro_stack",
			arguments: { session: "M16", wait: true, timeout_s: 300 },
		});

		expect(isError(result)).toBe(false);

		// Nobody asked for it: the BAYERPAT card in the frames is what turned it on.
		expect(textOf(result)).toContain("-debayer");

		const output = (structuredOf(result).result as { output?: string })?.output;
		expect((await readFrameInfo(output as string)).channels).toBe(3);
	}, 300_000);
});

describe.skipIf(!sirilPath)("astro_export", () => {
	it("writes a PNG a person can actually look at", async () => {
		const result = await client.callTool({
			name: "astro_export",
			arguments: { session: "M31", output: "m31", format: "png", wait: true },
		});

		expect(isError(result)).toBe(false);
		const output = (structuredOf(result).result as { output?: string })?.output;
		// result/, not process/: the picture is what a person came for.
		expect(output).toBe(join(workDir, "M31", "result", "m31.png"));

		const info = await stat(output as string);
		expect(info.size).toBeGreaterThan(1000);

		// A real PNG, not an empty file with the right name.
		const header = readFileSync(output as string).subarray(0, 8);
		expect([...header]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	}, 180_000);
});

describe.skipIf(!sirilPath)("astro_job", () => {
	it("lists the jobs that have run, with their logs", async () => {
		const result = await client.callTool({ name: "astro_job", arguments: {} });

		const jobs = structuredOf(result).jobs as Array<{ status: string; log_path: string }>;
		expect(jobs.length).toBeGreaterThan(0);
		expect(jobs.some((job) => job.status === "done")).toBe(true);
		expect(existsSync(jobs[0]?.log_path as string)).toBe(true);
	});
});

describe.skipIf(!sirilPath)("processing steps", () => {
	it("removes the background gradient with Siril's own model", async () => {
		const result = await client.callTool({
			name: "astro_background_extract",
			arguments: { session: "M31", wait: true, timeout_s: 120 },
		});

		expect(isError(result)).toBe(false);
		const output = (structuredOf(result).result as { output?: string })?.output;
		expect(await stat(output as string)).toBeTruthy();
	}, 180_000);

	it("stretches the stacked image", async () => {
		const result = await client.callTool({
			name: "astro_stretch",
			arguments: { session: "M31", method: "asinh", amount: 50, wait: true, timeout_s: 120 },
		});

		expect(isError(result)).toBe(false);
		expect(textOf(result)).toContain("asinh 50");
	}, 180_000);

	it("says plainly when a step needs a program that is not installed", async () => {
		// StarNet is external and almost certainly absent; the failure must reach the caller.
		const result = await client.callTool({
			name: "astro_remove_stars",
			arguments: { session: "M31", wait: true, timeout_s: 60 },
		});

		expect(isError(result)).toBe(true);
		expect(textOf(result)).toMatch(/starnet|not installed|Error/i);
	}, 120_000);
});

describe.skipIf(!sirilPath)("process_session", () => {
	it("takes a session from frames to a finished PNG in one call", async () => {
		const result = await client.callTool({
			name: "process_session",
			arguments: {
				session: "M31",
				// Colour calibration needs a plate solve against a star catalog, which synthetic
				// frames cannot satisfy — the quick preset is the one that runs offline.
				preset: "quick",
				output: "m31-quick.png",
				wait: true,
				timeout_s: 600,
			},
		});

		expect(isError(result)).toBe(false);
		const image = (structuredOf(result).result as { image?: string })?.image;
		expect(image).toBe(join(workDir, "M31", "result", "m31-quick.png"));

		const header = readFileSync(image as string).subarray(0, 8);
		expect([...header]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	}, 600_000);

	it("reports what it is about to run, so the steps are visible", async () => {
		const result = await client.callTool({
			name: "process_session",
			arguments: { session: "M31", preset: "standard", wait: false },
		});

		expect(textOf(result)).toContain("subsky -rbf");
		expect(textOf(result)).toContain("-filter-fwhm=90%");
		expect(textOf(result)).toContain("astro_job");
	}, 60_000);
});
