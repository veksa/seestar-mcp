import { readFile } from "node:fs/promises";

/**
 * Long-running work.
 *
 * Stacking two hundred frames takes minutes, denoising can take longer, and an MCP call cannot sit
 * there holding the line — the model would time out or, worse, block. So every heavy tool starts a
 * job, gets an id back immediately, and progress is followed with `astro_job`. The same shape as
 * `seestar_events` on the telescope side: poll, do not wait.
 */

export type JobStatus = "running" | "done" | "failed" | "cancelled";

export interface Job {
	id: string;
	/** What it is doing, e.g. "stack M31". */
	name: string;
	status: JobStatus;
	startedAt: Date;
	endedAt?: Date;
	logPath: string;
	/** Set when the job finished successfully. */
	result?: Record<string, unknown>;
	error?: string;
	/** The last lines of output, kept so a status call needs no file read. */
	tail: string[];
}

export interface JobContext {
	signal: AbortSignal;
	/** Record a line for the tail shown by `astro_job`. */
	line: (text: string) => void;
}

export interface JobSpec {
	name: string;
	logPath: string;
	run: (context: JobContext) => Promise<Record<string, unknown>>;
}

const TAIL_LINES = 40;

/** Jobs live in memory for the life of the server; their logs live on disk. */
export class JobStore {
	private readonly jobs = new Map<string, Job>();
	private readonly controllers = new Map<string, AbortController>();
	private readonly finished = new Map<string, Promise<Job>>();
	private counter = 0;

	start(spec: JobSpec): Job {
		const id = `job-${++this.counter}`;
		const controller = new AbortController();
		const job: Job = {
			id,
			name: spec.name,
			status: "running",
			startedAt: new Date(),
			logPath: spec.logPath,
			tail: [],
		};

		this.jobs.set(id, job);
		this.controllers.set(id, controller);

		const promise = spec
			.run({
				signal: controller.signal,
				line: (text) => {
					job.tail.push(text);
					if (job.tail.length > TAIL_LINES) job.tail.shift();
				},
			})
			.then((result) => {
				job.status = controller.signal.aborted ? "cancelled" : "done";
				job.result = result;
				job.endedAt = new Date();
				return job;
			})
			.catch((error: unknown) => {
				job.status = controller.signal.aborted ? "cancelled" : "failed";
				job.error = error instanceof Error ? error.message : String(error);
				job.endedAt = new Date();
				return job;
			});

		this.finished.set(id, promise);
		return job;
	}

	get(id: string): Job | undefined {
		return this.jobs.get(id);
	}

	/** Newest first — the one just started is almost always the one being asked about. */
	list(): Job[] {
		return [...this.jobs.values()].sort(
			(left, right) => right.startedAt.getTime() - left.startedAt.getTime(),
		);
	}

	/** Wait for a job to finish, or give up after `timeoutMs` and leave it running. */
	async wait(id: string, timeoutMs: number): Promise<Job | undefined> {
		const promise = this.finished.get(id);
		if (!promise) return undefined;

		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<undefined>((resolve) => {
			timer = setTimeout(() => resolve(undefined), timeoutMs);
		});

		try {
			return (await Promise.race([promise, timeout])) ?? this.jobs.get(id);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	cancel(id: string): boolean {
		const controller = this.controllers.get(id);
		const job = this.jobs.get(id);
		if (!controller || !job || job.status !== "running") return false;

		controller.abort();
		return true;
	}

	/** The tail of a job's log, read from disk — more than the in-memory tail keeps. */
	async readLog(id: string, lines: number): Promise<string[]> {
		const job = this.jobs.get(id);
		if (!job) return [];

		const text = await readFile(job.logPath, "utf8").catch(() => "");
		return text.split(/\r?\n/).filter(Boolean).slice(-lines);
	}
}

export function describeJob(job: Job): Record<string, unknown> {
	return {
		id: job.id,
		name: job.name,
		status: job.status,
		started_at: job.startedAt.toISOString(),
		...(job.endedAt ? { ended_at: job.endedAt.toISOString() } : {}),
		...(job.endedAt
			? { duration_seconds: Math.round((job.endedAt.getTime() - job.startedAt.getTime()) / 1000) }
			: {}),
		log_path: job.logPath,
		...(job.error ? { error: job.error } : {}),
		...(job.result ? { result: job.result } : {}),
	};
}
