import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	execTool,
	findTool,
	findTools,
	invocation,
	isFound,
	sanitizeEnv,
} from "../../src/processing/binaries.js";
import { pathWith, writeFakeBinary } from "../fake/binaries.js";

let binDir: string;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
	binDir = await mkdtemp(join(tmpdir(), "seestar-bin-"));
	await writeFakeBinary(binDir, "siril-cli", { output: "siril 1.4.4" });
	// An empty PATH entry and a missing directory are both normal in the wild.
	env = { PATH: `${pathWith(binDir, {})}${process.platform === "win32" ? ";" : ":"}` };
});

afterAll(async () => {
	await rm(binDir, { recursive: true, force: true });
});

describe("findTool", () => {
	it("finds a program on PATH and reads its version", async () => {
		const tool = await findTool("siril", { env });

		expect(isFound(tool)).toBe(true);
		if (!isFound(tool)) return;
		expect(tool.source).toBe("path");
		expect(tool.version).toBe("siril 1.4.4");
		expect(tool.path).toContain("siril-cli");
	});

	it("prefers an explicit path from the environment", async () => {
		const custom = await writeFakeBinary(join(binDir, "custom"), "siril-cli", {
			output: "siril 1.5.0-beta",
		});

		const tool = await findTool("siril", { env: { ...env, SIRIL_PATH: custom } });

		expect(isFound(tool)).toBe(true);
		if (!isFound(tool)) return;
		expect(tool.source).toBe("env");
		expect(tool.version).toBe("siril 1.5.0-beta");
	});

	it("ignores an environment path that points at nothing", async () => {
		const tool = await findTool("siril", {
			env: { ...env, SIRIL_PATH: join(binDir, "does-not-exist") },
		});

		// Falls back to PATH rather than giving up.
		expect(isFound(tool)).toBe(true);
	});

	it("still reports a program that prints its version and exits non-zero", async () => {
		const directory = join(binDir, "grumpy");
		await writeFakeBinary(directory, "graxpert", { output: "GraXpert 3.1.0", exitCode: 2 });

		const tool = await findTool("graxpert", { env: { PATH: pathWith(directory, {}) } });

		expect(isFound(tool)).toBe(true);
		if (!isFound(tool)) return;
		expect(tool.version).toBe("GraXpert 3.1.0");
	});

	it("reports what it looked at when a program is missing", async () => {
		const tool = await findTool("graxpert", { env: { PATH: binDir } });

		expect(isFound(tool)).toBe(false);
		if (isFound(tool)) return;
		expect(tool.envVariable).toBe("GRAXPERT_PATH");
		expect(tool.searched.length).toBeGreaterThan(0);
		expect(tool.hint).toContain("GraXpert");
	});

	it("can skip running programs entirely", async () => {
		const tool = await findTool("siril", { env, skipVersions: true });

		expect(isFound(tool)).toBe(true);
		if (!isFound(tool)) return;
		expect(tool.version).toBeUndefined();
	});
});

describe("invocation", () => {
	it("runs a batch file through cmd.exe, because Node refuses to spawn one directly", () => {
		const call = invocation("C:\\Tools\\siril.cmd", ["--version"], "win32", {
			COMSPEC: "cmd.exe",
		});

		expect(call.command).toBe("cmd.exe");
		expect(call.args).toEqual(["/d", "/s", "/c", '"C:\\Tools\\siril.cmd --version"']);
		expect(call.windowsVerbatimArguments).toBe(true);
	});

	it("quotes a batch file whose path contains spaces", () => {
		const call = invocation("C:\\Program Files\\Siril\\siril.cmd", ["-s", "a b.ssf"], "win32", {
			COMSPEC: "cmd.exe",
		});

		expect(call.args.at(-1)).toBe('""C:\\Program Files\\Siril\\siril.cmd" -s "a b.ssf""');
	});

	it("leaves a real executable alone", () => {
		expect(invocation("C:\\Tools\\siril.exe", ["-v"], "win32")).toEqual({
			command: "C:\\Tools\\siril.exe",
			args: ["-v"],
		});
		expect(invocation("/usr/bin/siril-cli", ["-v"], "linux")).toEqual({
			command: "/usr/bin/siril-cli",
			args: ["-v"],
		});
	});
});

describe("execTool", () => {
	it("copes with an install path that contains spaces", async () => {
		// "C:\Program Files\..." is the normal case on Windows, and the usual place quoting breaks.
		const directory = join(binDir, "Program Files", "Siril");
		const executable = await writeFakeBinary(directory, "siril-cli", { output: "siril 1.4.4" });

		const { stdout } = await execTool(executable, ["--version"]);

		expect(stdout).toContain("siril 1.4.4");
	});
});

describe("sanitizeEnv", () => {
	it("drops the msys2 markers that break Siril's Python support on Windows", () => {
		const cleaned = sanitizeEnv(
			{
				PATH: "C:\\bin",
				MSYSTEM: "MINGW64",
				MSYS2_PATH_TYPE: "inherit",
				HOME: "C:\\Users\\me",
			},
			"win32",
		);

		expect(cleaned).toEqual({ PATH: "C:\\bin", HOME: "C:\\Users\\me" });
	});

	it("leaves the environment alone everywhere else", () => {
		const env = { PATH: "/usr/bin", MSYSTEM: "irrelevant here" };
		expect(sanitizeEnv(env, "linux")).toBe(env);
	});
});

describe("findTools", () => {
	it("splits the world into found and missing", async () => {
		const inventory = await findTools({ env, skipVersions: true });

		expect(inventory.found.map((tool) => tool.name)).toContain("siril");
		expect(inventory.missing.map((tool) => tool.name)).toContain("blurxterminator");
		expect(inventory.found.length + inventory.missing.length).toBe(6);
	});

	it("survives an environment with no PATH at all", async () => {
		const inventory = await findTools({ env: {}, skipVersions: true });

		expect(inventory.found).toEqual([]);
		expect(inventory.missing).toHaveLength(6);
	});
});
