import { readdir, realpath, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { type FrameInfo, isCfa, readFrameInfo } from "./fits.js";

/**
 * Reading what is on disk.
 *
 * A session is just a directory the telescope side filled with frames — see `src/workdir.ts` for
 * the layout. Nothing here talks to a telescope; it only looks at files.
 */

const FITS_EXTENSIONS = new Set([".fit", ".fits", ".fts"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".tif", ".tiff"]);

export interface SessionSummary {
	name: string;
	path: string;
	fitsFiles: number;
	imageFiles: number;
	sizeBytes: number;
	modified: Date | undefined;
}

export interface FrameFile {
	path: string;
	name: string;
	sizeBytes: number;
	kind: "fits" | "image" | "other";
}

/** Every session directory under the work directory, newest first. */
export async function listSessions(workDir: string): Promise<SessionSummary[]> {
	const entries = await readdir(workDir, { withFileTypes: true }).catch(() => []);
	const summaries: SessionSummary[] = [];

	for (const entry of entries) {
		const path = join(workDir, entry.name);
		// Same reason as listFiles: a session directory is allowed to be a link elsewhere.
		if (!entry.isDirectory() && !(await isLinkedDirectory(entry, path))) continue;
		const files = await listFiles(path);
		const modified = await newestModification(path);

		summaries.push({
			name: entry.name,
			path,
			fitsFiles: files.filter((file) => file.kind === "fits").length,
			imageFiles: files.filter((file) => file.kind === "image").length,
			sizeBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
			modified,
		});
	}

	return summaries.sort(
		(left, right) => (right.modified?.getTime() ?? 0) - (left.modified?.getTime() ?? 0),
	);
}

/**
 * Every file in a directory tree, classified. Follows subdirectories: raw/, process/ and so on.
 *
 * Symlinks are followed too, and a Windows junction is a symlink as far as `readdir` is concerned:
 * pointing raw/ at frames that live on another drive is ordinary once a session runs to hundreds of
 * gigabytes, and a walk that skipped them would report an empty session rather than an error. Each
 * directory is visited once, by its resolved path, so a link back up the tree cannot loop.
 */
export async function listFiles(root: string): Promise<FrameFile[]> {
	const files: FrameFile[] = [];
	const stack = [root];
	const visited = new Set<string>();

	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) break;

		const key = await realpath(current).catch(() => current);
		if (visited.has(key)) continue;
		visited.add(key);

		for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
			const path = join(current, entry.name);

			// A symlink needs stat() to say what it points at; readdir only reports the link itself.
			if (entry.isDirectory() || (await isLinkedDirectory(entry, path))) {
				stack.push(path);
				continue;
			}

			const size = await stat(path)
				.then((info) => info.size)
				.catch(() => 0);

			files.push({ path, name: entry.name, sizeBytes: size, kind: classify(entry.name) });
		}
	}

	return files.sort((left, right) => left.path.localeCompare(right.path));
}

/** Whether a directory entry is a symlink that resolves to a directory. */
async function isLinkedDirectory(
	entry: { isSymbolicLink(): boolean },
	path: string,
): Promise<boolean> {
	if (!entry.isSymbolicLink()) return false;
	return stat(path)
		.then((info) => info.isDirectory())
		.catch(() => false);
}

export function classify(name: string): FrameFile["kind"] {
	const extension = extname(name).toLowerCase();
	if (FITS_EXTENSIONS.has(extension)) return "fits";
	if (IMAGE_EXTENSIONS.has(extension)) return "image";
	return "other";
}

export interface InspectionSummary {
	directory: string;
	frames: FrameInfo[];
	/** Frames that could not be read, with the reason. */
	unreadable: Array<{ path: string; reason: string }>;
	imageFiles: number;
	totalBytes: number;
}

/**
 * Read the headers of every FITS frame in a directory.
 *
 * Only headers, so this stays fast even on a session of several hundred frames — enough to answer
 * what was shot, for how long, at what gain, and whether the settings changed part-way through.
 */
export async function inspectDirectory(
	directory: string,
	options: { limit?: number } = {},
): Promise<InspectionSummary> {
	const files = await listFiles(directory);
	const fits = files.filter((file) => file.kind === "fits");
	const selected = options.limit ? fits.slice(0, options.limit) : fits;

	const frames: FrameInfo[] = [];
	const unreadable: Array<{ path: string; reason: string }> = [];

	for (const file of selected) {
		try {
			frames.push(await readFrameInfo(file.path));
		} catch (error) {
			unreadable.push({
				path: file.path,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return {
		directory,
		frames,
		unreadable,
		imageFiles: files.filter((file) => file.kind === "image").length,
		totalBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
	};
}

/**
 * The Bayer pattern the frames in a directory carry, or undefined when they carry none.
 *
 * Only the first frame that can be read decides — a session is one camera shooting one way, and
 * opening several hundred headers to learn the same thing over and over would be waste. A few
 * attempts, in case the first file is truncated.
 */
export async function detectBayerPattern(directory: string): Promise<string | undefined> {
	const files = await listFiles(directory);

	for (const file of files.filter((entry) => entry.kind === "fits").slice(0, 5)) {
		const frame = await readFrameInfo(file.path).catch(() => undefined);
		if (!frame) continue;
		return isCfa(frame) ? frame.bayerPattern : undefined;
	}

	return undefined;
}

/** The distinct values of one field across a set of frames, most common first. */
export function distinct<T>(frames: FrameInfo[], read: (frame: FrameInfo) => T | undefined): T[] {
	const counts = new Map<T, number>();
	for (const frame of frames) {
		const value = read(frame);
		if (value === undefined) continue;
		counts.set(value, (counts.get(value) ?? 0) + 1);
	}
	return [...counts.entries()].sort((left, right) => right[1] - left[1]).map(([value]) => value);
}

async function newestModification(root: string): Promise<Date | undefined> {
	const files = await listFiles(root);
	let newest: Date | undefined;

	for (const file of files) {
		const info = await stat(file.path).catch(() => undefined);
		if (info && (!newest || info.mtime > newest)) newest = info.mtime;
	}

	return newest;
}
