#!/usr/bin/env node
/**
 * Download the ASCOM Alpaca Simulators ("OmniSim") for this machine.
 *
 * The simulators are the reference implementation of the Alpaca specification, so running the
 * integration tests against them catches anything our own fake is too forgiving about. The builds
 * are self-contained — no .NET runtime needed — and land in `.cache/`, which is git-ignored.
 *
 * Usage: node scripts/fetch-omnisim.mjs [--force]
 * Prints the path of the executable on the last line.
 */

import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

/** Pinned so a new upstream release cannot break CI without someone choosing to update it. */
const VERSION = "v0.5.0";
const RELEASE_URL = `https://github.com/ASCOMInitiative/ASCOM.Alpaca.Simulators/releases/download/${VERSION}`;

/** Self-contained builds, one per platform. */
const ASSETS = {
	"win32-x64": "ascom.alpaca.simulators.windows-x64.zip",
	"win32-ia32": "ascom.alpaca.simulators.windows-x86.zip",
	"darwin-arm64": "ascom.alpaca.simulators.macos-arm64.zip",
	"darwin-x64": "ascom.alpaca.simulators.macos-x64.zip",
	"linux-x64": "ascom.alpaca.simulators.linux-x64.tar.xz",
	"linux-arm64": "ascom.alpaca.simulators.linux-aarch64.tar.xz",
	"linux-arm": "ascom.alpaca.simulators.linux-armhf.tar.xz",
};

const EXECUTABLE =
	process.platform === "win32" ? "ascom.alpaca.simulators.exe" : "ascom.alpaca.simulators";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const cacheDir = join(projectRoot, ".cache", "omnisim", VERSION);
/** Written after a successful download so the tests can find the binary without guessing. */
export const manifestPath = join(projectRoot, ".cache", "omnisim", "current.json");

/** Where the executable ends up, once extracted. */
export async function findExecutable(root = cacheDir) {
	const direct = join(root, EXECUTABLE);
	if (await exists(direct)) return direct;

	// The macOS and Windows archives put everything one directory down.
	for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
		if (!entry.isDirectory()) continue;
		const nested = await findExecutable(join(root, entry.name));
		if (nested) return nested;
	}
	return undefined;
}

async function exists(path) {
	return stat(path).then(
		() => true,
		() => false,
	);
}

/** bsdtar reads zip and tar.xz alike; GNU tar (Git Bash, Linux) reads only the tarballs. */
function extractorFor(archive, destination) {
	const isZip = archive.endsWith(".zip");

	if (process.platform === "win32" && isZip) {
		// The tar on PATH in Git Bash is GNU tar, which cannot read zip — go straight to bsdtar.
		const bsdtar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
		return { command: bsdtar, args: ["-xf", archive, "-C", destination] };
	}

	return { command: "tar", args: ["-xf", archive, "-C", destination] };
}

async function download(url, destination) {
	process.stderr.write(`downloading ${url}\n`);
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok || !response.body) {
		throw new Error(`download failed: HTTP ${response.status} ${response.statusText}`);
	}

	await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
	const { size } = await stat(destination);
	process.stderr.write(`downloaded ${(size / 1e6).toFixed(1)} MB\n`);
}

async function writeManifest(executable) {
	const manifest = JSON.stringify({ version: VERSION, executable }, null, 2);
	await writeFile(manifestPath, `${manifest}\n`);
}

async function main() {
	const force = process.argv.includes("--force");
	const platform = `${process.platform}-${process.arch}`;
	const asset = ASSETS[platform];

	if (!asset) {
		throw new Error(
			`no ASCOM simulator build for ${platform}. Supported: ${Object.keys(ASSETS).join(", ")}`,
		);
	}

	if (force) await rm(cacheDir, { recursive: true, force: true });

	const existing = await findExecutable();
	if (existing) {
		process.stderr.write(`already downloaded (${VERSION})\n`);
		await writeManifest(existing);
		console.log(existing);
		return;
	}

	await mkdir(cacheDir, { recursive: true });
	const archive = join(cacheDir, asset);
	await download(`${RELEASE_URL}/${asset}`, archive);

	const { command, args } = extractorFor(archive, cacheDir);
	process.stderr.write(`extracting with ${command}\n`);
	const extraction = spawnSync(command, args, { stdio: "inherit" });
	if (extraction.error) throw extraction.error;
	if (extraction.status !== 0)
		throw new Error(`extraction failed with status ${extraction.status}`);

	await rm(archive, { force: true });

	const executable = await findExecutable();
	if (!executable) throw new Error(`extracted archive did not contain ${EXECUTABLE}`);

	if (process.platform !== "win32") {
		await chmod(executable, 0o755);
	}
	if (process.platform === "darwin") {
		// Downloaded archives are quarantined by Gatekeeper, which refuses to launch them.
		spawnSync("xattr", ["-dr", "com.apple.quarantine", cacheDir], { stdio: "ignore" });
	}

	// --set-no-browser writes the setting and exits; without it every later start opens a browser.
	process.stderr.write("disabling the auto-start browser\n");
	spawnSync(executable, ["--set-no-browser"], { stdio: "ignore", timeout: 60_000 });

	await writeManifest(executable);
	process.stderr.write(`ready: ${VERSION}\n`);
	console.log(executable);
}

// Only run when invoked directly; the test harness imports findExecutable instead.
if (
	process.argv[1] &&
	import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())
) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
}
