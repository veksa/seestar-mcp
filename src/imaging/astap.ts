import { access, constants, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { execTool } from "../processing/binaries.js";
import type { Equatorial } from "./coords.js";
import { encodeFitsFloat, type FitsCard } from "./fits-write.js";
import type { Plane } from "./frame.js";

/**
 * Plate solving with ASTAP.
 *
 * ASTAP is a small native solver with its own star catalogues, and it solves a Seestar frame in
 * well under a second when it is told roughly where to look. It is installed by the user; this
 * module finds it, hands it a FITS file and reads back the `.ini` it writes next to that file.
 */

export class SolveError extends Error {}

export interface AstapOptions {
	/** Path to `astap_cli` (or the `astap` GUI binary, which takes the same arguments). */
	path: string;
	/** Directory holding the star database. Defaults to the directory of the binary. */
	databaseDir?: string | undefined;
	/** Catalogue to use, e.g. "d05"; ASTAP picks one itself when omitted. */
	catalog?: string | undefined;
	timeoutMs?: number;
}

export interface SolveRequest {
	/** Where to start looking, J2000. Without it ASTAP searches the whole sky, which is slow. */
	hint?: Equatorial | undefined;
	/** How far from the hint to search, in degrees. */
	radiusDeg?: number;
	/** Field height in degrees, if known; 0 lets ASTAP work it out. */
	fovDeg?: number;
}

export interface PlateSolution {
	/** Centre of the image, J2000. */
	center: Equatorial;
	/** Size of one pixel of the solved image, in arcseconds. */
	scaleArcsec: number;
	/** Position angle of the image's y axis, degrees east of north. */
	rotationDeg: number;
	widthDeg: number;
	heightDeg: number;
	/** Anything ASTAP warned about, e.g. a field size that was off. */
	warning?: string;
}

/** Find the solver: explicit path first, then ASTAP_PATH, then PATH, then the usual install spots. */
export async function findAstap(
	configured: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ path?: string; searched: string[] }> {
	const searched: string[] = [];
	const candidates: string[] = [];
	if (configured) candidates.push(configured);
	if (env.ASTAP_PATH) candidates.push(env.ASTAP_PATH);
	for (const directory of (env.PATH ?? "").split(delimiter)) {
		if (!directory) continue;
		candidates.push(join(directory, "astap_cli"), join(directory, "astap"));
	}
	candidates.push(
		"/Applications/ASTAP.app/Contents/MacOS/astap",
		"/usr/local/bin/astap_cli",
		"/opt/astap/astap_cli",
		"C:\\Program Files\\astap\\astap_cli.exe",
	);

	for (const candidate of candidates) {
		searched.push(candidate);
		try {
			await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
			return { path: candidate, searched };
		} catch {
			// keep looking
		}
	}
	return { searched };
}

/** Solve one luminance plane. The plane is written to a temporary FITS file that is removed after. */
export async function solvePlane(
	plane: Plane,
	request: SolveRequest,
	options: AstapOptions,
): Promise<PlateSolution> {
	const directory = await mkdtemp(join(tmpdir(), "seestar-solve-"));
	try {
		const file = join(directory, "frame.fits");
		const cards: FitsCard[] = [];
		await writeFile(file, encodeFitsFloat(plane.width, plane.height, plane.data, cards));
		return await solveFile(file, plane, request, options);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/** The arguments ASTAP gets; exported for tests. */
export function astapArguments(
	file: string,
	request: SolveRequest,
	options: AstapOptions,
): string[] {
	const args = ["-f", file, "-d", options.databaseDir ?? dirname(options.path)];
	if (options.catalog) args.push("-D", options.catalog);
	args.push("-fov", String(request.fovDeg ?? 0), "-z", "0");
	if (request.hint) {
		args.push(
			"-ra",
			request.hint.ra.toFixed(5),
			"-spd",
			(request.hint.dec + 90).toFixed(5),
			"-r",
			String(request.radiusDeg ?? 30),
		);
	} else {
		args.push("-r", "180");
	}
	return args;
}

async function solveFile(
	file: string,
	plane: Plane,
	request: SolveRequest,
	options: AstapOptions,
): Promise<PlateSolution> {
	let output = "";
	try {
		const result = await execTool(options.path, astapArguments(file, request, options), {
			timeoutMs: options.timeoutMs ?? 60_000,
		});
		output = `${result.stdout}\n${result.stderr}`;
	} catch (error) {
		// ASTAP exits non-zero when it finds no solution; the .ini still says why.
		const failed = error as { stdout?: string; stderr?: string; killed?: boolean; code?: unknown };
		output = `${failed.stdout ?? ""}\n${failed.stderr ?? ""}`;
		if (failed.killed) throw new SolveError(`ASTAP did not finish in time.\n${output.trim()}`);
		if (failed.code === "ENOENT" || failed.code === "EACCES") {
			throw new SolveError(`Could not run ASTAP at ${options.path}: ${String(failed.code)}`);
		}
	}

	let ini: string;
	try {
		ini = await readFile(file.replace(/\.fits?$/i, ".ini"), "utf8");
	} catch {
		throw new SolveError(`ASTAP wrote no result.\n${output.trim()}`);
	}
	return parseAstapIni(ini, plane.width, plane.height);
}

/** Read ASTAP's `.ini` result. Throws SolveError when it says there is no solution. */
export function parseAstapIni(text: string, width: number, height: number): PlateSolution {
	const values = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		const at = line.indexOf("=");
		if (at > 0) values.set(line.slice(0, at).trim().toUpperCase(), line.slice(at + 1).trim());
	}

	const number = (key: string): number | undefined => {
		const raw = values.get(key);
		if (raw === undefined) return undefined;
		const parsed = Number(raw);
		return Number.isFinite(parsed) ? parsed : undefined;
	};

	if (values.get("PLTSOLVD") !== "T") {
		const reason = values.get("ERROR") ?? values.get("WARNING") ?? "no solution found";
		throw new SolveError(`ASTAP found no solution: ${reason}`);
	}

	const ra = number("CRVAL1");
	const dec = number("CRVAL2");
	if (ra === undefined || dec === undefined) {
		throw new SolveError("ASTAP reported a solution without coordinates");
	}

	const cd11 = number("CD1_1");
	const cd21 = number("CD2_1");
	const cd12 = number("CD1_2");
	const cd22 = number("CD2_2");
	const cdelt = number("CDELT2");

	let scaleDeg: number;
	let rotationDeg: number;
	if (cd11 !== undefined && cd21 !== undefined && cd12 !== undefined && cd22 !== undefined) {
		scaleDeg = Math.sqrt(Math.abs(cd11 * cd22 - cd12 * cd21));
		rotationDeg = (Math.atan2(cd12, cd22) * 180) / Math.PI;
	} else if (cdelt !== undefined) {
		scaleDeg = Math.abs(cdelt);
		rotationDeg = number("CROTA2") ?? 0;
	} else {
		throw new SolveError("ASTAP reported a solution without a scale");
	}

	const warning = values.get("WARNING");
	return {
		center: { ra: (((ra / 15) % 24) + 24) % 24, dec },
		scaleArcsec: scaleDeg * 3600,
		rotationDeg,
		widthDeg: scaleDeg * width,
		heightDeg: scaleDeg * height,
		...(warning ? { warning } : {}),
	};
}
