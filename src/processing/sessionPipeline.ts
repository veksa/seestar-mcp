import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { errorResult, guard, textResult } from "../tools/result.js";
import { sessionPaths } from "../workdir.js";
import { findTool, isFound } from "./binaries.js";
import { discoveryEnv, type ProcessingConfig } from "./config.js";
import { describeJob, type JobStore } from "./jobs.js";
import { detectBayerPattern } from "./sessions.js";
import { buildSessionScript, PRESETS, type PresetName, runSirilScript } from "./siril.js";

/**
 * One call for the whole night.
 *
 * The individual steps exist for when someone wants control, but the common request is "process
 * yesterday's M31" — and answering that with fifteen tool calls wastes everyone's time. This runs
 * the lot as a single Siril script, which is also faster: the image never leaves memory between
 * steps.
 */
export function registerSessionPipeline(
	server: McpServer,
	config: ProcessingConfig,
	jobs: JobStore,
): void {
	server.registerTool(
		"process_session",
		{
			title: "Process a whole session",
			description:
				"Stack a session's frames and take the result all the way to a finished image: reject " +
				"the worst frames, align, stack, flatten the background, denoise, calibrate colour, " +
				"stretch, and export. Pick a preset, or set the steps yourself. Returns a job id — a " +
				"real session takes minutes.",
			inputSchema: z.object({
				session: z.string().optional().describe("Session name, as listed by session_list"),
				path: z.string().optional().describe("A directory of frames, instead of a session"),
				preset: z
					.enum(["quick", "standard", "full"])
					.optional()
					.describe(
						"quick: stack and stretch. standard: drop the worst 10%, flatten the sky, fix " +
							"colour. full: adds AI denoise and deconvolution, and needs GraXpert.",
					),
				output: z
					.string()
					.optional()
					.describe("Final image, e.g. m31.png. The extension picks the format."),
				reject_worst_percent: z
					.number()
					.int()
					.min(0)
					.max(90)
					.optional()
					.describe("Drop this share of the frames, worst FWHM first"),
				background: z.enum(["none", "siril", "graxpert"]).optional(),
				denoise: z.enum(["none", "siril", "graxpert"]).optional(),
				deconvolve: z.boolean().optional(),
				color_calibrate: z.boolean().optional(),
				stretch: z.enum(["none", "auto", "asinh", "ghs"]).optional(),
				remove_stars: z.boolean().optional().describe("Needs StarNet installed"),
				debayer: z
					.boolean()
					.optional()
					.describe(
						"Demosaic one-shot-colour frames. Left unset it follows the frames' BAYERPAT " +
							"card, which every Seestar sub-frame carries.",
					),
				wait: z.boolean().optional().describe("Block until it finishes. Default false."),
				timeout_s: z.number().min(30).max(21600).optional().describe("Wait timeout, default 1800s"),
			}),
		},
		async (input) =>
			guard(async () => {
				if (!input.session && !input.path) {
					return errorResult("Give a session name or a path. session_list shows what exists.");
				}

				const paths = input.path
					? {
							raw: input.path,
							process: input.path,
							logs: join(input.path, "logs"),
							name: input.path,
						}
					: sessionPaths(config.workDir, input.session as string);

				const tool = await findTool("siril", { env: discoveryEnv(config), skipVersions: true });
				if (!isFound(tool)) {
					return errorResult(
						"Siril is not installed, and the whole pipeline runs on it. " +
							"https://siril.org/download/ — or point at it with --siril.",
					);
				}

				const preset = PRESETS[(input.preset ?? "standard") as PresetName];
				const exportName = input.output ? stripExtension(input.output) : "result";
				const exportFormat = input.output ? formatOf(input.output) : "png";

				// Undemosaiced frames stack into a grey mosaic, so the default has to be right rather
				// than convenient: ask the frames themselves unless the caller has an opinion.
				const debayer = input.debayer ?? (await detectBayerPattern(paths.raw)) !== undefined;

				await mkdir(paths.process, { recursive: true });

				// Explicit arguments win over the preset; the preset wins over the plain defaults.
				const script = buildSessionScript({
					inputDir: paths.raw,
					outputDir: paths.process,
					output: "stacked",
					...preset,
					// Resolved above, from the caller or from the frames; no preset has a view on it.
					debayer,
					...(input.reject_worst_percent !== undefined
						? { bestPercent: 100 - input.reject_worst_percent }
						: {}),
					...(input.background ? { background: input.background } : {}),
					...(input.denoise ? { denoise: input.denoise } : {}),
					...(input.deconvolve !== undefined ? { deconvolve: input.deconvolve } : {}),
					...(input.color_calibrate !== undefined ? { colorCalibrate: input.color_calibrate } : {}),
					...(input.stretch ? { stretch: input.stretch } : {}),
					...(input.remove_stars !== undefined ? { removeStars: input.remove_stars } : {}),
					exportName,
					exportFormat,
				});

				const logPath = join(paths.logs, `process-${Date.now()}.log`);
				const job = jobs.start({
					name: `process ${paths.name}`,
					logPath,
					run: async (context) => {
						const result = await runSirilScript(tool.path, script, {
							workDir: paths.raw,
							logPath,
							signal: context.signal,
							timeoutMs: (input.timeout_s ?? 1800) * 1000,
							onLine: context.line,
						});

						if (!result.success) {
							throw new Error(result.error ?? `Siril exited with code ${result.exitCode}`);
						}

						return {
							image: join(paths.process, `${exportName}.${exportFormat}`),
							fits: join(paths.process, "stacked_processed.fit"),
							duration_seconds: Math.round(result.durationMs / 1000),
						};
					},
				});

				const intro = [
					`Processing ${paths.name} with the ${input.preset ?? "standard"} preset.`,
					"",
					"Siril will run:",
					...script.map((line) => `  ${line}`),
				];

				if (input.wait !== true) {
					return textResult(
						[
							...intro,
							"",
							`Started as ${job.id}. Follow it with astro_job — a full session takes minutes.`,
						].join("\n"),
						describeJob(job),
					);
				}

				const finished = (await jobs.wait(job.id, (input.timeout_s ?? 1800) * 1000)) ?? job;

				if (finished.status === "failed") {
					return errorResult(
						[
							`Processing failed: ${finished.error}`,
							"",
							`Log: ${finished.logPath}`,
							...finished.tail.slice(-10).map((line) => `  ${line}`),
						].join("\n"),
					);
				}

				if (finished.status === "running") {
					return textResult(
						[...intro, "", `Still running — follow ${job.id} with astro_job.`].join("\n"),
						describeJob(finished),
					);
				}

				return textResult(
					[
						`Processed ${paths.name}.`,
						"",
						`Image: ${(finished.result as { image?: string })?.image}`,
						`Stacked FITS: ${(finished.result as { fits?: string })?.fits}`,
						`Took ${(finished.result as { duration_seconds?: number })?.duration_seconds}s.`,
					].join("\n"),
					describeJob(finished),
				);
			}),
	);
}

function stripExtension(name: string): string {
	const extension = extname(name);
	return extension ? name.slice(0, -extension.length) : name;
}

function formatOf(name: string): "png" | "jpg" | "tif" {
	const extension = extname(name).toLowerCase();
	if (extension === ".jpg" || extension === ".jpeg") return "jpg";
	if (extension === ".tif" || extension === ".tiff") return "tif";
	return "png";
}
