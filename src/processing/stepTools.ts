import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { errorResult, guard, textResult } from "../tools/result.js";
import { sessionPaths } from "../workdir.js";
import { findTool, isFound } from "./binaries.js";
import { discoveryEnv, type ProcessingConfig } from "./config.js";
import { describeJob, type JobStore } from "./jobs.js";
import {
	backgroundCommands,
	buildOperationScript,
	colorCalibrationCommands,
	deconvolveCommands,
	denoiseCommands,
	graxpertCommands,
	runSirilScript,
	starRemovalCommands,
	stretchCommands,
} from "./siril.js";

/**
 * The steps between a stack and a finished picture.
 *
 * Each one is the same shape — load an image, run a command or two, save the result — so they share
 * one runner. What differs is the Siril commands, and those live in `siril.ts` next to the help text
 * they were taken from.
 *
 * Two of them can be done either by Siril itself or by GraXpert's AI models, which Siril runs as a
 * Python script. GraXpert is better at both; Siril's versions need nothing installed.
 */
export function registerStepTools(
	server: McpServer,
	config: ProcessingConfig,
	jobs: JobStore,
): void {
	const requireSiril = async (): Promise<string> => {
		const tool = await findTool("siril", { env: discoveryEnv(config), skipVersions: true });
		if (!isFound(tool)) {
			throw new Error(
				"Siril is not installed. Get it from https://siril.org/download/ or point at it with --siril.",
			);
		}
		return tool.path;
	};

	const directoryFor = (session?: string, path?: string) => {
		if (path) return { directory: path, logs: join(path, "logs"), name: path };
		if (!session) return undefined;
		const paths = sessionPaths(config.workDir, session);
		return { directory: paths.process, logs: paths.logs, name: paths.name };
	};

	/** Register one step: same arguments, same job handling, different commands. */
	const step = (
		name: string,
		spec: {
			title: string;
			description: string;
			extraInput?: z.ZodRawShape;
			defaultOutput: string;
			commands: (input: Record<string, unknown>) => string[];
			note?: (input: Record<string, unknown>) => string | undefined;
		},
	): void => {
		server.registerTool(
			name,
			{
				title: spec.title,
				description: spec.description,
				inputSchema: z.object({
					session: z.string().optional().describe("Session name, as listed by session_list"),
					path: z.string().optional().describe("A directory, instead of a session"),
					input: z.string().optional().describe("Image to load, default 'stacked'"),
					output: z.string().optional().describe(`Result name, default '${spec.defaultOutput}'`),
					wait: z.boolean().optional().describe("Block until it finishes. Default false."),
					timeout_s: z.number().min(10).max(7200).optional(),
					...(spec.extraInput ?? {}),
				}),
			},
			async (input: Record<string, unknown>) =>
				guard(async () => {
					const target = directoryFor(input.session as string, input.path as string);
					if (!target) {
						return errorResult("Give a session name or a path. session_list shows what exists.");
					}

					const sirilPath = await requireSiril();
					const source = (input.input as string) ?? "stacked";
					const output = (input.output as string) ?? spec.defaultOutput;

					const script = buildOperationScript({
						directory: target.directory,
						input: source,
						output,
						commands: spec.commands(input),
					});

					const logPath = join(target.logs, `${name}-${Date.now()}.log`);
					const job = jobs.start({
						name: `${name} ${target.name}`,
						logPath,
						run: async (context) => {
							const result = await runSirilScript(sirilPath, script, {
								workDir: target.directory,
								logPath,
								signal: context.signal,
								timeoutMs: (input.timeout_s as number | undefined)
									? (input.timeout_s as number) * 1000
									: config.timeoutMs,
								onLine: context.line,
							});

							if (!result.success) {
								throw new Error(result.error ?? `Siril exited with code ${result.exitCode}`);
							}
							return { output: join(target.directory, `${output}.fit`) };
						},
					});

					const intro = [
						`${spec.title} on ${source} → ${output}.`,
						spec.note?.(input) ?? "",
						"",
						"Commands:",
						...spec.commands(input).map((line) => `  ${line}`),
					].filter(Boolean);

					if (input.wait !== true) {
						return textResult(
							[...intro, "", `Started as ${job.id}. Follow it with astro_job.`].join("\n"),
							describeJob(job),
						);
					}

					const finished =
						(await jobs.wait(job.id, ((input.timeout_s as number) ?? 900) * 1000)) ?? job;

					if (finished.status === "failed") {
						return errorResult(
							[
								`${finished.name} failed: ${finished.error}`,
								"",
								`Log: ${finished.logPath}`,
								...finished.tail.slice(-8).map((line) => `  ${line}`),
							].join("\n"),
						);
					}

					return textResult(
						[...intro, "", `${finished.status}. Result: ${JSON.stringify(finished.result)}`].join(
							"\n",
						),
						describeJob(finished),
					);
				}),
		);
	};

	step("astro_background_extract", {
		title: "Remove the sky gradient",
		description:
			"Model the background gradient — light pollution, moonlight, an uneven sky — and subtract " +
			"it. GraXpert's AI model is better at it; Siril's own RBF model needs nothing installed.",
		defaultOutput: "background_extracted",
		extraInput: {
			method: z
				.enum(["siril", "graxpert"])
				.optional()
				.describe("Default siril, which is always available"),
			samples: z
				.number()
				.int()
				.min(4)
				.max(50)
				.optional()
				.describe("Siril: samples per line, default 20"),
			tolerance: z
				.number()
				.min(0)
				.max(10)
				.optional()
				.describe("Siril: how much of the sky to treat as background"),
			smooth: z.number().min(0).max(1).optional(),
			degree: z
				.number()
				.int()
				.min(1)
				.max(4)
				.optional()
				.describe("Siril: use a polynomial of this degree instead of RBF"),
			model: z.string().optional().describe("GraXpert: model version, e.g. 3.0.1"),
		},
		note: (input) =>
			input.method === "graxpert"
				? "GraXpert runs as a Siril script; install it once through Siril's Scripts → Get Scripts."
				: undefined,
		commands: (input) =>
			input.method === "graxpert"
				? graxpertCommands("background", {
						...(input.model ? { model: input.model as string } : {}),
					})
				: backgroundCommands({
						...(input.degree !== undefined ? { degree: input.degree as number } : {}),
						...(input.samples !== undefined ? { samples: input.samples as number } : {}),
						...(input.tolerance !== undefined ? { tolerance: input.tolerance as number } : {}),
						...(input.smooth !== undefined ? { smooth: input.smooth as number } : {}),
					}),
	});

	step("astro_denoise", {
		title: "Reduce noise",
		description:
			"Smooth out sensor noise while keeping detail. GraXpert's AI denoiser is the stronger " +
			"option; Siril's non-local Bayes implementation needs nothing installed but is slower.",
		defaultOutput: "denoised",
		extraInput: {
			method: z.enum(["siril", "graxpert"]).optional().describe("Default siril"),
			modulation: z
				.number()
				.min(0)
				.max(1)
				.optional()
				.describe("Siril: how much of the denoised result to blend in, 1 is full strength"),
			model: z.string().optional().describe("GraXpert: model version"),
			options: z
				.string()
				.optional()
				.describe("GraXpert: extra arguments passed to the script as written"),
		},
		note: (input) =>
			input.method === "graxpert"
				? "GraXpert runs as a Siril script; install it once through Siril's Scripts → Get Scripts."
				: "Siril's denoise is thorough and slow — minutes on a large stack.",
		commands: (input) =>
			input.method === "graxpert"
				? graxpertCommands("denoise", {
						...(input.model ? { model: input.model as string } : {}),
						...(input.options ? { extraArgs: (input.options as string).split(/\s+/) } : {}),
					})
				: denoiseCommands({
						...(input.modulation !== undefined ? { modulation: input.modulation as number } : {}),
					}),
	});

	step("astro_deconvolve", {
		title: "Sharpen with deconvolution",
		description:
			"Recover detail blurred by the optics and the atmosphere, using a point spread function " +
			"measured from the stars in the image. Overdo it and you get rings around stars.",
		defaultOutput: "deconvolved",
		extraInput: {
			iterations: z.number().int().min(1).max(100).optional().describe("Default 10"),
			psf: z
				.enum(["stars", "blind"])
				.optional()
				.describe("Measure the PSF from stars (default) or estimate it blindly"),
			alpha: z.number().min(0).optional().describe("Regularisation strength"),
		},
		commands: (input) =>
			deconvolveCommands({
				...(input.psf ? { psf: input.psf as "stars" | "blind" } : {}),
				...(input.iterations !== undefined ? { iterations: input.iterations as number } : {}),
				...(input.alpha !== undefined ? { alpha: input.alpha as number } : {}),
			}),
	});

	step("astro_color_calibrate", {
		title: "Correct the colours",
		description:
			"Set the colour balance from the actual spectra of catalogued stars in the frame. The " +
			"image has to be plate-solved first, which this does unless told otherwise.",
		defaultOutput: "color_calibrated",
		extraInput: {
			method: z
				.enum(["pcc", "spcc"])
				.optional()
				.describe("pcc (default) is photometric; spcc is spectrophotometric and more exact"),
			platesolve: z.boolean().optional().describe("Solve first. Default true."),
			limit_magnitude: z.number().optional(),
			catalog: z.string().optional().describe("Star catalog, e.g. nomad, apass, gaia"),
		},
		note: () =>
			"Needs an internet connection for the star catalog, unless a local one is installed.",
		commands: (input) =>
			colorCalibrationCommands({
				...(input.method ? { method: input.method as "pcc" | "spcc" } : {}),
				...(input.platesolve !== undefined ? { platesolve: input.platesolve as boolean } : {}),
				...(input.limit_magnitude !== undefined
					? { limitMagnitude: input.limit_magnitude as number }
					: {}),
				...(input.catalog ? { catalog: input.catalog as string } : {}),
			}),
	});

	step("astro_stretch", {
		title: "Make the faint things visible",
		description:
			"Stretch the linear data so faint detail shows. Auto-stretch is the safe default; asinh " +
			"keeps star colour better; the hyperbolic stretch gives the most control.",
		defaultOutput: "stretched",
		extraInput: {
			method: z.enum(["auto", "asinh", "ghs"]).optional().describe("Default auto"),
			amount: z
				.number()
				.min(0)
				.optional()
				.describe("asinh: stretch factor, typically 1-1000. ghs: stretch amount."),
			shadows_clip: z.number().optional().describe("Where to put the black point, in sigma"),
			linked: z
				.boolean()
				.optional()
				.describe("Stretch all channels together, keeping colour balance"),
		},
		commands: (input) =>
			stretchCommands({
				...(input.method ? { method: input.method as "auto" | "asinh" | "ghs" } : {}),
				...(input.amount !== undefined ? { amount: input.amount as number } : {}),
				...(input.shadows_clip !== undefined ? { shadowsClip: input.shadows_clip as number } : {}),
				...(input.linked !== undefined ? { linked: input.linked as boolean } : {}),
			}),
	});

	step("astro_remove_stars", {
		title: "Separate the stars from the nebula",
		description:
			"Produce a starless image, and a star mask alongside it, so the two can be processed apart " +
			"and recombined. Needs StarNet installed and set in Siril's preferences; Siril's own Zenith " +
			"script is the newer free alternative and can be run through astro_run_script.",
		defaultOutput: "starless",
		extraInput: {
			star_mask: z.boolean().optional().describe("Also write the star layer. Default true."),
			stretch: z.boolean().optional().describe("Stretch linear data before removing stars"),
			stride: z.number().int().min(2).max(512).optional(),
		},
		commands: (input) =>
			starRemovalCommands({
				...(input.star_mask !== undefined ? { starMask: input.star_mask as boolean } : {}),
				...(input.stretch !== undefined ? { stretch: input.stretch as boolean } : {}),
				...(input.stride !== undefined ? { stride: input.stride as number } : {}),
			}),
	});
}
