import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

/**
 * Configuration for the processing server.
 *
 * Separate from the telescope server's config on purpose: the two run as different processes, and
 * nothing here knows anything about Alpaca.
 */
export const processingConfigSchema = z.object({
	/** Where sessions live: downloaded frames, intermediate files, results. */
	workDir: z.string().min(1),
	/** Explicit paths, when the programs are not where we would look for them. */
	sirilPath: z.string().optional(),
	graxpertPath: z.string().optional(),
	starnetPath: z.string().optional(),
	/** How long a single external program may run before it is killed. */
	timeoutMs: z.number().int().min(1_000).default(3_600_000),
});

export type ProcessingConfig = z.infer<typeof processingConfigSchema>;

export const PROCESSING_USAGE = `astro-mcp — MCP server for astrophotography processing (Siril, GraXpert)

Usage: astro-mcp [options]

Options:
  --work-dir <path>      Where sessions live (env ASTRO_WORK_DIR, default ~/astro)
  --siril <path>         Path to siril-cli (env SIRIL_PATH)
  --graxpert <path>      Path to GraXpert (env GRAXPERT_PATH)
  --starnet <path>       Path to StarNet++ (env STARNET_PATH)
  --timeout <ms>         Limit for one external program, default 3600000
  -h, --help             Show this help
  -v, --version          Show the version

Run astro_tools first: it reports which programs were found and what is missing.`;

class ProcessingConfigError extends Error {}

export function isProcessingConfigError(error: unknown): error is Error {
	return error instanceof ProcessingConfigError;
}

/** The default working directory: `~/astro`, unless told otherwise. */
export function defaultWorkDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.ASTRO_WORK_DIR ?? join(homedir(), "astro");
}

export function loadProcessingConfig(
	argv: string[] = [],
	env: NodeJS.ProcessEnv = process.env,
): ProcessingConfig {
	const raw: Record<string, unknown> = { workDir: defaultWorkDir(env) };

	if (env.SIRIL_PATH) raw.sirilPath = env.SIRIL_PATH;
	if (env.GRAXPERT_PATH) raw.graxpertPath = env.GRAXPERT_PATH;
	if (env.STARNET_PATH) raw.starnetPath = env.STARNET_PATH;
	if (env.ASTRO_TIMEOUT_MS) raw.timeoutMs = Number(env.ASTRO_TIMEOUT_MS);

	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index] as string;
		const next = (): string => {
			const value = argv[++index];
			if (value === undefined) throw new ProcessingConfigError(`${argument} needs a value`);
			return value;
		};

		switch (argument) {
			case "--work-dir":
				raw.workDir = next();
				break;
			case "--siril":
				raw.sirilPath = next();
				break;
			case "--graxpert":
				raw.graxpertPath = next();
				break;
			case "--starnet":
				raw.starnetPath = next();
				break;
			case "--timeout": {
				const value = Number(next());
				if (!Number.isFinite(value)) throw new ProcessingConfigError("--timeout must be a number");
				raw.timeoutMs = value;
				break;
			}
			default:
				throw new ProcessingConfigError(`unknown option ${argument}`);
		}
	}

	const parsed = processingConfigSchema.safeParse(raw);
	if (!parsed.success) {
		throw new ProcessingConfigError(
			parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
		);
	}

	return { ...parsed.data, workDir: resolve(parsed.data.workDir) };
}

/** The environment the tool discovery should search, given this configuration. */
export function discoveryEnv(
	config: ProcessingConfig,
	env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	return {
		...env,
		...(config.sirilPath ? { SIRIL_PATH: config.sirilPath } : {}),
		...(config.graxpertPath ? { GRAXPERT_PATH: config.graxpertPath } : {}),
		...(config.starnetPath ? { STARNET_PATH: config.starnetPath } : {}),
	};
}
