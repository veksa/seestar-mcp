import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Stand-in executables for the external programs.
 *
 * The processing code must be developed and tested without Siril or GraXpert installed, so the
 * tests put small scripts on a temporary PATH instead. They are real executables — a `.cmd` on
 * Windows, a `/bin/sh` script elsewhere — so discovery and version detection run for real.
 */

export interface FakeBinaryOptions {
	/** What the program prints. */
	output?: string;
	/** Exit code; some real programs print their version and still exit non-zero. */
	exitCode?: number;
	/** Record every invocation into this file, one JSON line per call. */
	logPath?: string;
}

/** Write a fake executable into `directory` and return its full path. */
export async function writeFakeBinary(
	directory: string,
	name: string,
	options: FakeBinaryOptions = {},
): Promise<string> {
	await mkdir(directory, { recursive: true });
	const output = options.output ?? `${name} 1.0.0`;
	const exitCode = options.exitCode ?? 0;

	if (process.platform === "win32") {
		const path = join(directory, `${name}.cmd`);
		const log = options.logPath ? `>>"${options.logPath}" echo %*\r\n` : "";
		await writeFile(path, `@echo off\r\n${log}echo ${output}\r\nexit /b ${exitCode}\r\n`, "latin1");
		return path;
	}

	const path = join(directory, name);
	const log = options.logPath ? `printf '%s\\n' "$*" >> "${options.logPath}"\n` : "";
	await writeFile(path, `#!/bin/sh\n${log}echo "${output}"\nexit ${exitCode}\n`, "utf8");
	await chmod(path, 0o755);
	return path;
}

/** A PATH value with `directory` in front of everything else. */
export function pathWith(directory: string, env: NodeJS.ProcessEnv = process.env): string {
	const separator = process.platform === "win32" ? ";" : ":";
	return `${directory}${separator}${env.PATH ?? ""}`;
}
