import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * Run the Seestar's built-in Alpaca server for a test file, in Docker, against a fake firmware.
 *
 * The server is ZWO's and closed source, so it is not in this repository: point
 * `SEESTAR_ALPACA_DIR` at a copy of the telescope's `/etc/zwo/Alpaca` (default
 * `.cache/seestar-alpaca`). The container runs its assemblies on the stock ASP.NET 8 runtime and
 * starts `firmware.mjs` in place of the telescope's JSON-RPC service.
 */

const run = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..", "..");
const IMAGE = "seestar-mcp-zwo-stand";

export interface Stand {
	host: string;
	port: number;
	close(): Promise<void>;
}

export interface StandOptions {
	/** Turn on the server's "Require Authorization" with this password (user "User"). */
	password?: string;
}

/** Where the server's files are, if they are anywhere. */
function serverDir(): string | undefined {
	const dir = process.env.SEESTAR_ALPACA_DIR ?? join(projectRoot, ".cache", "seestar-alpaca");
	return existsSync(join(dir, "ascom.alpaca.dll")) ? realpathSync(dir) : undefined;
}

async function dockerAvailable(): Promise<boolean> {
	try {
		await run("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 10_000 });
		return true;
	} catch {
		return false;
	}
}

/** Checked once at import: the suite skips, rather than fails, without its prerequisites. */
export const standUnavailable: string | undefined = await (async () => {
	if (!serverDir()) {
		return (
			"Seestar Alpaca server not found — set SEESTAR_ALPACA_DIR to a copy of the telescope's " +
			"/etc/zwo/Alpaca, or place one at .cache/seestar-alpaca."
		);
	}
	if (!(await dockerAvailable())) return "Docker is not available.";
	return undefined;
})();

let imageBuilt: Promise<void> | undefined;

/** Build the stand image once per run; Docker's cache makes repeats cheap. */
function buildImage(): Promise<void> {
	imageBuilt ??= run("docker", ["build", "-q", "-t", IMAGE, here], {
		timeout: 600_000,
	}).then(() => undefined);
	return imageBuilt;
}

export async function startStand(options: StandOptions = {}): Promise<Stand> {
	const dir = serverDir();
	if (!dir) throw new Error(standUnavailable);
	await buildImage();

	const args = [
		"run",
		"-d",
		"--rm",
		"-p",
		"127.0.0.1::32323",
		"-v",
		`${dir}:/seestar-alpaca:ro`,
		"-e",
		"FAKE_SLEW_MS=1000",
	];
	if (options.password) args.push("-e", `ALPACA_PASSWORD=${options.password}`);
	args.push(IMAGE);

	const { stdout } = await run("docker", args, { timeout: 60_000 });
	const id = stdout.trim();

	const close = async () => {
		await run("docker", ["rm", "-f", id], { timeout: 30_000 }).catch(() => undefined);
	};

	try {
		const { stdout: mapping } = await run("docker", ["port", id, "32323/tcp"]);
		const port = Number(mapping.trim().split("\n")[0]?.split(":").pop());
		await waitForDevices(port, id);
		return { host: "127.0.0.1", port, close };
	} catch (error) {
		await close();
		throw error;
	}
}

/**
 * The server answers HTTP before it has talked to the firmware; the devices appear once it has. The
 * management API is not behind the password, so this works either way.
 */
async function waitForDevices(port: number, id: string): Promise<void> {
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/management/v1/configureddevices`, {
				signal: AbortSignal.timeout(2_000),
			});
			if (response.ok) {
				const body = (await response.json()) as { Value?: Array<{ DeviceType: string }> };
				if (body.Value?.some((device) => device.DeviceType === "Telescope")) return;
			}
		} catch {
			// Still starting.
		}
		await new Promise((wait) => setTimeout(wait, 500));
	}

	const { stdout } = await run("docker", ["logs", "--tail", "40", id]).catch(() => ({
		stdout: "",
	}));
	throw new Error(`the Seestar Alpaca server did not come up within 90s\n${stdout}`);
}
