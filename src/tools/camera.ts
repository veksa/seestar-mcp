import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Telescope } from "../alpaca/devices/telescope.js";
import { formatDeclination, formatRightAscension } from "../format.js";
import { findAstap, type PlateSolution, SolveError, solvePlane } from "../imaging/astap.js";
import { type CapturedFrame, captureFrame } from "../imaging/capture.js";
import { type CenterReport, centerOn } from "../imaging/center.js";
import { type Equatorial, type Equinox, equinoxOf, separationDegrees } from "../imaging/coords.js";
import { binnedLuminance } from "../imaging/frame.js";
import { previewPng } from "../imaging/preview.js";
import { type Session, SessionError } from "../session.js";
import { guard, type ToolContent, type ToolResult } from "./result.js";

/**
 * Taking frames and centring on a target through the standard Alpaca camera.
 *
 * This is what makes the Seestar's built-in server usable on its own: it offers a plain camera and
 * a plain mount, and the plate solving, file keeping and correction loop that the Seestar app does
 * on the telescope happen here instead.
 */

const CAMERA_HINT = "0 is the main (telephoto) camera; on an S50 Pro, 1 is the wide-angle one.";
const SLEW_TIMEOUT_MS = 180_000;
/** Let the mount settle after a slew before exposing. */
const SETTLE_MS = 1_500;

export function registerCameraTools(server: McpServer, session: Session): void {
	if (session.config.readOnly) return;

	server.registerTool(
		"camera_capture",
		{
			title: "Take a frame",
			description:
				"Take one exposure with an Alpaca camera, save it as FITS and show a stretched preview. " +
				"Use it to see what the telescope sees — sky, clouds, a wall — and to check focus or " +
				"exposure. Set solve to plate-solve the frame and report where it really points. Does " +
				"not move the telescope.",
			inputSchema: z.object({
				exposure_s: z.number().min(0.001).max(600).describe("Exposure in seconds"),
				gain: z.number().int().min(0).optional().describe("Camera gain; 80 suits a Seestar"),
				camera: z.number().int().min(0).optional().describe(`Camera number. ${CAMERA_HINT}`),
				name: z.string().min(1).optional().describe("Target name for the file, e.g. M45"),
				solve: z.boolean().optional().describe("Plate-solve the frame. Default false."),
				preview: z.boolean().optional().describe("Return a preview image. Default true."),
			}),
		},
		async ({ exposure_s, gain, camera, name, solve, preview }) =>
			guard(async () => {
				const mount = await optionalMount(session);
				const frame = await captureFrame(
					{
						exposureSeconds: exposure_s,
						gain,
						name: name ?? "capture",
						captureDir: captureDir(session),
					},
					{
						camera: session.camera(camera ?? 0),
						telescope: mount?.telescope,
						equinox: mount?.equinox,
					},
				);

				let solution: PlateSolution | undefined;
				let solveNote = "";
				if (solve) {
					try {
						solution = await solveFrame(session, frame, frame.pointing);
					} catch (error) {
						if (!(error instanceof SolveError)) throw error;
						solveNote = `\n\nPlate solve failed: ${error.message}`;
					}
				}

				const text = [
					`Saved ${frame.path}`,
					describeFrame(frame),
					...(solution ? [describeSolution(solution, frame.pointing)] : []),
				].join("\n\n");

				return withPreview(
					`${text}${solveNote}`,
					{
						path: frame.path,
						width: frame.image.width,
						height: frame.image.height,
						exposure_s,
						...(frame.gain !== undefined ? { gain: frame.gain } : {}),
						...(frame.pattern ? { bayer_pattern: frame.pattern } : {}),
						stats: frame.stats,
						...(solution ? { solution: structuredSolution(solution) } : {}),
					},
					preview === false ? undefined : frame,
				);
			}),
	);

	server.registerTool(
		"telescope_center",
		{
			title: "Go to a target and centre it",
			description:
				"Slew to a target, take a frame, plate-solve it, and correct until the target is " +
				"centred — the plate-solved goto the Seestar app does. Use this instead of " +
				"telescope_goto whenever the target has to end up in the frame: a plain goto on the " +
				"built-in server can be several degrees off. Coordinates are J2000, as in catalogues. " +
				"Needs the ASTAP plate solver.",
			inputSchema: z.object({
				ra: z.number().min(0).max(24).describe("Right ascension in HOURS (0-24), J2000"),
				dec: z.number().min(-90).max(90).describe("Declination in degrees, J2000"),
				name: z.string().min(1).optional().describe("Target name, used for the files"),
				tolerance_arcmin: z
					.number()
					.min(0.1)
					.max(120)
					.optional()
					.describe("Stop when the target is this close to the centre. Default 2."),
				max_attempts: z.number().int().min(1).max(6).optional().describe("Default 3"),
				exposure_s: z.number().min(0.1).max(60).optional().describe("Default 3"),
				gain: z.number().int().min(0).optional().describe("Default 80"),
				camera: z.number().int().min(0).optional().describe(`Default 0. ${CAMERA_HINT}`),
				search_radius_deg: z
					.number()
					.min(1)
					.max(180)
					.optional()
					.describe("How far from the mount's position the solver searches. Default 30."),
			}),
			annotations: { idempotentHint: false },
		},
		async (input) =>
			guard(async () => {
				const astap = await requireAstap(session);
				await session.beforeMovement();
				const telescope = session.telescope();
				const equinox = await mountEquinox(telescope);
				const cameraNumber = input.camera ?? 0;
				const name = input.name ?? "center";
				let lastFrame: CapturedFrame | undefined;

				const report = await centerOn(
					{ ra: input.ra, dec: input.dec },
					{
						toleranceArcmin: input.tolerance_arcmin ?? 2,
						maxAttempts: input.max_attempts ?? 3,
					},
					{
						equinox,
						slew: async (position) => {
							await session.beforeMovement();
							await telescope.slewToCoordinates(position.ra, position.dec);
							const settled = await telescope.waitForSlewComplete({ timeoutMs: SLEW_TIMEOUT_MS });
							if (!settled) {
								throw new SessionError(
									`The slew did not finish within ${SLEW_TIMEOUT_MS / 1000}s. Check ` +
										"telescope_status; telescope_abort stops it.",
								);
							}
							await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
						},
						sync: (position) => telescope.syncToCoordinates(position.ra, position.dec),
						mountPosition: async () => ({
							ra: await telescope.rightAscension(),
							dec: await telescope.declination(),
						}),
						captureAndSolve: async (hint) => {
							const frame = await captureFrame(
								{
									exposureSeconds: input.exposure_s ?? 3,
									gain: input.gain ?? 80,
									name,
									subdirectory: "center",
									captureDir: captureDir(session),
								},
								{ camera: session.camera(cameraNumber), telescope, equinox },
							);
							lastFrame = frame;
							try {
								const solution = await solvePlane(
									binnedLuminance(frame.image),
									{ hint, radiusDeg: input.search_radius_deg ?? 30 },
									astap,
								);
								return { solution, path: frame.path };
							} catch (error) {
								if (error instanceof SolveError) {
									throw new SessionError(
										`${error.message}\n\nThe frame is at ${frame.path}. ${unsolvedHint(frame)}`,
									);
								}
								throw error;
							}
						},
					},
				);

				return withPreview(
					renderCenterReport(report, name),
					structuredCenterReport(report),
					lastFrame,
				);
			}),
	);
}

/** The mount and its equinox, when the selected device is one; frames are stamped with it. */
async function optionalMount(
	session: Session,
): Promise<{ telescope: Telescope; equinox: Equinox } | undefined> {
	try {
		const telescope = session.telescope();
		return { telescope, equinox: await mountEquinox(telescope) };
	} catch {
		return undefined;
	}
}

async function mountEquinox(telescope: Telescope): Promise<Equinox> {
	const system = await telescope.get<number>("equatorialsystem").catch(() => undefined);
	return equinoxOf(system);
}

function captureDir(session: Session): string {
	return session.config.captureDir ?? join(session.config.workDir, "captures");
}

async function requireAstap(session: Session) {
	const found = await findAstap(session.config.astapPath);
	if (!found.path) {
		throw new SessionError(
			"The ASTAP plate solver was not found. Install ASTAP with a star database (D05 suits a " +
				"Seestar) and start this server with --astap <path to astap_cli> (or set ASTAP_PATH).\n\n" +
				`Looked in: ${found.searched.slice(0, 6).join(", ")}…`,
		);
	}
	return {
		path: found.path,
		databaseDir: session.config.astapDatabase,
		catalog: session.config.astapCatalog,
	};
}

async function solveFrame(
	session: Session,
	frame: CapturedFrame,
	hint: Equatorial | undefined,
): Promise<PlateSolution> {
	const astap = await requireAstap(session);
	return solvePlane(binnedLuminance(frame.image), { hint, radiusDeg: 30 }, astap);
}

/** Why a frame might not solve, judged from its pixels. */
function unsolvedHint(frame: CapturedFrame): string {
	const { stats } = frame;
	if (stats.max - stats.median < 2000) {
		return "It has almost no contrast — probably cloud, a wall, or the lens is covered. Look at the preview.";
	}
	return "Look at the preview: if there are stars, try a longer exposure or a larger search_radius_deg.";
}

function describeFrame(frame: CapturedFrame): string {
	const { stats } = frame;
	return [
		`${frame.image.width}×${frame.image.height}${frame.pattern ? `, Bayer ${frame.pattern}` : ""}` +
			`${frame.gain !== undefined ? `, gain ${frame.gain}` : ""}`,
		`median ${Math.round(stats.median)}, max ${stats.max}, saturated pixels ${stats.saturated}`,
	].join("\n");
}

function describeSolution(solution: PlateSolution, pointing: Equatorial | undefined): string {
	const lines = [
		`Solved: RA ${formatRightAscension(solution.center.ra)}  Dec ${formatDeclination(solution.center.dec)} (J2000)`,
		`Field ${solution.widthDeg.toFixed(2)}° × ${solution.heightDeg.toFixed(2)}°, rotation ${solution.rotationDeg.toFixed(1)}°`,
	];
	if (pointing) {
		const offset = separationDegrees(solution.center, pointing) * 60;
		lines.push(`The mount believed it was ${formatArcmin(offset)} away from this.`);
	}
	return lines.join("\n");
}

function formatArcmin(arcmin: number): string {
	return arcmin >= 60 ? `${(arcmin / 60).toFixed(2)}°` : `${arcmin.toFixed(1)}′`;
}

function structuredSolution(solution: PlateSolution): Record<string, unknown> {
	return {
		ra_hours: solution.center.ra,
		dec_degrees: solution.center.dec,
		width_deg: solution.widthDeg,
		height_deg: solution.heightDeg,
		rotation_deg: solution.rotationDeg,
	};
}

function renderCenterReport(report: CenterReport, name: string): string {
	const last = report.attempts.at(-1);
	const headline = report.centered
		? `${name} is centred: ${formatArcmin(last?.errorArcmin ?? 0)} from the target after ${report.attempts.length} ${report.attempts.length === 1 ? "attempt" : "attempts"}.`
		: `${name} is not centred yet: still ${formatArcmin(last?.errorArcmin ?? 0)} off after ${report.attempts.length} attempts. Run telescope_center again, or raise tolerance_arcmin.`;

	const rows = report.attempts.map(
		(attempt) =>
			`${attempt.attempt}. off by ${formatArcmin(attempt.errorArcmin)} ` +
			`(mount was ${formatArcmin(attempt.mountErrorArcmin)} wrong)` +
			`${attempt.synced ? ", synced" : ""}`,
	);

	return [
		headline,
		`Target RA ${formatRightAscension(report.target.ra)}  Dec ${formatDeclination(report.target.dec)} (J2000)`,
		rows.join("\n"),
		last ? `Last frame: ${last.path}` : "",
	]
		.filter(Boolean)
		.join("\n\n");
}

function structuredCenterReport(report: CenterReport): Record<string, unknown> {
	return {
		centered: report.centered,
		target: { ra_hours: report.target.ra, dec_degrees: report.target.dec },
		attempts: report.attempts.map((attempt) => ({
			attempt: attempt.attempt,
			path: attempt.path,
			error_arcmin: attempt.errorArcmin,
			mount_error_arcmin: attempt.mountErrorArcmin,
			synced: attempt.synced,
			solved: { ra_hours: attempt.solved.ra, dec_degrees: attempt.solved.dec },
		})),
	};
}

function withPreview(
	text: string,
	structured: Record<string, unknown>,
	frame: CapturedFrame | undefined,
): ToolResult {
	const content: ToolContent[] = [{ type: "text", text }];
	if (frame) {
		const png = previewPng(frame.image, { pattern: frame.pattern, maxSize: 800 });
		content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
	}
	return { content, structuredContent: structured };
}
