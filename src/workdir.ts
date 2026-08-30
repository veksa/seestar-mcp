import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Where sessions live on disk.
 *
 * The one thing the telescope server and the processing server have to agree on: one downloads
 * frames into a session directory, the other reads them from it. A path convention rather than a
 * code dependency, so the two halves stay independent.
 *
 *   <work dir>/<session>/raw/       frames as they came off the telescope
 *   <work dir>/<session>/process/   intermediate files
 *   <work dir>/<session>/logs/      output of each external program
 */

export const SESSION_DIRECTORIES = ["raw", "process", "logs"] as const;

export function defaultWorkDir(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.ASTRO_WORK_DIR ?? join(homedir(), "astro"));
}

export interface SessionPaths {
	name: string;
	root: string;
	raw: string;
	process: string;
	logs: string;
}

export function sessionPaths(workDir: string, name: string): SessionPaths {
	const root = join(workDir, sanitizeSessionName(name));
	return {
		name: sanitizeSessionName(name),
		root,
		raw: join(root, "raw"),
		process: join(root, "process"),
		logs: join(root, "logs"),
	};
}

/**
 * Keep a session name to something safe for a directory.
 *
 * Names come from target names the model picked ("M 31", "NGC 7000 / North America"), so path
 * separators and the rest have to go — a session name must never be able to escape the work
 * directory.
 */
export function sanitizeSessionName(name: string): string {
	const cleaned = name
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}._-]+/gu, "_")
		.replace(/^[._]+/, "")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "")
		.slice(0, 80);

	if (cleaned === "" || cleaned === "." || cleaned === "..") {
		throw new Error(`"${name}" is not usable as a session name`);
	}
	return cleaned;
}
