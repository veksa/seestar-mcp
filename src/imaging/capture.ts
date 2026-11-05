import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Camera, CameraInfo } from "../alpaca/devices/camera.js";
import type { Telescope } from "../alpaca/devices/telescope.js";
import type { AlpacaImage } from "../alpaca/imagebytes.js";
import { sanitizeSessionName } from "../workdir.js";
import { type Equatorial, type Equinox, fromMount } from "./coords.js";
import { encodeFits16, type FitsCard } from "./fits-write.js";
import { bayerPattern, type FrameStats, frameStats } from "./frame.js";

/**
 * Taking one frame through the Alpaca camera and keeping it.
 *
 * The camera is left the way it was found: if it had to be connected for this frame it is
 * disconnected afterwards, and a gain set for this frame is put back. The Seestar app shares the
 * same camera, and a capture should not change what it sees next.
 */

export interface CaptureRequest {
	exposureSeconds: number;
	gain?: number | undefined;
	/** Used for the directory and file name, e.g. "M45". */
	name: string;
	/** Optional sub-directory under the target, e.g. "center" for the frames a centring run takes. */
	subdirectory?: string | undefined;
	/** Where captures live: `<dir>/<night>/<name>/…`. */
	captureDir: string;
	/** How long to wait for the download of one frame. */
	downloadTimeoutMs?: number;
}

export interface CaptureContext {
	camera: Camera;
	/** The mount, to stamp the frame with where it was pointing. Optional. */
	telescope?: Telescope | undefined;
	equinox?: Equinox | undefined;
	now?: () => Date;
}

export interface CapturedFrame {
	path: string;
	image: AlpacaImage;
	info: CameraInfo;
	pattern: string | undefined;
	stats: FrameStats;
	startedAt: Date;
	gain: number | undefined;
	/** Where the mount said it was pointing during the exposure, J2000. */
	pointing?: Equatorial;
}

export async function captureFrame(
	request: CaptureRequest,
	context: CaptureContext,
): Promise<CapturedFrame> {
	const { camera } = context;
	const now = context.now ?? (() => new Date());

	const wasConnected = await camera.isConnected().catch(() => false);
	if (!wasConnected) await camera.setConnected(true);

	let previousGain: number | undefined;
	try {
		const info = await camera.info();
		if (request.gain !== undefined) {
			previousGain = info.gain;
			if (previousGain !== request.gain) await camera.setGain(request.gain);
		}

		const startedAt = now();
		await camera.startExposure(request.exposureSeconds, true);
		const ready = await camera.waitForImage({
			timeoutMs: request.exposureSeconds * 1000 + 60_000,
		});
		if (!ready) {
			await camera.abortExposure().catch(() => undefined);
			throw new Error(
				`The camera did not deliver the frame within ${Math.round(request.exposureSeconds + 60)}s.`,
			);
		}

		const image = await camera.image({ timeoutMs: request.downloadTimeoutMs ?? 120_000 });
		const pointing = await mountPosition(context);
		const pattern = bayerPattern(info.sensorType, info.bayerOffsetX ?? 0, info.bayerOffsetY ?? 0);
		const gain = request.gain ?? info.gain;

		const path = framePath(request, startedAt);
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(
			path,
			encodeFits16(
				image.width,
				image.height,
				image.pixels,
				frameCards({ request, info, pattern, startedAt, gain, pointing }),
			),
		);

		return {
			path,
			image,
			info,
			pattern,
			stats: frameStats(image, info.maxAdu ?? 65535),
			startedAt,
			gain,
			...(pointing ? { pointing } : {}),
		};
	} finally {
		if (previousGain !== undefined && previousGain !== request.gain) {
			await camera.setGain(previousGain).catch(() => undefined);
		}
		if (!wasConnected) await camera.setConnected(false).catch(() => undefined);
	}
}

async function mountPosition(context: CaptureContext): Promise<Equatorial | undefined> {
	if (!context.telescope) return undefined;
	try {
		const [ra, dec] = await Promise.all([
			context.telescope.rightAscension(),
			context.telescope.declination(),
		]);
		return fromMount({ ra, dec }, context.equinox ?? "date");
	} catch {
		return undefined;
	}
}

/**
 * `<captureDir>/<night>/<name>/[<sub>/]<name>_<exposure>s_g<gain>_<HHMMSS>.fits`.
 *
 * The night is the local date the evening started on: a frame taken at 01:30 belongs with the ones
 * from 23:00, not with tomorrow's.
 */
export function framePath(request: CaptureRequest, startedAt: Date): string {
	const name = sanitizeSessionName(request.name);
	const evening = new Date(startedAt.getTime() - 12 * 3600_000);
	const night = `${evening.getFullYear()}-${pad(evening.getMonth() + 1)}-${pad(evening.getDate())}`;
	const time = `${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}${pad(startedAt.getSeconds())}`;
	const exposure = String(request.exposureSeconds).replace(".", "p");
	const gain = request.gain === undefined ? "" : `_g${request.gain}`;
	const directory = join(
		request.captureDir,
		night,
		name,
		...(request.subdirectory ? [sanitizeSessionName(request.subdirectory)] : []),
	);
	return join(directory, `${name}_${exposure}s${gain}_${time}.fits`);
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

function frameCards(frame: {
	request: CaptureRequest;
	info: CameraInfo;
	pattern: string | undefined;
	startedAt: Date;
	gain: number | undefined;
	pointing: Equatorial | undefined;
}): FitsCard[] {
	const { request, info, pattern, startedAt, gain, pointing } = frame;
	const cards: FitsCard[] = [
		{ key: "OBJECT", value: request.name },
		{ key: "IMAGETYP", value: "Light" },
		{ key: "DATE-OBS", value: startedAt.toISOString().replace("Z", ""), comment: "UTC start" },
		{ key: "EXPTIME", value: request.exposureSeconds, comment: "seconds" },
		{ key: "EXPOSURE", value: request.exposureSeconds, comment: "seconds" },
	];
	if (gain !== undefined) cards.push({ key: "GAIN", value: gain });
	if (info.name) cards.push({ key: "INSTRUME", value: info.name });
	if (info.pixelSizeX !== undefined) cards.push({ key: "XPIXSZ", value: info.pixelSizeX });
	if (info.pixelSizeY !== undefined) cards.push({ key: "YPIXSZ", value: info.pixelSizeY });
	if (info.ccdTemperature !== undefined) {
		cards.push({ key: "CCD-TEMP", value: info.ccdTemperature, comment: "C" });
	}
	if (pattern) {
		cards.push(
			{ key: "BAYERPAT", value: pattern },
			{ key: "XBAYROFF", value: 0 },
			{ key: "YBAYROFF", value: 0 },
		);
	}
	if (pointing) {
		cards.push(
			{ key: "RA", value: Number((pointing.ra * 15).toFixed(5)), comment: "mount, J2000 deg" },
			{ key: "DEC", value: Number(pointing.dec.toFixed(5)), comment: "mount, J2000 deg" },
		);
	}
	cards.push({ key: "SWCREATE", value: "seestar-mcp" });
	return cards;
}
