import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

/**
 * Finding the external programs the processing tools drive.
 *
 * None of them ships with this package: Siril, GraXpert and the star-removal tools are installed by
 * the user, in different places on every platform. "Which of them did you find, and where" is the
 * first question any support conversation starts with, so it is a tool of its own.
 */

const run = promisify(execFile);

export type ToolName =
	| "siril"
	| "graxpert"
	| "starnet"
	| "blurxterminator"
	| "starxterminator"
	| "noisexterminator";

export interface FoundTool {
	name: ToolName;
	label: string;
	path: string;
	version?: string;
	/** How it was found — useful when the wrong copy gets picked up. */
	source: "env" | "path" | "known location";
}

export interface MissingTool {
	name: ToolName;
	label: string;
	/** Everything that was looked at, so a wrong install path is obvious. */
	searched: string[];
	envVariable: string;
	hint: string;
}

export interface ToolInventory {
	found: FoundTool[];
	missing: MissingTool[];
}

interface ToolSpec {
	label: string;
	envVariable: string;
	/** Executable names to look for on PATH, best first. */
	binaries: string[];
	/** Full paths to check when PATH does not have it. */
	locations: Partial<Record<NodeJS.Platform, string[]>>;
	/** Argument lists to try for a version string; the first that prints something wins. */
	versionArgs: string[][];
	hint: string;
}

const WINDOWS_EXTENSIONS = [".exe", ".cmd", ".bat", ""];

const TOOLS: Record<ToolName, ToolSpec> = {
	siril: {
		label: "Siril",
		envVariable: "SIRIL_PATH",
		binaries: ["siril-cli", "siril"],
		locations: {
			win32: [
				"C:\\Program Files\\Siril\\bin\\siril-cli.exe",
				"C:\\Program Files (x86)\\Siril\\bin\\siril-cli.exe",
			],
			darwin: [
				"/Applications/Siril.app/Contents/MacOS/siril-cli",
				"/opt/homebrew/bin/siril-cli",
				"/usr/local/bin/siril-cli",
			],
			linux: ["/usr/bin/siril-cli", "/usr/local/bin/siril-cli", "/app/bin/siril-cli"],
		},
		versionArgs: [["--version"], ["-v"]],
		hint: "Required for calibration, registration, stacking and export. https://siril.org",
	},
	graxpert: {
		label: "GraXpert",
		envVariable: "GRAXPERT_PATH",
		binaries: ["graxpert", "GraXpert"],
		locations: {
			win32: ["C:\\Program Files\\GraXpert\\GraXpert.exe"],
			darwin: ["/Applications/GraXpert.app/Contents/MacOS/GraXpert"],
			linux: ["/usr/bin/graxpert", "/usr/local/bin/graxpert", "/opt/GraXpert/GraXpert"],
		},
		versionArgs: [["-v"], ["--version"]],
		hint: "Background extraction and denoising. https://github.com/Steffenhir/GraXpert",
	},
	starnet: {
		label: "StarNet++",
		envVariable: "STARNET_PATH",
		binaries: ["starnet++", "StarNetv2CLI_cpu", "starnet2", "starnet"],
		locations: {
			win32: ["C:\\Program Files\\StarNet\\StarNetv2CLI_cpu.exe"],
			darwin: ["/Applications/StarNet/StarNetv2CLI_cpu"],
			linux: ["/usr/local/bin/starnet++"],
		},
		versionArgs: [["--version"]],
		hint: "Star removal. Siril's own Zenith script is the newer free alternative.",
	},
	// The RC-Astro stand-alone CLI (June 2026) is paid, and its executable names are not documented
	// anywhere we could verify — so these are guesses and the environment variable is the reliable
	// route. Nothing breaks when they are absent: the steps simply are not offered.
	blurxterminator: {
		label: "BlurXTerminator",
		envVariable: "BXT_PATH",
		binaries: ["blurxterminator", "BlurXTerminator"],
		locations: {},
		versionArgs: [["--version"]],
		hint: "Optional, paid (RC Astro). Set BXT_PATH to the stand-alone CLI.",
	},
	starxterminator: {
		label: "StarXTerminator",
		envVariable: "SXT_PATH",
		binaries: ["starxterminator", "StarXTerminator"],
		locations: {},
		versionArgs: [["--version"]],
		hint: "Optional, paid (RC Astro). Set SXT_PATH to the stand-alone CLI.",
	},
	noisexterminator: {
		label: "NoiseXTerminator",
		envVariable: "NXT_PATH",
		binaries: ["noisexterminator", "NoiseXTerminator"],
		locations: {},
		versionArgs: [["--version"]],
		hint: "Optional, paid (RC Astro). Set NXT_PATH to the stand-alone CLI.",
	},
};

export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];

export interface FindOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	/** How long to wait for a program to print its version. */
	versionTimeoutMs?: number;
	/** Skip running the programs; only report where they are. */
	skipVersions?: boolean;
}

/** Look for one tool. Returns undefined when it is not installed. */
export async function findTool(
	name: ToolName,
	options: FindOptions = {},
): Promise<FoundTool | MissingTool> {
	const spec = TOOLS[name];
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const searched: string[] = [];

	const configured = env[spec.envVariable];
	if (configured) {
		searched.push(`${spec.envVariable}=${configured}`);
		if (await isExecutable(configured)) {
			return describe(name, spec, configured, "env", options);
		}
	}

	for (const binary of spec.binaries) {
		const resolved = await searchPath(binary, env, platform, searched);
		if (resolved) return describe(name, spec, resolved, "path", options);
	}

	for (const candidate of spec.locations[platform] ?? []) {
		searched.push(candidate);
		if (await isExecutable(candidate)) {
			return describe(name, spec, candidate, "known location", options);
		}
	}

	return {
		name,
		label: spec.label,
		searched,
		envVariable: spec.envVariable,
		hint: spec.hint,
	};
}

/** Look for every tool at once. */
export async function findTools(options: FindOptions = {}): Promise<ToolInventory> {
	const results = await Promise.all(TOOL_NAMES.map((name) => findTool(name, options)));

	return {
		found: results.filter(isFound),
		missing: results.filter((result): result is MissingTool => !isFound(result)),
	};
}

export function isFound(tool: FoundTool | MissingTool): tool is FoundTool {
	return "path" in tool;
}

/**
 * How to actually launch a program.
 *
 * Since the fix for CVE-2024-27980, Node refuses to spawn `.cmd` and `.bat` files directly — it
 * throws EINVAL — and plenty of Windows installers and package managers ship exactly that as their
 * entry point. Those go through `cmd.exe`, with the arguments still passed as a list so nothing is
 * ever concatenated into a shell string.
 */
export function invocation(
	path: string,
	args: string[],
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): Invocation {
	if (platform === "win32" && /\.(cmd|bat)$/i.test(path)) {
		// cmd.exe re-parses everything after /c, so the whole command has to be one quoted string
		// with the program path quoted inside it — otherwise "C:\Program Files\..." splits at the
		// space. That only works with verbatim arguments, so Node does not quote it again.
		const line = [path, ...args].map(quoteForCmd).join(" ");
		return {
			command: env.COMSPEC ?? "cmd.exe",
			args: ["/d", "/s", "/c", `"${line}"`],
			windowsVerbatimArguments: true,
		};
	}
	return { command: path, args };
}

export interface Invocation {
	command: string;
	args: string[];
	windowsVerbatimArguments?: boolean;
}

/** Quote an argument for cmd.exe: wrap anything it would split on, double any embedded quote. */
function quoteForCmd(value: string): string {
	return /[\s"&()<>^|]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Run one of the external programs and return its output. Use this rather than execFile directly. */
export async function execTool(
	path: string,
	args: string[],
	options: {
		timeoutMs?: number;
		cwd?: string;
		platform?: NodeJS.Platform;
		env?: NodeJS.ProcessEnv;
	} = {},
): Promise<{ stdout: string; stderr: string }> {
	const call = invocation(
		path,
		args,
		options.platform ?? process.platform,
		options.env ?? process.env,
	);

	return run(call.command, call.args, {
		timeout: options.timeoutMs ?? 60_000,
		windowsHide: true,
		maxBuffer: 8 * 1024 * 1024,
		...(call.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
		...(options.cwd ? { cwd: options.cwd } : {}),
	});
}

async function describe(
	name: ToolName,
	spec: ToolSpec,
	path: string,
	source: FoundTool["source"],
	options: FindOptions,
): Promise<FoundTool> {
	const version = options.skipVersions
		? undefined
		: await readVersion(path, spec.versionArgs, options);

	return { name, label: spec.label, path, source, ...(version ? { version } : {}) };
}

/**
 * Ask a program for its version.
 *
 * Best effort by design: GraXpert loads a machine-learning stack before it prints anything, and
 * some builds have no version flag at all. "Found, version unknown" is a perfectly good answer.
 */
async function readVersion(
	path: string,
	attempts: string[][],
	options: FindOptions,
): Promise<string | undefined> {
	for (const args of attempts) {
		try {
			const { stdout, stderr } = await execTool(path, args, {
				timeoutMs: options.versionTimeoutMs ?? 15_000,
				...(options.platform ? { platform: options.platform } : {}),
				...(options.env ? { env: options.env } : {}),
			});
			const line = firstMeaningfulLine(`${stdout}\n${stderr}`);
			if (line) return line;
		} catch (error) {
			// Some programs print the version and exit non-zero; take the output anyway.
			const output = error as { stdout?: string; stderr?: string };
			const line = firstMeaningfulLine(`${output.stdout ?? ""}\n${output.stderr ?? ""}`);
			if (line) return line;
		}
	}
	return undefined;
}

function firstMeaningfulLine(text: string): string | undefined {
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed && /\d/.test(trimmed)) return trimmed.slice(0, 120);
	}
	return undefined;
}

/** Walk PATH ourselves rather than shelling out to `which`, which does not exist everywhere. */
async function searchPath(
	binary: string,
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
	searched: string[],
): Promise<string | undefined> {
	const pathValue = env.PATH ?? env.Path ?? "";
	if (!pathValue) return undefined;

	const extensions = platform === "win32" ? WINDOWS_EXTENSIONS : [""];

	for (const directory of pathValue.split(delimiter)) {
		if (!directory) continue;
		for (const extension of extensions) {
			const candidate = join(directory, binary + extension);
			searched.push(candidate);
			if (await isExecutable(candidate)) return candidate;
		}
	}

	return undefined;
}

async function isExecutable(path: string): Promise<boolean> {
	try {
		// Windows reports X_OK for everything, so existence is all it can really tell us.
		await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
