import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	formatDeclination,
	formatDuration,
	formatFields,
	formatRightAscension,
} from "../format.js";
import { errorResult, guard, textResult } from "../tools/result.js";
import { sessionPaths } from "../workdir.js";
import type { ProcessingConfig } from "./config.js";
import { type FrameInfo, isCfa } from "./fits.js";
import { distinct, inspectDirectory, listSessions } from "./sessions.js";

/** Tools that look at what is on disk: which sessions exist, and what is in them. */
export function registerSessionTools(server: McpServer, config: ProcessingConfig): void {
	server.registerTool(
		"session_list",
		{
			title: "Sessions on this computer",
			description:
				"List the imaging sessions in the working directory: how many frames each holds and " +
				"when it was last touched. These are the directories the telescope side downloads into.",
			inputSchema: z.object({}),
			outputSchema: z.object({
				work_dir: z.string(),
				sessions: z.array(
					z.object({
						name: z.string(),
						path: z.string(),
						fits_files: z.number(),
						image_files: z.number(),
						size_mb: z.number(),
						modified: z.string().optional(),
					}),
				),
			}),
			annotations: { readOnlyHint: true },
		},
		async () =>
			guard(async () => {
				const sessions = await listSessions(config.workDir);

				if (sessions.length === 0) {
					return textResult(
						`No sessions in ${config.workDir}.\n\n` +
							"Download some frames with the telescope server (imaging_download), or point this " +
							"server at another directory with --work-dir.",
						{ work_dir: config.workDir, sessions: [] },
					);
				}

				const lines = sessions.map((entry) => {
					const parts = [
						`${entry.fitsFiles} FITS`,
						entry.imageFiles > 0 ? `${entry.imageFiles} images` : "",
						`${(entry.sizeBytes / 1e6).toFixed(1)} MB`,
						entry.modified ? entry.modified.toISOString().slice(0, 16).replace("T", " ") : "",
					].filter(Boolean);
					return `${entry.name}  —  ${parts.join(", ")}`;
				});

				return textResult([`Sessions in ${config.workDir}:`, "", ...lines].join("\n"), {
					work_dir: config.workDir,
					sessions: sessions.map((entry) => ({
						name: entry.name,
						path: entry.path,
						fits_files: entry.fitsFiles,
						image_files: entry.imageFiles,
						size_mb: Number((entry.sizeBytes / 1e6).toFixed(1)),
						...(entry.modified ? { modified: entry.modified.toISOString() } : {}),
					})),
				});
			}),
	);

	server.registerTool(
		"astro_inspect",
		{
			title: "What is in a session",
			description:
				"Read the FITS headers of a session's frames: target, exposure, gain, filter, sensor " +
				"temperature and total integration time. Reads headers only, so it is fast even on " +
				"hundreds of frames, and needs no Siril.",
			inputSchema: z.object({
				session: z
					.string()
					.optional()
					.describe("Session name, as listed by session_list. Omit to inspect a path instead."),
				path: z.string().optional().describe("A directory to inspect, instead of a session"),
				limit: z
					.number()
					.int()
					.min(1)
					.max(5000)
					.optional()
					.describe("Read at most this many frames. Default: all of them."),
			}),
			outputSchema: z.object({
				directory: z.string(),
				frames: z.number(),
				unreadable: z.number(),
				image_files: z.number(),
				size_mb: z.number(),
				object: z.string().optional(),
				exposure_seconds: z.array(z.number()).optional(),
				gains: z.array(z.number()).optional(),
				bayer_pattern: z.string().optional(),
				filters: z.array(z.string()).optional(),
				integration_seconds: z.number().optional(),
			}),
			annotations: { readOnlyHint: true },
		},
		async ({ session, path, limit }) =>
			guard(async () => {
				if (!session && !path) {
					return errorResult(
						"Give either a session name or a path. session_list shows what exists.",
					);
				}

				const directory = path ?? sessionPaths(config.workDir, session as string).root;
				const summary = await inspectDirectory(directory, limit ? { limit } : {});

				if (summary.frames.length === 0 && summary.unreadable.length === 0) {
					return textResult(
						`No FITS frames in ${directory}.` +
							(summary.imageFiles > 0
								? `\n\nThere are ${summary.imageFiles} JPEG/PNG files — the Seestar saves individual ` +
									'frames only when "Save each frame" is switched on in its app.'
								: ""),
						{
							directory,
							frames: 0,
							unreadable: summary.unreadable.length,
							image_files: summary.imageFiles,
							size_mb: Number((summary.totalBytes / 1e6).toFixed(1)),
						},
					);
				}

				const masters = summary.frames.filter((frame) => frame.isMaster);
				const allMasters = masters.length === summary.frames.length && masters.length > 0;
				const objects = distinct(summary.frames, (frame) => frame.object).filter(
					(name) => name.toLowerCase() !== "unknown",
				);
				const exposures = distinct(summary.frames, (frame) => frame.exposureSeconds);
				const gains = distinct(summary.frames, (frame) => frame.gain);
				const filters = distinct(summary.frames, (frame) => frame.filter);
				const bayer = distinct(summary.frames, (frame) =>
					isCfa(frame) ? frame.bayerPattern : undefined,
				);
				const integration = totalIntegration(summary.frames);

				const text = [
					formatFields([
						["directory", directory],
						["frames", `${summary.frames.length}`],
						["target", objects.join(", ") || undefined],
						[
							"exposure",
							// Shown as "sub exposure" below when these are masters; no need to say it twice.
							!allMasters && exposures.length > 0 ? `${exposures.join("s, ")}s` : undefined,
						],
						[
							// On a master, EXPTIME is the exposure of one sub-frame, so adding them up
							// across masters would report minutes for what is really hours.
							allMasters ? "sub exposure" : "integration",
							integration > 0
								? allMasters
									? `${exposures.join("s, ")}s per sub-frame`
									: `${formatDuration(integration)} (${summary.frames.length} frames)`
								: undefined,
						],
						["image type", allMasters ? "stacked masters — already integrated" : undefined],
						["coordinates", coordinates(summary.frames)],
						["gain", gains.length > 0 ? gains.join(", ") : undefined],
						["filter", filters.join(", ") || undefined],
						["size", `${(summary.totalBytes / 1e6).toFixed(1)} MB`],
						["temperature", temperatureRange(summary.frames)],
						["dimensions", dimensions(summary.frames)],
						[
							"sensor",
							bayer.length > 0
								? `one-shot colour, Bayer ${bayer.join(", ")} — demosaiced while stacking`
								: undefined,
						],
					]),
					exposures.length > 1
						? "\nThe exposure changed during this session — Siril stacks mixed exposures badly, so consider splitting them."
						: "",
					summary.unreadable.length > 0
						? `\n${summary.unreadable.length} file(s) could not be read:\n${summary.unreadable
								.slice(0, 3)
								.map((entry) => `  ${entry.path}: ${entry.reason}`)
								.join("\n")}`
						: "",
				]
					.filter(Boolean)
					.join("\n");

				return textResult(text, {
					directory,
					frames: summary.frames.length,
					unreadable: summary.unreadable.length,
					image_files: summary.imageFiles,
					size_mb: Number((summary.totalBytes / 1e6).toFixed(1)),
					...(objects[0] !== undefined ? { object: objects[0] } : {}),
					...(allMasters ? { masters: true } : {}),
					...(exposures.length > 0 ? { exposure_seconds: exposures } : {}),
					...(gains.length > 0 ? { gains } : {}),
					...(bayer[0] !== undefined ? { bayer_pattern: bayer[0] } : {}),
					...(filters.length > 0 ? { filters } : {}),
					...(integration > 0 && !allMasters ? { integration_seconds: integration } : {}),
				});
			}),
	);
}

function totalIntegration(frames: FrameInfo[]): number {
	return frames.reduce((total, frame) => total + (frame.exposureSeconds ?? 0), 0);
}

/**
 * Where the frames point, in the sexagesimal form a person can look up.
 *
 * Worth showing because plenty of software writes OBJECT as "Unknown" while still recording a full
 * astrometric solution — the coordinates are then the only way to say what was imaged.
 */
function coordinates(frames: FrameInfo[]): string | undefined {
	const frame = frames.find(
		(candidate) =>
			candidate.rightAscensionDeg !== undefined && candidate.declinationDeg !== undefined,
	);
	if (!frame) return undefined;

	return `RA ${formatRightAscension((frame.rightAscensionDeg as number) / 15)}  Dec ${formatDeclination(frame.declinationDeg as number)}`;
}

function temperatureRange(frames: FrameInfo[]): string | undefined {
	const values = frames
		.map((frame) => frame.temperatureC)
		.filter((value): value is number => value !== undefined);
	if (values.length === 0) return undefined;

	const low = Math.min(...values);
	const high = Math.max(...values);
	return low === high ? `${low}°C` : `${low}°C to ${high}°C`;
}

function dimensions(frames: FrameInfo[]): string | undefined {
	const sizes = distinct(frames, (frame) =>
		frame.width && frame.height ? `${frame.width}x${frame.height}` : undefined,
	);
	return sizes.length > 0 ? sizes.join(", ") : undefined;
}
