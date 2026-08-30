import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadProcessingConfig } from "../../src/processing/config.js";
import { writeFakeBinary } from "../fake/binaries.js";
import { connectProcessingClient, isError, structuredOf, textOf } from "../mcp-client.js";

/**
 * The processing server, driven by a real MCP client.
 *
 * Siril is not installed here: a fake executable stands in, which is exactly the point — the tools
 * must be developable and testable on a machine with none of the astronomy software on it.
 */

let workDir: string;
let binDir: string;
let sirilPath: string;
let client: Client | undefined;

beforeAll(async () => {
	workDir = await mkdtemp(join(tmpdir(), "astro-work-"));
	binDir = await mkdtemp(join(tmpdir(), "astro-bin-"));
	sirilPath = await writeFakeBinary(binDir, "siril-cli", { output: "siril 1.4.4" });
});

afterAll(async () => {
	await rm(workDir, { recursive: true, force: true });
	await rm(binDir, { recursive: true, force: true });
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

describe("the processing server", () => {
	it("offers the processing tools and none of the telescope ones", async () => {
		const connected = await connect({ sirilPath });

		const names = (await connected.listTools()).tools.map((tool) => tool.name);

		expect(names).toContain("astro_tools");
		expect(names).not.toContain("telescope_status");
		expect(names).not.toContain("seestar_state");
	});
});

describe("astro_tools", () => {
	it("reports the programs it found, with versions", async () => {
		const connected = await connect({ sirilPath });

		const result = await connected.callTool({ name: "astro_tools", arguments: {} });

		expect(isError(result)).toBe(false);
		expect(structuredOf(result)).toMatchObject({ ready: true, work_dir: workDir });
		expect(textOf(result)).toContain("siril 1.4.4");
		expect(textOf(result)).toContain("Siril is available");
	});

	it("says what is missing and how to point at it", async () => {
		const connected = await connect({ sirilPath });

		const result = await connected.callTool({ name: "astro_tools", arguments: {} });

		expect(textOf(result)).toContain("GraXpert — not found");
		expect(textOf(result)).toContain("GRAXPERT_PATH");
		const missing = structuredOf(result).missing as Array<{ name: string }>;
		expect(missing.map((tool) => tool.name)).toContain("graxpert");
	});

	it("is explicit that nothing works without Siril", async () => {
		const connected = await connect({ sirilPath: join(binDir, "nothing-here") });

		const result = await connected.callTool({ name: "astro_tools", arguments: {} });

		// The fake binary directory is not on PATH, so nothing is found at all.
		expect(structuredOf(result)).toMatchObject({ ready: false });
		expect(textOf(result)).toContain("siril.org/download");
	});

	it("can skip running the programs when only paths are wanted", async () => {
		const connected = await connect({ sirilPath });

		const result = await connected.callTool({
			name: "astro_tools",
			arguments: { check_versions: false },
		});

		const found = structuredOf(result).found as Array<{ version?: string }>;
		expect(found[0]?.version).toBeUndefined();
	});
});

describe("loadProcessingConfig", () => {
	it("defaults the working directory and takes it from the environment", () => {
		const config = loadProcessingConfig([], { ASTRO_WORK_DIR: workDir });
		expect(config.workDir).toBe(workDir);

		const fallback = loadProcessingConfig([], {});
		expect(fallback.workDir).toMatch(/astro$/);
	});

	it("lets flags win over the environment", () => {
		const config = loadProcessingConfig(["--work-dir", workDir, "--siril", "/opt/siril"], {
			ASTRO_WORK_DIR: "/somewhere/else",
			SIRIL_PATH: "/usr/bin/siril-cli",
		});

		expect(config.workDir).toBe(workDir);
		expect(config.sirilPath).toBe("/opt/siril");
	});

	it("refuses an unknown option instead of ignoring it", () => {
		expect(() => loadProcessingConfig(["--wat"], {})).toThrow(/unknown option --wat/);
	});

	it("refuses a timeout that is not a number", () => {
		expect(() => loadProcessingConfig(["--timeout", "soon"], {})).toThrow(/number/);
	});
});
