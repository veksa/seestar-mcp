import { z } from "zod";
import type { DeviceType } from "./alpaca/client.js";
import { DEVICE_TYPES } from "./alpaca/client.js";
import { defaultWorkDir } from "./workdir.js";

/**
 * How the server was started.
 *
 * Everything can come from a CLI flag or an environment variable, because MCP hosts differ in which
 * one they make easy: Claude Code passes arguments, some desktop configs only pass env.
 */
export const configSchema = z.object({
	/** Alpaca server address. Without it, the model has to call `device_connect` first. */
	host: z.string().min(1).optional(),
	port: z.number().int().min(1).max(65535).default(5555),
	/** seestar_alp numbers real scopes from 1; device 0 is the "federation" of all scopes. */
	deviceNumber: z.number().int().min(0).default(1),
	deviceType: z.enum(DEVICE_TYPES).default("telescope"),
	timeoutMs: z.number().int().min(100).default(10_000),
	/** `auto` enables the Seestar tools when the driver looks like seestar_alp. */
	profile: z.enum(["auto", "seestar", "generic"]).default("auto"),
	/** Register only tools that cannot change the state of the telescope. */
	readOnly: z.boolean().default(false),
	/** Required for tools that power the telescope down or reboot it. */
	allowDestructive: z.boolean().default(false),
	/** Expose the raw firmware passthrough tools. */
	allowRaw: z.boolean().default(true),
	clientId: z.number().int().min(1).max(65535).optional(),
	/** Where downloaded frames go. Shared by convention with astro-mcp, not by code. */
	workDir: z.string().min(1),
});

export type ServerConfig = z.infer<typeof configSchema>;

export const USAGE = `seestar-mcp — MCP server for ZWO Seestar telescopes over ASCOM Alpaca

Usage: seestar-mcp [options]

Options:
  --host <address>       Alpaca server address (env SEESTAR_HOST)
  --port <number>        Alpaca port, default 5555 (env SEESTAR_PORT)
  --device <number>      Device number, default 1; 0 is the federation (env SEESTAR_DEVICE)
  --device-type <type>   Alpaca device type, default telescope (env SEESTAR_DEVICE_TYPE)
  --timeout <ms>         Per-request timeout, default 10000 (env SEESTAR_TIMEOUT_MS)
  --profile <name>       auto | seestar | generic, default auto (env SEESTAR_PROFILE)
  --read-only            Register only tools that cannot move the telescope
  --allow-destructive    Allow shutdown and reboot tools
  --no-raw               Hide the raw firmware passthrough tools
  --client-id <number>   Fixed Alpaca ClientID
  --work-dir <path>      Where downloaded frames go (env ASTRO_WORK_DIR, default ~/astro)
  -h, --help             Show this help
  -v, --version          Show the version

Without --host, ask the model to run alpaca_discover and then device_connect.`;

class ConfigError extends Error {}

/** Parse CLI arguments and environment into a validated config. CLI wins over env. */
export function loadConfig(
	argv: string[] = [],
	env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
	const raw: Record<string, unknown> = { workDir: defaultWorkDir(env) };

	const fromEnv = <T>(name: string, parse: (value: string) => T): void => {
		const value = env[name];
		if (value !== undefined && value !== "") raw[envKey(name)] = parse(value);
	};

	fromEnv("SEESTAR_HOST", (value) => value);
	fromEnv("SEESTAR_PORT", toNumber("SEESTAR_PORT"));
	fromEnv("SEESTAR_DEVICE", toNumber("SEESTAR_DEVICE"));
	fromEnv("SEESTAR_DEVICE_TYPE", (value) => value.toLowerCase());
	fromEnv("SEESTAR_TIMEOUT_MS", toNumber("SEESTAR_TIMEOUT_MS"));
	fromEnv("SEESTAR_PROFILE", (value) => value.toLowerCase());
	fromEnv("SEESTAR_READ_ONLY", toBoolean);
	fromEnv("SEESTAR_ALLOW_DESTRUCTIVE", toBoolean);
	fromEnv("SEESTAR_ALLOW_RAW", toBoolean);
	fromEnv("SEESTAR_CLIENT_ID", toNumber("SEESTAR_CLIENT_ID"));

	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index] as string;
		const next = (): string => {
			const value = argv[++index];
			if (value === undefined) throw new ConfigError(`${argument} needs a value`);
			return value;
		};

		switch (argument) {
			case "--host":
				raw.host = next();
				break;
			case "--port":
				raw.port = toNumber("--port")(next());
				break;
			case "--device":
				raw.deviceNumber = toNumber("--device")(next());
				break;
			case "--device-type":
				raw.deviceType = next().toLowerCase();
				break;
			case "--timeout":
				raw.timeoutMs = toNumber("--timeout")(next());
				break;
			case "--profile":
				raw.profile = next().toLowerCase();
				break;
			case "--read-only":
				raw.readOnly = true;
				break;
			case "--allow-destructive":
				raw.allowDestructive = true;
				break;
			case "--no-raw":
				raw.allowRaw = false;
				break;
			case "--client-id":
				raw.clientId = toNumber("--client-id")(next());
				break;
			case "--work-dir":
				raw.workDir = next();
				break;
			default:
				throw new ConfigError(`unknown option ${argument}`);
		}
	}

	const parsed = configSchema.safeParse(raw);
	if (!parsed.success) {
		const problems = parsed.error.issues
			.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
			.join("; ");
		throw new ConfigError(problems);
	}

	return parsed.data;
}

export function isConfigError(error: unknown): error is Error {
	return error instanceof ConfigError;
}

/** `SEESTAR_DEVICE_TYPE` -> `deviceType`, with the couple of names that do not map mechanically. */
function envKey(name: string): string {
	const special: Record<string, string> = {
		SEESTAR_DEVICE: "deviceNumber",
		SEESTAR_TIMEOUT_MS: "timeoutMs",
		SEESTAR_ALLOW_RAW: "allowRaw",
	};
	if (special[name]) return special[name];

	return name
		.replace(/^SEESTAR_/, "")
		.toLowerCase()
		.replace(/_(.)/g, (_, letter: string) => letter.toUpperCase());
}

function toNumber(source: string): (value: string) => number {
	return (value: string) => {
		const parsed = Number(value);
		if (!Number.isFinite(parsed))
			throw new ConfigError(`${source} must be a number, got "${value}"`);
		return parsed;
	};
}

function toBoolean(value: string): boolean {
	return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

/** The device types a caller may name, re-exported so tools can validate against the same list. */
export const deviceTypes: readonly DeviceType[] = DEVICE_TYPES;
