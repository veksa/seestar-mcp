import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
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
	/**
	 * Demosaic the frames.
	 *
	 * Seestar sub-frames are raw one-shot-colour: one plane carrying a Bayer mosaic. Stacked
	 * without this they give a grey image with the mosaic in it, and registration hunts for stars
	 * in a checkerboard. The tools detect it from BAYERPAT rather than making the caller know.
	 */
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

	const masters = [
		options.bias ? `-bias=${quote(options.bias)}` : "",
		options.dark ? `-dark=${quote(options.dark)}` : "",
		options.flat ? `-flat=${quote(options.flat)}` : "",
	].filter(Boolean);

	// Demosaicing has to come after the masters are subtracted, because a master is itself a
	// mosaic: subtracting one from interpolated pixels smears the calibration across neighbours.
	// With masters it therefore belongs to `calibrate`; without them there is nothing to wait for
	// and `convert` does it in the pass it is already making.
	const debayerDuringConvert = options.debayer === true && masters.length === 0;

	const script = [
		"requires 1.4.0",
		"setext fit",
		`cd ${quote(options.inputDir)}`,
		// -out= puts the sequence next to the results rather than among the originals.
		`convert ${sequence} -out=${quote(options.outputDir)}${debayerDuringConvert ? " -debayer" : ""}`,
		`cd ${quote(options.outputDir)}`,
	];

	let current = sequence;

	if (masters.length > 0) {
		const calibration = [...masters, ...(options.debayer ? ["-debayer"] : [])];
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
	/** Where the image goes, when that is not the directory it was loaded from. */
	outputDir?: string;
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

	script.push(
		...saveImageCommands(imageTarget(options.output, options.outputDir), format, options.quality),
	);

	return script;
}

/**
 * Where Siril should write the picture.
 *
 * Siril's save commands take a path, not just a name, so sending the result to a sibling directory
 * is a matter of naming it — no second script and no moving the file afterwards.
 */
function imageTarget(name: string, directory: string | undefined): string {
	return directory ? join(directory, name) : name;
}

/** `savepng` / `savejpg` / `savetif`, picked by format. Verified against their help text. */
function saveImageCommands(
	target: string,
	format: "png" | "jpg" | "tif",
	quality?: number,
): string[] {
	if (format === "jpg") return [`savejpg ${quote(target)} ${quality ?? 90}`];
	if (format === "tif") return [`savetif ${quote(target)}`];
	return [`savepng ${quote(target)}`];
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

export interface OperationScriptOptions {
	/** Directory the image lives in; also where the result is written. */
	directory: string;
	/** File to load, without extension for FITS. */
	input: string;
	/** Where to save the result, without extension. Omit to leave the image loaded only. */
	output?: string;
	/** The commands that do the actual work, between load and save. */
	commands: string[];
}

/**
 * load → work → save, the shape every single-image step takes.
 *
 * Siril's processing commands all act on "the currently loaded image", so each step is the same
 * three-part script with different middle. Keeping that in one place means a new step is a list of
 * command strings and nothing else.
 */
export function buildOperationScript(options: OperationScriptOptions): string[] {
	const script = [
		"requires 1.4.0",
		"setext fit",
		`cd ${quote(options.directory)}`,
		`load ${quote(options.input)}`,
		...options.commands,
	];

	if (options.output) script.push(`save ${quote(options.output)}`);
	return script;
}

/** Background extraction with Siril's own model. Verified against `help subsky`. */
export function backgroundCommands(options: {
	degree?: number;
	samples?: number;
	tolerance?: number;
	smooth?: number;
	dither?: boolean;
}): string[] {
	// -rbf is the radial basis function model; a degree instead selects the polynomial one.
	const parts = ["subsky", options.degree === undefined ? "-rbf" : String(options.degree)];

	if (options.dither) parts.push("-dither");
	if (options.samples !== undefined) parts.push(`-samples=${options.samples}`);
	if (options.tolerance !== undefined) parts.push(`-tolerance=${options.tolerance}`);
	if (options.smooth !== undefined) parts.push(`-smooth=${options.smooth}`);

	return [parts.join(" ")];
}

/** Siril's non-local Bayes denoise. Verified against `help denoise`. */
export function denoiseCommands(options: { modulation?: number; noCosmetic?: boolean }): string[] {
	const parts = ["denoise"];
	if (options.noCosmetic) parts.push("-nocosmetic");
	if (options.modulation !== undefined) parts.push(`-mod=${options.modulation}`);
	return [parts.join(" ")];
}

/**
 * GraXpert, run as the Python script that ships with Siril.
 *
 * Inference happens inside Siril rather than in the GraXpert CLI; the GraXpert program itself is
 * only needed for downloading models, and its path is set in Siril's preferences. The script has to
 * be installed first through Siril's script repository.
 */
export function graxpertCommands(
	operation: "background" | "denoise" | "deconvolve-object" | "deconvolve-stars",
	options: { model?: string; extraArgs?: string[] } = {},
): string[] {
	const flags: Record<typeof operation, string> = {
		background: "-bge",
		denoise: "-denoise",
		"deconvolve-object": "-deconv_obj",
		"deconvolve-stars": "-deconv_stellar",
	};

	const parts = ["pyscript", "GraXpert-AI.py", flags[operation]];
	if (options.model) parts.push(`-model='${options.model}'`);
	parts.push(...(options.extraArgs ?? []));

	return [parts.join(" ")];
}

/** Richardson-Lucy deconvolution, with a PSF measured from the stars. Verified against `help rl`. */
export function deconvolveCommands(options: {
	psf?: "stars" | "blind";
	iterations?: number;
	alpha?: number;
}): string[] {
	const rl = ["rl"];
	if (options.iterations !== undefined) rl.push(`-iters=${options.iterations}`);
	if (options.alpha !== undefined) rl.push(`-alpha=${options.alpha}`);

	return [`makepsf ${options.psf ?? "stars"}`, rl.join(" ")];
}

/**
 * Colour calibration.
 *
 * Both variants need a plate-solved image, so solving comes first unless the caller says the image
 * already carries a solution.
 */
export function colorCalibrationCommands(options: {
	method?: "pcc" | "spcc";
	platesolve?: boolean;
	limitMagnitude?: number;
	catalog?: string;
}): string[] {
	const commands: string[] = [];
	if (options.platesolve !== false) commands.push("platesolve");

	const parts: string[] = [options.method ?? "pcc"];
	if (options.limitMagnitude !== undefined) parts.push(`-limitmag=${options.limitMagnitude}`);
	if (options.catalog) parts.push(`-catalog=${options.catalog}`);

	commands.push(parts.join(" "));
	return commands;
}

/** The three stretches Siril offers, each verified against its own help text. */
export function stretchCommands(options: {
	method?: "auto" | "asinh" | "ghs";
	amount?: number;
	shadowsClip?: number;
	linked?: boolean;
}): string[] {
	const method = options.method ?? "auto";

	if (method === "asinh") {
		// The stretch factor is mandatory; 100 is a reasonable middle for deep-sky data.
		return [`asinh ${options.amount ?? 100}`];
	}

	if (method === "ghs") {
		const parts = ["autoghs"];
		if (options.linked) parts.push("-linked");
		parts.push(String(options.shadowsClip ?? 0), String(options.amount ?? 10));
		return [parts.join(" ")];
	}

	const parts = ["autostretch"];
	if (options.linked) parts.push("-linked");
	if (options.shadowsClip !== undefined) parts.push(String(options.shadowsClip));
	return [parts.join(" ")];
}

/** Star removal through StarNet, which Siril calls out to. Verified against `help starnet`. */
export function starRemovalCommands(options: {
	starMask?: boolean;
	stretch?: boolean;
	stride?: number;
}): string[] {
	const parts = ["starnet"];
	if (options.stretch) parts.push("-stretch");
	if (options.stride !== undefined) parts.push(`-stride=${options.stride}`);
	if (options.starMask === false) parts.push("-nostarmask");
	return [parts.join(" ")];
}

export interface SessionScriptOptions extends StackScriptOptions {
	/** Gradient removal: Siril's own model, GraXpert's, or none. */
	background?: "none" | "siril" | "graxpert";
	denoise?: "none" | "siril" | "graxpert";
	deconvolve?: boolean;
	colorCalibrate?: boolean;
	stretch?: "none" | "auto" | "asinh" | "ghs";
	stretchAmount?: number;
	removeStars?: boolean;
	/** Final image: name without extension, plus a format. */
	exportName?: string;
	exportFormat?: "png" | "jpg" | "tif";
	/** Where the final image goes. Defaults to the directory the intermediates are in. */
	exportDir?: string;
	graxpertModel?: string;
}

/**
 * The whole night in one script.
 *
 * Written as a single Siril run rather than a chain of them: the image stays loaded between steps,
 * so there is no saving and reloading a 100 MB frame six times, and the log reads as one story. It
 * is also how a person writing a Siril script would do it.
 */
export function buildSessionScript(options: SessionScriptOptions): string[] {
	const script = buildStackScript(options);
	const stacked = options.output;

	script.push(`load ${quote(stacked)}`);

	if (options.background === "graxpert") {
		script.push(
			...graxpertCommands("background", {
				...(options.graxpertModel ? { model: options.graxpertModel } : {}),
			}),
		);
	} else if (options.background === "siril") {
		script.push(...backgroundCommands({}));
	}

	if (options.denoise === "graxpert") {
		script.push(
			...graxpertCommands("denoise", {
				...(options.graxpertModel ? { model: options.graxpertModel } : {}),
			}),
		);
	} else if (options.denoise === "siril") {
		script.push(...denoiseCommands({}));
	}

	if (options.deconvolve) script.push(...deconvolveCommands({}));
	if (options.colorCalibrate) script.push(...colorCalibrationCommands({}));

	if (options.stretch && options.stretch !== "none") {
		script.push(
			...stretchCommands({
				method: options.stretch,
				...(options.stretchAmount !== undefined ? { amount: options.stretchAmount } : {}),
			}),
		);
	}

	// Star removal last: it works best on stretched data, and leaves a starless image loaded.
	if (options.removeStars) script.push(...starRemovalCommands({}));

	script.push(`save ${quote(`${stacked}_processed`)}`);

	if (options.exportName) {
		script.push(
			...saveImageCommands(
				imageTarget(options.exportName, options.exportDir),
				options.exportFormat ?? "png",
			),
		);
	}

	return script;
}

/** What each preset turns on. Named for what someone would ask for out loud. */
export const PRESETS = {
	/** Just make me a picture. */
	quick: {
		background: "none",
		denoise: "none",
		deconvolve: false,
		colorCalibrate: false,
		stretch: "auto",
	},
	/** The usual night: drop the worst frames, flatten the sky, fix the colour. */
	standard: {
		bestPercent: 90,
		background: "siril",
		denoise: "none",
		deconvolve: false,
		colorCalibrate: true,
		stretch: "auto",
	},
	/** Everything, including the slow parts. */
	full: {
		bestPercent: 85,
		background: "graxpert",
		denoise: "graxpert",
		deconvolve: true,
		colorCalibrate: true,
		stretch: "auto",
	},
} as const satisfies Record<string, Partial<SessionScriptOptions>>;

export type PresetName = keyof typeof PRESETS;
