import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { formatDuration } from "../format.js";
import { errorResult, guard, textResult } from "../tools/result.js";
import { sessionPaths } from "../workdir.js";
import { findTool, isFound } from "./binaries.js";
import { discoveryEnv, type ProcessingConfig } from "./config.js";
import { describeJob, type Job, type JobStore } from "./jobs.js";
import { detectBayerPattern } from "./sessions.js";
import {
	buildExportScript,
	buildStackScript,
	type RejectionType,
	renderScript,
	runSirilScript,
} from "./siril.js";

/**
 * The pipeline itself: turn a pile of frames into a picture.
 *
 * Every step here is a Siril script we generate and run. The heavy ones return a job id rather than
 * blocking, and `astro_job` follows them.
 */
export function registerPipelineTools(
	server: McpServer,
	config: ProcessingConfig,
	jobs: JobStore,
): void {
	/** Siril, or a sentence explaining how to get it. */
	const requireSiril = async (): Promise<string> => {
		const tool = await findTool("siril", { env: discoveryEnv(config), skipVersions: true });
		if (!isFound(tool)) {
			throw new Error(
				"Siril is not installed, and everything here needs it. Get it from " +
					"https://siril.org/download/, or point at it with --siril. astro_tools shows what was searched.",
			);
		}
		return tool.path;
	};

	const resolveDirectories = (session?: string, path?: string) => {
		if (path) return { input: path, output: path, logs: join(path, "logs"), name: path };
		if (!session) return undefined;

		const paths = sessionPaths(config.workDir, session);
		return { input: paths.raw, output: paths.process, logs: paths.logs, name: paths.name };
	};

	server.registerTool(
		"astro_stack",
		{
			title: "Align and stack a session",
			description:
				"Turn a session's frames into one stacked image: convert to a Siril sequence, optionally " +
				"calibrate with darks and flats, align, and stack with outlier rejection. This takes " +
				"minutes, so it returns a job id — follow it with astro_job.",
			inputSchema: z.object({
				session: z.string().optional().describe("Session name, as listed by session_list"),
				path: z.string().optional().describe("A directory of frames, instead of a session"),
				output: z.string().optional().describe("Name of the result, default 'stacked'"),
				register: z
					.boolean()
					.optional()
					.describe("Align the frames first. Default true; turn off only for aligned frames."),
				rejection: z
					.enum([
						"none",
						"percentile",
						"sigma",
						"median",
						"winsorized",
						"linear",
						"generalized",
						"mad",
					])
					.optional()
					.describe("Outlier rejection. Winsorized is a good default for a Seestar session."),
				sigma_low: z.number().min(0).max(10).optional().describe("Default 3"),
				sigma_high: z.number().min(0).max(10).optional().describe("Default 3"),
				normalization: z
					.enum(["addscale", "add", "mulscale", "mul", "none"])
					.optional()
					.describe("Default addscale, which evens out a changing sky background"),
				best_percent: z
					.number()
					.int()
					.min(10)
					.max(100)
					.optional()
					.describe("Keep only this percentage of frames, best FWHM first. Needs registration."),
				dark: z
					.string()
					.optional()
					.describe("Master dark. Seestar subtracts its own, so usually none."),
				flat: z.string().optional(),
				bias: z.string().optional(),
				debayer: z
					.boolean()
					.optional()
					.describe(
						"Demosaic one-shot-colour frames. Left unset it follows the frames' BAYERPAT " +
							"card, which every Seestar sub-frame carries.",
					),
				wait: z.boolean().optional().describe("Block until it finishes. Default false."),
				timeout_s: z.number().min(10).max(7200).optional().describe("Wait timeout, default 600s"),
			}),
		},
		async (input) =>
			guard(async () => {
				const directories = resolveDirectories(input.session, input.path);
				if (!directories) {
					return errorResult("Give a session name or a path. session_list shows what exists.");
				}

				const sirilPath = await requireSiril();
				const output = input.output ?? "stacked";
				await mkdir(directories.output, { recursive: true });

				// Undemosaiced frames stack into a grey mosaic, so the default has to be right rather
				// than convenient: ask the frames themselves unless the caller has an opinion.
				const debayer =
					input.debayer ?? (await detectBayerPattern(directories.input)) !== undefined;

				const script = buildStackScript({
					inputDir: directories.input,
					outputDir: directories.output,
					output,
					debayer,
					...(input.register !== undefined ? { register: input.register } : {}),
					...(input.rejection ? { rejection: input.rejection as RejectionType } : {}),
					...(input.sigma_low !== undefined ? { sigmaLow: input.sigma_low } : {}),
					...(input.sigma_high !== undefined ? { sigmaHigh: input.sigma_high } : {}),
					...(input.normalization ? { normalization: input.normalization } : {}),
					...(input.best_percent !== undefined ? { bestPercent: input.best_percent } : {}),
					...(input.dark ? { dark: input.dark } : {}),
					...(input.flat ? { flat: input.flat } : {}),
					...(input.bias ? { bias: input.bias } : {}),
				});

				// One path, computed once: the job and the run must write and read the same file.
				const logPath = join(directories.logs, `stack-${Date.now()}.log`);
				const job = jobs.start({
					name: `stack ${directories.name}`,
					logPath,
					run: async (context) => {
						const result = await runSirilScript(sirilPath, script, {
							workDir: directories.input,
							logPath,
							signal: context.signal,
							timeoutMs: config.timeoutMs,
							onLine: context.line,
						});

						if (!result.success) {
							throw new Error(result.error ?? `Siril exited with code ${result.exitCode}`);
						}

						return {
							output: join(directories.output, `${output}.fit`),
							duration_seconds: Math.round(result.durationMs / 1000),
						};
					},
				});

				return finishOrReport(jobs, job, input.wait === true, (input.timeout_s ?? 600) * 1000, [
					`Stacking ${directories.name}.`,
					"",
					"Script:",
					...script.map((line) => `  ${line}`),
				]);
			}),
	);

	server.registerTool(
		"astro_export",
		{
			title: "Save an image as PNG, JPEG or TIFF",
			description:
				"Load a processed FITS and write it out as an ordinary image file, stretching it first " +
				"so the linear data is actually visible.",
			inputSchema: z.object({
				session: z.string().optional(),
				path: z.string().optional().describe("A directory, instead of a session"),
				input: z.string().optional().describe("File to load, default 'stacked'"),
				output: z.string().optional().describe("Output name without extension, default 'result'"),
				format: z.enum(["png", "jpg", "tif"]).optional().describe("Default png"),
				stretch: z.boolean().optional().describe("Auto-stretch before saving. Default true."),
				quality: z.number().int().min(10).max(100).optional().describe("JPEG quality, default 90"),
				wait: z
					.boolean()
					.optional()
					.describe("Block until it finishes. Default true — it is quick."),
			}),
		},
		async (input) =>
			guard(async () => {
				const directories = resolveDirectories(input.session, input.path);
				if (!directories) {
					return errorResult("Give a session name or a path. session_list shows what exists.");
				}

				const sirilPath = await requireSiril();
				const output = input.output ?? "result";
				const format = input.format ?? "png";

				const script = buildExportScript({
					inputDir: directories.output,
					input: input.input ?? "stacked",
					output,
					format,
					...(input.stretch !== undefined ? { stretch: input.stretch } : {}),
					...(input.quality !== undefined ? { quality: input.quality } : {}),
				});

				const logPath = join(directories.logs, `export-${Date.now()}.log`);
				const job = jobs.start({
					name: `export ${directories.name}`,
					logPath,
					run: async (context) => {
						const result = await runSirilScript(sirilPath, script, {
							workDir: directories.output,
							logPath,
							signal: context.signal,
							timeoutMs: config.timeoutMs,
							onLine: context.line,
						});

						if (!result.success) {
							throw new Error(result.error ?? `Siril exited with code ${result.exitCode}`);
						}

						return { output: join(directories.output, `${output}.${format}`) };
					},
				});

				return finishOrReport(jobs, job, input.wait !== false, 120_000, [
					`Exporting ${input.input ?? "stacked"} as ${format}.`,
				]);
			}),
	);

	server.registerTool(
		"astro_run_script",
		{
			title: "Run Siril commands directly",
			description:
				"Send a list of Siril commands, for anything the other tools do not cover. No guard " +
				"rails: the commands are passed through as written.",
			inputSchema: z.object({
				commands: z.array(z.string()).min(1).describe("One Siril command per entry"),
				session: z.string().optional(),
				path: z.string().optional().describe("Working directory, instead of a session"),
				wait: z.boolean().optional().describe("Block until it finishes. Default true."),
				timeout_s: z.number().min(10).max(7200).optional(),
			}),
		},
		async (input) =>
			guard(async () => {
				const directories = resolveDirectories(input.session, input.path) ?? {
					input: config.workDir,
					output: config.workDir,
					logs: join(config.workDir, "logs"),
					name: "work directory",
				};

				const sirilPath = await requireSiril();
				// `requires` guards against a Siril too old for whatever the caller wrote.
				const script = ["requires 1.4.0", ...input.commands];
				const logPath = join(directories.logs, `script-${Date.now()}.log`);

				const job = jobs.start({
					name: `script in ${directories.name}`,
					logPath,
					run: async (context) => {
						const result = await runSirilScript(sirilPath, script, {
							workDir: directories.input,
							logPath,
							signal: context.signal,
							timeoutMs: (input.timeout_s ?? 600) * 1000,
							onLine: context.line,
						});

						if (!result.success) {
							throw new Error(result.error ?? `Siril exited with code ${result.exitCode}`);
						}
						return { lines: result.tail.length };
					},
				});

				return finishOrReport(jobs, job, input.wait !== false, (input.timeout_s ?? 600) * 1000, [
					`Running ${input.commands.length} command(s) in ${directories.input}.`,
				]);
			}),
	);

	server.registerTool(
		"astro_job",
		{
			title: "Follow a processing job",
			description:
				"Status, log and cancellation for the jobs started by the processing tools. Poll this " +
				"instead of waiting: a stack of a few hundred frames takes minutes.",
			inputSchema: z.object({
				id: z.string().optional().describe("Job id. Omit to list them all."),
				cancel: z.boolean().optional().describe("Stop the job"),
				log_lines: z
					.number()
					.int()
					.min(1)
					.max(500)
					.optional()
					.describe("How many lines of the log to show, default 20"),
			}),
		},
		async ({ id, cancel, log_lines }) =>
			guard(async () => {
				if (!id) {
					const all = jobs.list();
					if (all.length === 0) return textResult("No jobs have been started yet.");
					return textResult(
						all
							.map(
								(job) =>
									`${job.id}  ${job.status.padEnd(9)}  ${job.name}${job.error ? ` — ${job.error}` : ""}`,
							)
							.join("\n"),
						{ jobs: all.map(describeJob) },
					);
				}

				const job = jobs.get(id);
				if (!job) return errorResult(`No job called ${id}.`);

				if (cancel) {
					const stopped = jobs.cancel(id);
					return textResult(
						stopped ? `Cancelled ${id}.` : `${id} is already ${job.status}.`,
						describeJob(job),
					);
				}

				const lines = await jobs.readLog(id, log_lines ?? 20);
				const elapsed = Math.round(
					((job.endedAt ?? new Date()).getTime() - job.startedAt.getTime()) / 1000,
				);

				const text = [
					`${job.name} — ${job.status} after ${formatDuration(elapsed)}`,
					job.error ? `\n${job.error}` : "",
					job.result ? `\nResult: ${JSON.stringify(job.result)}` : "",
					lines.length > 0
						? `\nLog (${job.logPath}):\n${lines.map((line) => `  ${line}`).join("\n")}`
						: "",
				]
					.filter(Boolean)
					.join("\n");

				return textResult(text, describeJob(job));
			}),
	);
}

/**
 * Either wait for the job or hand back its id.
 *
 * Waiting is a convenience for short work; the default for anything slow is to return at once, so
 * the model can do something else and poll.
 */
async function finishOrReport(
	jobs: JobStore,
	job: Job,
	wait: boolean,
	timeoutMs: number,
	intro: string[],
): Promise<ReturnType<typeof textResult>> {
	if (!wait) {
		return textResult(
			[...intro, "", `Started as ${job.id}. Follow it with astro_job.`].join("\n"),
			describeJob(job),
		);
	}

	const finished = (await jobs.wait(job.id, timeoutMs)) ?? job;

	if (finished.status === "running") {
		return textResult(
			[
				...intro,
				"",
				`Still running after ${Math.round(timeoutMs / 1000)}s — follow ${job.id} with astro_job.`,
			].join("\n"),
			describeJob(finished),
		);
	}

	if (finished.status !== "done") {
		return errorResult(
			[
				`${finished.name} ${finished.status}: ${finished.error ?? "no reason given"}`,
				"",
				`Log: ${finished.logPath}`,
				finished.tail.length > 0
					? finished.tail
							.slice(-10)
							.map((line) => `  ${line}`)
							.join("\n")
					: "",
			]
				.filter(Boolean)
				.join("\n"),
		);
	}

	return textResult(
		[
			...intro,
			"",
			`Done in ${formatDuration((finished.result?.duration_seconds as number) ?? 0)}.`,
			`Result: ${JSON.stringify(finished.result)}`,
		].join("\n"),
		describeJob(finished),
	);
}

export { renderScript };
