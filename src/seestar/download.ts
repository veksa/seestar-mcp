import { createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Pulling files off the telescope.
 *
 * The Seestar serves what it has captured over plain HTTP, so this is an ordinary download — with
 * the parts that matter over a wireless link to a battery-powered device: skip what is already
 * here, do not hammer it with parallel requests, and never leave a half-written file behind that a
 * later run would mistake for a finished one.
 */

export interface DownloadItem {
	url: string;
	/** Absolute path to write to. */
	destination: string;
}

export interface DownloadOutcome {
	url: string;
	destination: string;
	status: "downloaded" | "skipped" | "failed";
	bytes?: number;
	error?: string;
}

export interface DownloadOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	/** How many files at a time. The telescope is a small computer on a battery. */
	concurrency?: number;
	fetch?: typeof globalThis.fetch;
}

export async function downloadFiles(
	items: DownloadItem[],
	options: DownloadOptions = {},
): Promise<DownloadOutcome[]> {
	const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, 8));
	const outcomes: DownloadOutcome[] = new Array(items.length);
	let next = 0;

	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const index = next++;
			const item = items[index];
			if (!item) return;
			if (options.signal?.aborted) {
				outcomes[index] = { ...item, status: "failed", error: "cancelled" };
				continue;
			}
			outcomes[index] = await downloadOne(item, options);
		}
	};

	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
	return outcomes;
}

async function downloadOne(item: DownloadItem, options: DownloadOptions): Promise<DownloadOutcome> {
	const existing = await stat(item.destination).catch(() => undefined);
	if (existing && existing.size > 0) {
		return { ...item, status: "skipped", bytes: existing.size };
	}

	const fetchImpl = options.fetch ?? globalThis.fetch;
	// A file left half-written by an interrupted run must not look like a complete one.
	const temporary = `${item.destination}.partial`;

	try {
		await mkdir(dirname(item.destination), { recursive: true });

		const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000);
		const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
		const response = await fetchImpl(item.url, { signal });

		if (!response.ok || !response.body) {
			throw new Error(`HTTP ${response.status} ${response.statusText}`);
		}

		await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
		const { size } = await stat(temporary);
		const { rename } = await import("node:fs/promises");
		await rename(temporary, item.destination);

		return { ...item, status: "downloaded", bytes: size };
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		return {
			...item,
			status: "failed",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export interface DownloadSummary {
	downloaded: number;
	skipped: number;
	failed: number;
	bytes: number;
}

export function summarise(outcomes: DownloadOutcome[]): DownloadSummary {
	return {
		downloaded: outcomes.filter((outcome) => outcome.status === "downloaded").length,
		skipped: outcomes.filter((outcome) => outcome.status === "skipped").length,
		failed: outcomes.filter((outcome) => outcome.status === "failed").length,
		bytes: outcomes.reduce(
			(total, outcome) => total + (outcome.status === "downloaded" ? (outcome.bytes ?? 0) : 0),
			0,
		),
	};
}
