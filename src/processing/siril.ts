import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { invocation, sanitizeEnv } from "./binaries.js";

/**
 * Driving Siril.
 *
 * Siril takes a script — a plain list of its own commands — and runs it headless. We generate that
 * script and feed it on standard input (`siril-cli -d <dir> -s -`), which keeps everything we
 * actually own in one testable place: the text of the script.
 *
 * The command syntax below was read from `help <command>` of Siril 1.4.4 rather than from memory.
 */

/** Siril's own rejection algorithms, by the letter its `stack` command expects. */
export const REJECTION_TYPES = {
	none: "n",
	percentile: "p",
	sigma: "s",
	median: "m",
	winsorized: "w",
	linear: "l",
	generalized: "g",
	mad: "a",
} as const;

export type RejectionType = keyof typeof REJECTION_TYPES;
export type Normalization = "addscale" | "add" | "mulscale" | "mul" | "none";

export interface StackScriptOptions {
	/** Where the frames are. Becomes Siril's working directory. */
	inputDir: string;
	/** Where converted and stacked files go. */
	outputDir: string;
	/** Base name of the sequence Siril builds. */
	sequenceName?: string;
	/** Align the frames before stacking. Off only for frames that are already aligned. */
	register?: boolean;
	rejection?: RejectionType;
	sigmaLow?: number;
	sigmaHigh?: number;
	normalization?: Normalization;
	/** Keep only the best N per cent of frames by FWHM. Requires registration. */
	bestPercent?: number;
	/** Master dark, flat and bias, when there are any. */
	dark?: string;
	flat?: string;
	bias?: string;
	/** Name of the stacked result, without extension. */
	output: string;
	/** Seestar frames are colour already; set for undebayered CFA data. */
	debayer?: boolean;
}

/**
 * Build the script for convert → (calibrate) → (register) → stack.
 *
 * The order and the option spellings follow Siril's own documentation: `convert` builds a sequence
 * from whatever is in the working directory, `calibrate`/`register` each write a new sequence with
 * a prefix, and `stack` consumes the last one.
 */
export function buildStackScript(options: StackScriptOptions): string[] {
	const sequence = options.sequenceName ?? "light";
	const script = [
		"requires 1.4.0",
		"setext fit",
		`cd ${quote(options.inputDir)}`,
		// -out= puts the sequence next to the results rather than among the originals.
		`convert ${sequence} -out=${quote(options.outputDir)}`,
		`cd ${quote(options.outputDir)}`,
	];

	let current = sequence;

	const calibration = [
		options.bias ? `-bias=${quote(options.bias)}` : "",
		options.dark ? `-dark=${quote(options.dark)}` : "",
		options.flat ? `-flat=${quote(options.flat)}` : "",
		options.debayer ? "-debayer" : "",
	].filter(Boolean);

	if (calibration.length > 0) {
		script.push(`calibrate ${current} ${calibration.join(" ")}`);
		current = `pp_${current}`;
	}

	if (options.register !== false) {
		script.push(`register ${current}`);
		current = `r_${current}`;
	}

	script.push(`stack ${current} ${stackArguments(options)}`);
	return script;
}

function stackArguments(options: StackScriptOptions): string[] | string {
	const rejection = options.rejection ?? "winsorized";
	const normalization = options.normalization ?? "addscale";

	const parts = ["rej", REJECTION_TYPES[rejection]];

	// Sigma bounds are required for every rejection type except none.
	if (rejection !== "none") {
		parts.push(String(options.sigmaLow ?? 3), String(options.sigmaHigh ?? 3));
	}

	parts.push(normalization === "none" ? "-nonorm" : `-norm=${normalization}`);

	// Filtering by FWHM needs registration data, so it only makes sense after registering.
	if (options.bestPercent !== undefined && options.register !== false) {
		parts.push(`-filter-fwhm=${options.bestPercent}%`);
	}

	parts.push(`-out=${quote(options.output)}`);
	return parts.join(" ");
}

export interface ExportScriptOptions {
	/** Directory holding the image. */
	inputDir: string;
	/** File to load, without extension if it is a FITS. */
	input: string;
	/** Output name, without extension. */
	output: string;
	format?: "png" | "jpg" | "tif";
	/** Apply Siril's auto-stretch before saving — linear data looks black otherwise. */
	stretch?: boolean;
	/** JPEG quality, 10-100. */
	quality?: number;
}

export function buildExportScript(options: ExportScriptOptions): string[] {
	const format = options.format ?? "png";
	const script = [
		"requires 1.4.0",
		"setext fit",
		`cd ${quote(options.inputDir)}`,
		`load ${quote(options.input)}`,
	];

	if (options.stretch !== false) script.push("autostretch");

	if (format === "jpg") {
		script.push(`savejpg ${quote(options.output)} ${options.quality ?? 90}`);
	} else if (format === "tif") {
		script.push(`savetif ${quote(options.output)}`);
	} else {
		script.push(`savepng ${quote(options.output)}`);
	}

	return script;
}

/** Siril accepts quoted arguments, which is how paths with spaces get through. */
export function quote(value: string): string {
	return /[\s"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

export function renderScript(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

export interface RunOptions {
	/** Working directory Siril starts in. */
	workDir: string;
	/** Where the full output is written. */
	logPath: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	/** Called with each line, for live progress. */
	onLine?: (line: string) => void;
}

export interface RunResult {
	success: boolean;
	exitCode: number | null;
	/** The last lines of output, for showing without opening the log. */
	tail: string[];
	/** The line Siril complained about, when it complained. */
	error?: string;
	logPath: string;
	durationMs: number;
}

const TAIL_LINES = 40;

/**
 * Run a script and wait for it.
 *
 * Siril exits non-zero when a script fails and prints "Error in line N (…)", so both are used: the
 * exit code decides, the error line explains. The whole output goes to a log file, because a
 * stacking run produces hundreds of lines that nobody wants in a chat transcript.
 */
export async function runSirilScript(
	sirilPath: string,
	script: string[],
	options: RunOptions,
): Promise<RunResult> {
	await mkdir(dirname(options.logPath), { recursive: true });

	const platform = options.platform ?? process.platform;
	const env = sanitizeEnv({ ...process.env, ...(options.env ?? {}) }, platform);
	const call = invocation(sirilPath, ["-d", options.workDir, "-s", "-"], platform, env);

	const started = Date.now();
	const log = createWriteStream(options.logPath, { flags: "a" });
	log.write(`$ ${sirilPath} -d ${options.workDir} -s -\n${renderScript(script)}\n`);

	const tail: string[] = [];
	let errorLine: string | undefined;
	let pending = "";

	const child = spawn(call.command, call.args, {
		env,
		windowsHide: true,
		...(call.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
	});

	const consume = (chunk: Buffer): void => {
		const text = pending + chunk.toString("utf8");
		const lines = text.split(/\r?\n/);
		pending = lines.pop() ?? "";

		for (const line of lines) {
			log.write(`${line}\n`);
			// Siril prefixes everything with "log: "; strip it so the tail reads like prose.
			const clean = line.replace(/^log:\s?/, "").replace(/<[^>]*>/g, "");
			if (clean.trim() === "") continue;
			if (/^Error in line \d+/i.test(clean) || /^Error:/i.test(clean)) errorLine ??= clean;

			tail.push(clean);
			if (tail.length > TAIL_LINES) tail.shift();
			options.onLine?.(clean);
		}
	};

	child.stdout?.on("data", consume);
	child.stderr?.on("data", consume);
	child.stdin?.end(renderScript(script));

	const timeout = options.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : undefined;
	const onAbort = (): void => {
		child.kill();
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });

	const exitCode = await new Promise<number | null>((resolve) => {
		child.on("error", (error) => {
			consume(Buffer.from(`Error: could not start Siril: ${error.message}\n`));
			resolve(null);
		});
		child.on("close", (code) => resolve(code));
	});

	if (timeout) clearTimeout(timeout);
	options.signal?.removeEventListener("abort", onAbort);
	if (pending) consume(Buffer.from("\n"));
	await new Promise<void>((resolve) => log.end(resolve));

	return {
		success: exitCode === 0 && errorLine === undefined,
		exitCode,
		tail: [...tail],
		...(errorLine ? { error: errorLine } : {}),
		logPath: options.logPath,
		durationMs: Date.now() - started,
	};
}
