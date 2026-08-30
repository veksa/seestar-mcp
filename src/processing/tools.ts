import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { formatFields } from "../format.js";
import { guard, textResult } from "../tools/result.js";
import { findTools } from "./binaries.js";
import { discoveryEnv, type ProcessingConfig } from "./config.js";
import type { JobStore } from "./jobs.js";
import { registerPipelineTools } from "./pipelineTools.js";
import { registerSessionTools } from "./sessionTools.js";
import { registerStepTools } from "./stepTools.js";

/**
 * Processing tools.
 *
 * Everything here drives a program the user installed: Siril for calibration, registration,
 * stacking and export; GraXpert for gradients and noise; StarNet or Zenith for star removal.
 * Nothing is bundled, so the first question is always which of them are actually present.
 */
export function registerProcessingTools(
	server: McpServer,
	config: ProcessingConfig,
	jobs: JobStore,
): void {
	registerSessionTools(server, config);
	registerPipelineTools(server, config, jobs);
	registerStepTools(server, config, jobs);

	server.registerTool(
		"astro_tools",
		{
			title: "Which processing programs are installed",
			description:
				"Report the external programs this server can drive — Siril, GraXpert, star removal — " +
				"with their versions and where they were found. Run this first: every other processing " +
				"tool depends on them, and this says what is missing and how to install it.",
			inputSchema: z.object({
				check_versions: z
					.boolean()
					.optional()
					.describe("Run each program to read its version. Default true; slower but more useful."),
			}),
			outputSchema: z.object({
				work_dir: z.string(),
				found: z.array(
					z.object({
						name: z.string(),
						label: z.string(),
						path: z.string(),
						version: z.string().optional(),
						source: z.string(),
					}),
				),
				missing: z.array(
					z.object({ name: z.string(), label: z.string(), env_variable: z.string() }),
				),
				ready: z.boolean(),
			}),
			annotations: { readOnlyHint: true },
		},
		async ({ check_versions }) =>
			guard(async () => {
				const inventory = await findTools({
					env: discoveryEnv(config),
					...(check_versions === false ? { skipVersions: true } : {}),
				});

				const siril = inventory.found.find((tool) => tool.name === "siril");
				const foundLines = inventory.found.map((tool) =>
					formatFields([
						[tool.label, tool.version ?? "found, version unknown"],
						["  path", tool.path],
						["  found via", tool.source],
					]),
				);

				const missingLines = inventory.missing.map(
					(tool) =>
						`${tool.label} — not found. ${tool.hint}\n  set ${tool.envVariable} to override`,
				);

				const headline = siril
					? "Siril is available, so stacking and export will work."
					: "Siril is missing — nothing can be processed until it is installed. https://siril.org/download/";

				const text = [
					headline,
					"",
					`working directory: ${config.workDir}`,
					"",
					foundLines.join("\n\n"),
					missingLines.length > 0 ? `\n${missingLines.join("\n")}` : "",
				]
					.filter((part) => part !== "")
					.join("\n");

				return textResult(text, {
					work_dir: config.workDir,
					found: inventory.found.map((tool) => ({
						name: tool.name,
						label: tool.label,
						path: tool.path,
						source: tool.source,
						...(tool.version ? { version: tool.version } : {}),
					})),
					missing: inventory.missing.map((tool) => ({
						name: tool.name,
						label: tool.label,
						env_variable: tool.envVariable,
					})),
					ready: siril !== undefined,
				});
			}),
	);
}
