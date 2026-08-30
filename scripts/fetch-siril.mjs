#!/usr/bin/env node
/**
 * Download Siril for this machine, without installing it system-wide.
 *
 * Siril is the engine behind every processing tool here, and it is not something we can vendor: it
 * is a 70-160 MB native application. This fetches the portable build into `.cache/`, so tests and
 * CI have a real Siril, and so anyone can try the processing tools without running an installer.
 *
 * Usage:
 *   node scripts/fetch-siril.mjs               # newest release, as published by the project
 *   node scripts/fetch-siril.mjs --version 1.4.4
 *   node scripts/fetch-siril.mjs --force
 *
 * Prints the path of `siril-cli` on the last line.
 */

import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

/** Used when the release API cannot be reached; the newest version at the time of writing. */
const FALLBACK_VERSION = "1.4.4";
const RELEASES_API = "https://gitlab.com/api/v4/projects/free-astro%2Fsiril/releases?per_page=1";
const DOWNLOAD_BASE = "https://free-astro.org/download";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cacheRoot = join(projectRoot, ".cache", "siril");
const manifestPath = join(cacheRoot, "current.json");

/** What to download, and where `siril-cli` sits once it is unpacked. */
function artifactFor(platform, arch, version) {
	if (platform === "win32") {
		// The portable zip: unpack anywhere and run bin/siril-cli.exe. No installer, no registry.
		return {
			file: `siril-${version}-ucrt64_win.zip`,
			executable: join("siril", "bin", "siril-cli.exe"),
			kind: "zip",
		};
	}

	if (platform === "darwin") {
		const suffix = arch === "arm64" ? "arm64-3" : "x86_64-3";
		return {
			file: `siril-${version}-${suffix}.dmg`,
			executable: join("Siril.app", "Contents", "MacOS", "siril-cli"),
			kind: "dmg",
		};
	}

	if (platform === "linux" && arch === "x64") {
		return {
			file: `Siril-${version}-x86_64.AppImage`,
			executable: join("squashfs-root", "usr", "bin", "siril-cli"),
			kind: "appimage",
		};
	}

	return undefined;
}

async function latestVersion() {
	try {
		const response = await fetch(RELEASES_API, { signal: AbortSignal.timeout(15_000) });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const [release] = await response.json();
		const tag = String(release?.tag_name ?? "").trim();
		if (/^\d+\.\d+(\.\d+)?$/.test(tag)) return tag;
		throw new Error(`unexpected tag "${tag}"`);
	} catch (error) {
		process.stderr.write(
			`could not read the release list (${error instanceof Error ? error.message : error}); ` +
				`falling back to ${FALLBACK_VERSION}\n`,
		);
		return FALLBACK_VERSION;
	}
}

async function exists(path) {
	return stat(path).then(
		() => true,
		() => false,
	);
}

async function download(url, destination) {
	process.stderr.write(`downloading ${url}\n`);
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok || !response.body) {
		throw new Error(`download failed: HTTP ${response.status} ${response.statusText}`);
	}

	await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
	const { size } = await stat(destination);
	process.stderr.write(`downloaded ${(size / 1e6).toFixed(0)} MB\n`);
}

function runOrThrow(command, args, options = {}) {
	const result = spawnSync(command, args, { stdio: "inherit", ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${command} exited with status ${result.status}`);
	}
}

async function unpack(kind, archive, destination) {
	if (kind === "zip") {
		// GNU tar (Git Bash) cannot read zip; bsdtar ships with Windows and can.
		const bsdtar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
		const tar = process.platform === "win32" ? bsdtar : "tar";
		runOrThrow(tar, ["-xf", archive, "-C", destination]);
		return;
	}

	if (kind === "appimage") {
		// --appimage-extract unpacks without FUSE, which CI containers do not have.
		await chmod(archive, 0o755);
		runOrThrow(archive, ["--appimage-extract"], { cwd: destination, stdio: "ignore" });
		return;
	}

	if (kind === "dmg") {
		const mountPoint = join(destination, "mnt");
		await mkdir(mountPoint, { recursive: true });
		runOrThrow("hdiutil", ["attach", archive, "-nobrowse", "-readonly", "-mountpoint", mountPoint]);
		try {
			runOrThrow("cp", ["-R", join(mountPoint, "Siril.app"), destination]);
		} finally {
			spawnSync("hdiutil", ["detach", mountPoint], { stdio: "ignore" });
		}
		return;
	}

	throw new Error(`no idea how to unpack ${kind}`);
}

/** The layout inside the Windows zip has changed between releases; look around before giving up. */
async function locateExecutable(root, expected) {
	const direct = join(root, expected);
	if (await exists(direct)) return direct;

	const name = expected.split(/[\\/]/).pop();
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) break;
		for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) stack.push(path);
			else if (entry.name === name) return path;
		}
	}

	return undefined;
}

async function main() {
	const argv = process.argv.slice(2);
	const force = argv.includes("--force");
	const versionFlag = argv.indexOf("--version");
	const version = versionFlag === -1 ? await latestVersion() : argv[versionFlag + 1];
	if (!version) throw new Error("--version needs a value");

	const artifact = artifactFor(process.platform, process.arch, version);
	if (!artifact) {
		throw new Error(
			`no portable Siril build for ${process.platform}-${process.arch}. ` +
				"Install it from https://siril.org/download/ and set SIRIL_PATH.",
		);
	}

	const versionDir = join(cacheRoot, version);
	if (force) await rm(versionDir, { recursive: true, force: true });

	let executable = await locateExecutable(versionDir, artifact.executable);
	if (!executable) {
		await mkdir(versionDir, { recursive: true });
		const archive = join(versionDir, artifact.file);
		if (!(await exists(archive))) {
			await download(`${DOWNLOAD_BASE}/${artifact.file}`, archive);
		}

		process.stderr.write(`unpacking ${artifact.file}\n`);
		await unpack(artifact.kind, archive, versionDir);
		await rm(archive, { force: true });

		executable = await locateExecutable(versionDir, artifact.executable);
		if (!executable) throw new Error(`unpacked archive has no ${artifact.executable}`);
	}

	if (process.platform !== "win32") await chmod(executable, 0o755);
	if (process.platform === "linux") executable = await appImageLauncher(versionDir, executable);
	if (process.platform === "darwin") {
		// Downloads are quarantined by Gatekeeper, which refuses to launch them.
		spawnSync("xattr", ["-dr", "com.apple.quarantine", versionDir], { stdio: "ignore" });
	}

	await writeFile(manifestPath, `${JSON.stringify({ version, executable }, null, 2)}\n`);
	process.stderr.write(`ready: Siril ${version}\n`);
	console.log(executable);
}

/**
 * A launcher that puts the AppImage's own libraries back on the loader's path.
 *
 * `--appimage-extract` gives a directory tree but not the environment the AppImage would have run
 * in: normally its `AppRun` script points the dynamic loader at the libraries bundled beside the
 * binary. Executing `usr/bin/siril-cli` straight out of that tree skips it, and Siril dies on the
 * first bundled library it needs — `libfftw3f_omp.so.3` on a stock GitHub runner. Rather than ask
 * every caller to set `LD_LIBRARY_PATH`, the manifest points at a script that sets it.
 */
async function appImageLauncher(versionDir, executable) {
	// .../squashfs-root/usr/bin/siril-cli -> .../squashfs-root
	const appDir = dirname(dirname(dirname(executable)));
	const libraries = [
		join(appDir, "usr", "lib"),
		join(appDir, "usr", "lib", "x86_64-linux-gnu"),
		join(appDir, "lib"),
	];

	const launcher = join(versionDir, "siril-cli");
	await writeFile(
		launcher,
		[
			"#!/bin/sh",
			"# Generated by scripts/fetch-siril.mjs — see appImageLauncher().",
			`LD_LIBRARY_PATH="${libraries.join(":")}\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"`,
			"export LD_LIBRARY_PATH",
			`exec "${executable}" "$@"`,
			"",
		].join("\n"),
	);
	await chmod(launcher, 0o755);

	return launcher;
}

const invokedDirectly =
	process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());

if (invokedDirectly) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
}

export { artifactFor, cacheRoot, latestVersion, manifestPath };
