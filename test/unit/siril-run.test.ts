import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSirilScript } from "../../src/processing/siril.js";

/**
 * Reading Siril's output.
 *
 * Deciding whether a run failed is not as simple as looking for the word "error": several Siril
 * commands print one for a condition they then recover from, and a script that reached its last
 * line and saved a picture has not failed. These tests stand in a fake Siril that prints canned
 * output, so the transcripts here are the ones a real run produced.
 */

let workDir: string;

/** A script that plays back fixed lines and exits with a chosen code, standing in for siril-cli. */
async function fakeSiril(lines: string[], exitCode = 0): Promise<string> {
	const path = join(workDir, `fake-${Math.random().toString(36).slice(2)}.js`);
	const source = [
		"process.stdin.resume();",
		"process.stdin.on('end', () => {",
		`  for (const line of ${JSON.stringify(lines)}) console.log(line);`,
		`  process.exit(${exitCode});`,
		"});",
	].join("\n");

	await writeFile(path, source);
	await chmod(path, 0o755).catch(() => undefined);
	return path;
}

/** Node runs the fake, so the "executable" is node itself with the script as its first argument. */
async function run(lines: string[], exitCode = 0) {
	const script = await fakeSiril(lines, exitCode);
	const logPath = join(workDir, `run-${Math.random().toString(36).slice(2)}.log`);

	// runSirilScript spawns the path it is given, and Node needs its script as an argument — which
	// that path cannot carry. A one-line shim supplies it: a .cmd on Windows, where `invocation`
	// routes it through cmd.exe, and an executable shell script everywhere else.
	const windows = process.platform === "win32";
	const shim = join(workDir, `shim-${Math.random().toString(36).slice(2)}${windows ? ".cmd" : ""}`);

	if (windows) {
		await writeFile(shim, `@"${process.execPath}" "${script}"\r\n`);
	} else {
		await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`);
		await chmod(shim, 0o755);
	}

	return runSirilScript(shim, ["requires 1.4.0"], { workDir, logPath });
}

beforeAll(async () => {
	workDir = await mkdtemp(join(tmpdir(), "siril-run-"));
});

afterAll(async () => {
	await rm(workDir, { recursive: true, force: true });
});

describe("runSirilScript", () => {
	it("believes Siril when it says the script finished", async () => {
		// `denoise` and `rmgreen` both print this and then carry on to save the image. Treating it
		// as fatal reported a failed job for a run that had produced a perfectly good picture.
		const result = await run([
			"log: Running command: denoise",
			"error: no suitable data in src fits",
			"log: Saving JPG: file m27_v1.jpg, quality=95%",
			"log: Script execution finished successfully.",
		]);

		expect(result.success).toBe(true);
		expect(result.error).toBeUndefined();
	});

	it("fails on the line Siril actually abandoned the script at", async () => {
		const result = await run(
			[
				"log: Running command: pcc",
				"log: Error in line 7 ('pcc'): no star catalogue",
				"log: Script execution failed.",
			],
			1,
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain("Error in line 7");
	});

	it("still reports a complaint when the script never said it finished", async () => {
		// No closing verdict — a crash, or a kill. Then the complaint is the best evidence there is.
		const result = await run(["log: Running command: load", "error: file not found"], 1);

		expect(result.success).toBe(false);
		expect(result.error).toContain("file not found");
	});

	it("fails on a non-zero exit even when the output looked fine", async () => {
		const result = await run(["log: Script execution finished successfully."], 3);

		expect(result.success).toBe(false);
		expect(result.exitCode).toBe(3);
	});

	it("writes the whole transcript to the log, prefixes and all", async () => {
		const result = await run([
			"log: Running command: stack",
			"log: Script execution finished successfully.",
		]);

		const log = await readFile(result.logPath, "utf8");
		expect(log).toContain("log: Running command: stack");
		// The tail is what a person reads, so the "log: " prefix is stripped there.
		expect(result.tail).toContain("Running command: stack");
	});
});
