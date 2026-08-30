import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Harness, isError, startHarness, structuredOf, textOf } from "./harness.js";

/**
 * Downloading frames off the telescope.
 *
 * The fake serves files over HTTP the way the real Seestar does, from its own address rather than
 * the driver's, so the URL assembly is exercised for real.
 */

let workDir: string;
let harness: Harness;

beforeAll(async () => {
	workDir = await mkdtemp(join(tmpdir(), "seestar-download-"));
});

afterAll(async () => {
	await rm(workDir, { recursive: true, force: true });
});

afterEach(async () => {
	await harness?.close();
});

async function connect(): Promise<void> {
	harness = await startHarness({ workDir });
	await harness.client.callTool({ name: "device_connect", arguments: {} });
}

describe("imaging_albums", () => {
	it("lists what the telescope has stored", async () => {
		await connect();

		const result = await harness.client.callTool({ name: "imaging_albums", arguments: {} });

		expect(isError(result)).toBe(false);
		expect(textOf(result)).toContain("M31");
		expect(textOf(result)).toContain("sub-frame");
		const albums = structuredOf(result).albums as Array<{ name: string; files: number }>;
		expect(albums[0]).toMatchObject({ name: "M31", files: 3 });
	});
});

describe("imaging_download", () => {
	it("lists what it would fetch without touching the disk", async () => {
		await connect();

		const result = await harness.client.callTool({
			name: "imaging_download",
			arguments: { dry_run: true },
		});

		expect(structuredOf(result)).toMatchObject({ session: "M31", planned: 3 });
		expect(textOf(result)).toContain("Would download 3 files");
		await expect(readdir(join(workDir, "M31", "raw"))).rejects.toThrow();
	});

	it("downloads the files into the session directory", async () => {
		await connect();

		const result = await harness.client.callTool({
			name: "imaging_download",
			arguments: { session_name: "M31-run" },
		});

		expect(isError(result)).toBe(false);
		expect(structuredOf(result)).toMatchObject({ downloaded: 3, failed: 0 });

		const files = await readdir(join(workDir, "M31-run", "raw"));
		expect(files).toHaveLength(3);
		// The full-size name, not the thumbnail the listing carries.
		expect(files).toContain("Light_M31_stacked.jpg");
		const contents = await readFile(
			join(workDir, "M31-run", "raw", "Light_M31_stacked.jpg"),
			"utf8",
		);
		expect(contents).toContain("FAKE-IMAGE:/MyWorks/M31/Light_M31_stacked.jpg");
	});

	it("skips what it already has, so it is safe to run again", async () => {
		await connect();
		await harness.client.callTool({
			name: "imaging_download",
			arguments: { session_name: "M31-again" },
		});

		const second = await harness.client.callTool({
			name: "imaging_download",
			arguments: { session_name: "M31-again" },
		});

		expect(structuredOf(second)).toMatchObject({ downloaded: 0, skipped: 3 });
		expect(textOf(second)).toContain("already there");
	});

	it("can leave the sub-frames behind", async () => {
		await connect();

		const result = await harness.client.callTool({
			name: "imaging_download",
			arguments: { session_name: "M31-stacked-only", include_subframes: false },
		});

		expect(structuredOf(result)).toMatchObject({ planned: 1, downloaded: 1 });
	});

	it("takes an album by name and refuses one that does not exist", async () => {
		await connect();

		const good = await harness.client.callTool({
			name: "imaging_download",
			arguments: { album: "M42", dry_run: true },
		});
		expect(structuredOf(good)).toMatchObject({ session: "M42" });

		const bad = await harness.client.callTool({
			name: "imaging_download",
			arguments: { album: "M13", dry_run: true },
		});
		expect(textOf(bad)).toContain("No album called");
		expect(textOf(bad)).toContain("M31, M42");
	});

	it("keeps a session name from escaping the working directory", async () => {
		await connect();

		const result = await harness.client.callTool({
			name: "imaging_download",
			arguments: { session_name: "../../etc/evil", dry_run: true },
		});

		expect(String(structuredOf(result).directory)).toContain(workDir);
		expect(String(structuredOf(result).directory)).not.toContain("..");
	});
});
