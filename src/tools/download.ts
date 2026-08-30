import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AlbumFile } from "../seestar/albums.js";
import { fileUrl } from "../seestar/albums.js";
import { downloadFiles, summarise } from "../seestar/download.js";
import type { Session } from "../session.js";
import { sessionPaths } from "../workdir.js";
import { errorResult, guard, textResult } from "./result.js";

/**
 * Getting the captured frames onto the computer.
 *
 * This lives on the telescope side rather than with the processing tools: it is the telescope that
 * knows what it captured and where it serves it from. What the processing server sees is only a
 * directory of files — that is the whole interface between the two halves.
 */
export function registerDownloadTools(server: McpServer, session: Session): void {
	server.registerTool(
		"imaging_albums",
		{
			title: "What the telescope has stored",
			description:
				"List the albums on the telescope and how many files each holds. Every imaging session " +
				"creates one, named after the target.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async () =>
			guard(async () => {
				const listing = await session.seestar().albums();
				if (listing.albums.length === 0) {
					return textResult("The telescope has no albums yet — nothing has been captured.");
				}

				const lines = listing.albums.map((album, index) => {
					const stacked = album.files.filter((file) => !file.isSubframe).length;
					const subs = album.files.length - stacked;
					return `${index + 1}. ${album.name ?? "(unnamed)"} — ${stacked} result${stacked === 1 ? "" : "s"}, ${subs} sub-frame${subs === 1 ? "" : "s"}`;
				});

				return textResult([`Albums under ${listing.parentPath}:`, "", ...lines].join("\n"), {
					parent_path: listing.parentPath,
					albums: listing.albums.map((album) => ({
						name: album.name ?? null,
						files: album.files.length,
						subframes: album.files.filter((file) => file.isSubframe).length,
					})),
				});
			}),
	);

	if (session.config.readOnly) return;

	server.registerTool(
		"imaging_download",
		{
			title: "Download frames from the telescope",
			description:
				"Copy captured files off the telescope into a session directory on this computer, ready " +
				"for processing. Files already downloaded are skipped, so it is safe to run again while " +
				"a session is still going.",
			inputSchema: z.object({
				album: z
					.string()
					.optional()
					.describe("Album name, as listed by imaging_albums. Defaults to the first one."),
				session_name: z
					.string()
					.optional()
					.describe("Directory to download into. Defaults to the album name."),
				include_subframes: z
					.boolean()
					.optional()
					.describe(
						"Include the individual sub-frames, not just the stacked result. Default true.",
					),
				thumbnails: z
					.boolean()
					.optional()
					.describe("Download the small previews instead of the full images. Default false."),
				limit: z
					.number()
					.int()
					.min(1)
					.max(2000)
					.optional()
					.describe("Stop after this many files. Useful for a first look."),
				dry_run: z
					.boolean()
					.optional()
					.describe("List what would be downloaded, without downloading anything."),
			}),
			outputSchema: z.object({
				session: z.string(),
				directory: z.string(),
				planned: z.number(),
				downloaded: z.number().optional(),
				skipped: z.number().optional(),
				failed: z.number().optional(),
				bytes: z.number().optional(),
			}),
		},
		async (input) =>
			guard(async () => {
				const target = session.requireTarget();
				const seestar = session.seestar();
				const listing = await seestar.albums();

				const album = input.album
					? listing.albums.find((entry) => entry.name === input.album)
					: listing.albums[0];

				if (!album) {
					// A tool with an output schema must always return structured content unless it
					// reports an error — and asking for an album that is not there is an error.
					const names = listing.albums.map((entry) => entry.name ?? "(unnamed)").join(", ");
					return errorResult(
						input.album
							? `No album called "${input.album}". Available: ${names || "none"}.`
							: "The telescope has no albums yet — nothing has been captured.",
					);
				}

				const wanted = album.files.filter(
					(file) => input.include_subframes !== false || !file.isSubframe,
				);
				const selected = input.limit ? wanted.slice(0, input.limit) : wanted;

				const sessionName = input.session_name ?? album.name ?? "session";
				const paths = sessionPaths(session.config.workDir, sessionName);
				const baseUrl = await seestar.imageBaseUrl(target.host);

				const items = selected.map((file) => ({
					url: fileUrl(baseUrl, listing.parentPath, pathFor(file, input.thumbnails === true)),
					destination: `${paths.raw}/${fileNameFor(file, input.thumbnails === true)}`,
				}));

				const structured = {
					session: paths.name,
					directory: paths.raw,
					planned: items.length,
				};

				if (input.dry_run) {
					const preview = items.slice(0, 10).map((item) => `  ${item.url}`);
					return textResult(
						[
							`Would download ${items.length} file${items.length === 1 ? "" : "s"} into ${paths.raw}:`,
							...preview,
							items.length > preview.length ? `  … and ${items.length - preview.length} more` : "",
						]
							.filter(Boolean)
							.join("\n"),
						structured,
					);
				}

				const outcomes = await downloadFiles(items, { timeoutMs: session.config.timeoutMs * 6 });
				const summary = summarise(outcomes);
				const failures = outcomes.filter((outcome) => outcome.status === "failed").slice(0, 5);

				const text = [
					`${summary.downloaded} downloaded, ${summary.skipped} already there, ${summary.failed} failed.`,
					`Directory: ${paths.raw}`,
					summary.bytes > 0 ? `${(summary.bytes / 1e6).toFixed(1)} MB transferred.` : "",
					failures.length > 0
						? `\nFailures:\n${failures.map((failure) => `  ${failure.url}: ${failure.error}`).join("\n")}`
						: "",
					summary.downloaded + summary.skipped > 0
						? "\nProcess them with astro-mcp: astro_inspect, then the pipeline tools."
						: "",
				]
					.filter(Boolean)
					.join("\n");

				return textResult(text, { ...structured, ...summary });
			}),
	);
}

function pathFor(file: AlbumFile, thumbnail: boolean): string {
	return thumbnail ? file.thumbnailPath : file.imagePath;
}

function fileNameFor(file: AlbumFile, thumbnail: boolean): string {
	const path = pathFor(file, thumbnail);
	return path.split("/").pop() ?? file.name;
}
