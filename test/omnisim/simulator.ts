import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Run the real ASCOM Alpaca Simulators for a test file.
 *
 * These tests exist to catch what our own fake is too forgiving about: the simulators are the
 * reference implementation of the specification, maintained by the people who wrote it. Download
 * them first with `node scripts/fetch-omnisim.mjs` (or just run `yarn test:sim`).
 */

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifestPath = join(projectRoot, ".cache", "omnisim", "current.json");

export interface Simulator {
	host: string;
	port: number;
	url: string;
	close(): Promise<void>;
}

/** True when the simulator has been downloaded, so the suite can skip instead of failing. */
export function simulatorAvailable(): boolean {
	if (!existsSync(manifestPath)) return false;
	try {
		const { executable } = JSON.parse(readFileSync(manifestPath, "utf8")) as { executable: string };
		return existsSync(executable);
	} catch {
		return false;
	}
}

export function simulatorMissingMessage(): string {
	return "ASCOM simulator not downloaded — run `node scripts/fetch-omnisim.mjs` (or `yarn test:sim`).";
}

/** Ask the OS for a free port, then hand it straight to the simulator. */
async function freePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const probe = createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const port = typeof address === "object" && address ? address.port : 0;
			probe.close(() => resolvePort(port));
		});
	});
}

export async function startSimulator(): Promise<Simulator> {
	const { executable } = JSON.parse(readFileSync(manifestPath, "utf8")) as { executable: string };
	const port = await freePort();
	const url = `http://127.0.0.1:${port}`;

	// --set-no-browser is a write-and-exit flag, applied once by the fetch script; passing it here
	// would make the process configure itself and quit instead of serving.
	const child: ChildProcess = spawn(executable, [`--urls=${url}`], {
		stdio: "ignore",
		windowsHide: true,
	});

	let exited: { code: number | null } | undefined;
	child.on("exit", (code) => {
		exited = { code };
	});

	await waitForReady(url, child, () => exited);

	return {
		host: "127.0.0.1",
		port,
		url,
		async close() {
			if (exited) return;
			await new Promise<void>((resolveClose) => {
				child.once("exit", () => resolveClose());
				child.kill();
				// The simulator normally goes quickly; do not hang the suite if it does not.
				setTimeout(() => resolveClose(), 5_000).unref();
			});
		},
	};
}

async function waitForReady(
	url: string,
	child: ChildProcess,
	exited: () => { code: number | null } | undefined,
): Promise<void> {
	const deadline = Date.now() + 60_000;

	while (Date.now() < deadline) {
		const gone = exited();
		if (gone) throw new Error(`the simulator exited before answering (code ${gone.code})`);

		try {
			const response = await fetch(`${url}/management/apiversions`, {
				signal: AbortSignal.timeout(2_000),
			});
			if (response.ok) return;
		} catch {
			// Still starting up.
		}

		await new Promise((wait) => setTimeout(wait, 250));
	}

	child.kill();
	throw new Error(`the simulator did not start listening on ${url} within 60s`);
}
