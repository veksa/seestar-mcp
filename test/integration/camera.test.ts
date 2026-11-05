import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFitsHeader } from "../../src/processing/fits.js";
import type { FakeCameraOptions } from "../fake/alpaca-server.js";
import { type Harness, isError, startHarness, structuredOf, textOf } from "./harness.js";

let harness: Harness;
let workDir: string;

beforeEach(async () => {
	workDir = await mkdtemp(join(tmpdir(), "seestar-camera-"));
});

afterEach(async () => {
	await harness?.close();
	await rm(workDir, { recursive: true, force: true });
});

/** The built-in server with its camera, as on a Seestar S50 Pro. */
async function start(
	options: { astap?: string; camera?: FakeCameraOptions; readOnly?: boolean } = {},
): Promise<void> {
	harness = await startHarness(
		{
			deviceNumber: 0,
			captureDir: join(workDir, "captures"),
			...(options.astap ? { astapPath: options.astap } : {}),
			...(options.readOnly ? { readOnly: true } : {}),
		},
		{
			builtin: true,
			deviceTypes: ["telescope", "camera"],
			deviceNumbers: [0, 1],
			camera: { width: 64, height: 32, ...options.camera },
		},
	);
}

/**
 * A stand-in for astap_cli that "solves" every frame to the given J2000 position, by writing the
 * `.ini` the real one writes next to its input. It also records its arguments.
 */
async function fakeAstap(raHours: number, dec: number): Promise<string> {
	const path = join(workDir, "astap_cli");
	const log = join(workDir, "astap.log");
	const ini = [
		"PLTSOLVD=T",
		`CRVAL1=${raHours * 15}`,
		`CRVAL2=${dec}`,
		"CD1_1=-5.57E-004",
		"CD1_2=1.115E-003",
		"CD2_1=-1.115E-003",
		"CD2_2=-5.57E-004",
	].join("\\n");
	await writeFile(
		path,
		[
			"#!/bin/sh",
			`printf '%s\\n' "$*" >> "${log}"`,
			'while [ $# -gt 0 ]; do if [ "$1" = "-f" ]; then f="$2"; fi; shift; done',
			`printf '${ini}\\n' > "\${f%.fits}.ini"`,
		].join("\n"),
	);
	await chmod(path, 0o755);
	return path;
}

async function filesUnder(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { recursive: true, withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name));
}

describe("camera_capture", () => {
	it("takes a frame, saves it as FITS and returns a preview", async () => {
		await start({ camera: { pixel: (x, y) => 1000 + x + 100 * y } });

		const result = await harness.client.callTool({
			name: "camera_capture",
			arguments: { exposure_s: 2, gain: 80, name: "M45" },
		});

		expect(isError(result)).toBe(false);
		const structured = structuredOf(result);
		const path = structured.path as string;
		expect(path).toMatch(/M45[/\\]M45_2s_g80_\d{6}\.fits$/);
		expect(structured.bayer_pattern).toBe("GRBG");
		expect(structured.width).toBe(64);

		const header = await readFitsHeader(path);
		expect(header.cards.get("NAXIS1")).toBe(64);
		expect(header.cards.get("NAXIS2")).toBe(32);
		expect(header.cards.get("EXPTIME")).toBe(2);
		expect(header.cards.get("GAIN")).toBe(80);
		expect(header.cards.get("BAYERPAT")).toBe("GRBG");
		expect(header.cards.get("OBJECT")).toBe("M45");

		const content = (result as { content: Array<{ type: string; mimeType?: string }> }).content;
		expect(content.some((block) => block.type === "image" && block.mimeType === "image/png")).toBe(
			true,
		);
	});

	it("leaves the camera as it found it: gain restored, disconnected again", async () => {
		await start({ camera: { gain: 0 } });

		await harness.client.callTool({
			name: "camera_capture",
			arguments: { exposure_s: 1, gain: 120 },
		});

		const camera = harness.fake.cameras.get(0);
		expect(camera?.exposures).toEqual([{ duration: 1, light: true }]);
		expect(camera?.gain).toBe(0);
		const connects = harness.fake.requests.filter(
			(request) => request.path === "/api/v1/camera/0/connected" && request.method === "PUT",
		);
		expect(connects.map((request) => request.params.Connected)).toEqual(["True", "False"]);
	});

	it("uses the wide-angle camera when asked", async () => {
		await start();
		await harness.client.callTool({
			name: "camera_capture",
			arguments: { exposure_s: 1, camera: 1 },
		});
		expect(harness.fake.cameras.get(1)?.exposures).toHaveLength(1);
		expect(harness.fake.cameras.get(0)).toBeUndefined();
	});

	it("falls back to JSON when the server does not send ImageBytes", async () => {
		await start({ camera: { jsonOnly: true, pixel: (x) => x } });
		const result = await harness.client.callTool({
			name: "camera_capture",
			arguments: { exposure_s: 1, preview: false },
		});
		expect(isError(result)).toBe(false);
		expect((structuredOf(result).stats as { max: number }).max).toBe(63);
	});

	it("plate-solves the frame when asked", async () => {
		await start({ astap: await fakeAstap(3.79, 24.12) });
		const result = await harness.client.callTool({
			name: "camera_capture",
			arguments: { exposure_s: 1, solve: true, preview: false },
		});
		expect(isError(result)).toBe(false);
		const solution = structuredOf(result).solution as { ra_hours: number; dec_degrees: number };
		expect(solution.ra_hours).toBeCloseTo(3.79, 6);
		expect(solution.dec_degrees).toBeCloseTo(24.12, 6);
		expect(textOf(result)).toMatch(/Solved: RA/);
	});

	it("is not offered in read-only mode", async () => {
		await start({ readOnly: true });
		const { tools } = await harness.client.listTools();
		const names = tools.map((tool) => tool.name);
		expect(names).not.toContain("camera_capture");
		expect(names).not.toContain("telescope_center");
	});
});

describe("telescope_center", () => {
	it("slews, solves, and stops once the target is in the middle", async () => {
		await start({ astap: await fakeAstap(3.79, 24.12) });
		harness.fake.sim.unpark();

		const result = await harness.client.callTool({
			name: "telescope_center",
			arguments: { ra: 3.79, dec: 24.12, name: "M45", exposure_s: 1 },
		});

		expect(isError(result)).toBe(false);
		const structured = structuredOf(result);
		expect(structured.centered).toBe(true);
		expect(structured.attempts as unknown[]).toHaveLength(1);
		expect(textOf(result)).toMatch(/M45 is centred/);

		// The mount works in the equinox of date, so the slew went out precessed from J2000.
		const slew = harness.fake.requests.find((request) =>
			request.path.endsWith("/telescope/0/slewtocoordinatesasync"),
		);
		expect(Number(slew?.params.RightAscension)).toBeGreaterThan(3.8);

		const frames = await filesUnder(join(workDir, "captures"));
		expect(
			frames.some((file) => /[/\\]M45[/\\]center[/\\]M45_1s_g80_\d{6}\.fits$/.test(file)),
		).toBe(true);
	}, 15_000);

	it("syncs and tries again when the solved position is off", async () => {
		// The solver keeps reporting a point 1° south of the target, as a mount that will not take
		// the correction would produce: the loop must sync, retry, and then say it gave up.
		await start({ astap: await fakeAstap(3.79, 23.12) });
		harness.fake.sim.unpark();

		const result = await harness.client.callTool({
			name: "telescope_center",
			arguments: { ra: 3.79, dec: 24.12, exposure_s: 1, max_attempts: 2 },
		});

		const structured = structuredOf(result);
		expect(structured.centered).toBe(false);
		expect(structured.attempts as unknown[]).toHaveLength(2);
		const syncs = harness.fake.requests.filter((request) =>
			request.path.endsWith("/telescope/0/synctocoordinates"),
		);
		expect(syncs).toHaveLength(1);
		expect(textOf(result)).toMatch(/not centred yet/);
	}, 20_000);

	it("says how to get ASTAP when it is missing", async () => {
		await start({ astap: join(workDir, "nowhere", "astap_cli") });
		const result = await harness.client.callTool({
			name: "telescope_center",
			arguments: { ra: 3.79, dec: 24.12 },
		});
		expect(isError(result)).toBe(true);
		expect(textOf(result)).toMatch(/ASTAP plate solver was not found/);
		// Nothing moved.
		expect(
			harness.fake.requests.some((request) => request.path.endsWith("slewtocoordinatesasync")),
		).toBe(false);
	});
});
