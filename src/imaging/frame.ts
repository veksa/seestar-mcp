import type { AlpacaImage } from "../alpaca/imagebytes.js";

/**
 * Working with a raw frame before it goes to disk: which Bayer pattern it carries, what its pixels
 * look like, and a luminance copy to plate-solve.
 */

const RGGB = [
	["R", "G"],
	["G", "B"],
] as const;

/**
 * The Bayer pattern of the frame's top-left 2×2 block, e.g. "GRBG".
 *
 * ASCOM describes a colour sensor as RGGB plus an offset: the colour at column x, row y is
 * RGGB[(y + offsetY) % 2][(x + offsetX) % 2]. FITS readers (Siril among them) want the pattern as it
 * starts at pixel (0, 0), so the offset is folded in here. On a Seestar S50 Pro the camera reports
 * RGGB with offset (1, 0), which makes GRBG — the same pattern the telescope writes into its own
 * FITS files.
 */
export function bayerPattern(
	sensorType: number | undefined,
	offsetX = 0,
	offsetY = 0,
): string | undefined {
	if (sensorType !== 2) return undefined;
	const at = (x: number, y: number) => RGGB[(y + offsetY) % 2]?.[(x + offsetX) % 2] ?? "";
	return `${at(0, 0)}${at(1, 0)}${at(0, 1)}${at(1, 1)}`;
}

export interface FrameStats {
	min: number;
	max: number;
	mean: number;
	median: number;
	/** Pixels within 0.1% of the camera's maximum value. */
	saturated: number;
}

/**
 * Statistics over the whole frame; the median is taken from a regular sample to stay fast.
 *
 * "Saturated" has a margin because sensors rarely reach MaxADU itself: the Seestar's 12-bit readout
 * is shifted into 16 bits, so a blown star reads 65520, not 65535.
 */
export function frameStats(image: AlpacaImage, maxAdu = 65535): FrameStats {
	const { pixels } = image;
	const saturationLevel = maxAdu * 0.999;
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	let sum = 0;
	let saturated = 0;
	for (let index = 0; index < pixels.length; index++) {
		const value = pixels[index] as number;
		if (value < min) min = value;
		if (value > max) max = value;
		if (value >= saturationLevel) saturated++;
		sum += value;
	}

	const step = Math.max(1, Math.floor(pixels.length / 200_000));
	const sample: number[] = [];
	for (let index = 0; index < pixels.length; index += step) sample.push(pixels[index] as number);
	sample.sort((a, b) => a - b);

	return {
		min: pixels.length ? min : 0,
		max: pixels.length ? max : 0,
		mean: pixels.length ? sum / pixels.length : 0,
		median: sample[Math.floor(sample.length / 2)] ?? 0,
		saturated,
	};
}

export interface Plane {
	width: number;
	height: number;
	data: Float32Array;
}

/**
 * Sum every 2×2 block into one pixel.
 *
 * On a colour sensor each block holds one full Bayer cell, so the sum is a luminance value with the
 * mosaic gone — exactly what a plate solver wants, and a quarter of the pixels to search. On a mono
 * sensor it is plain 2×2 binning, which does the solver no harm either.
 */
export function binnedLuminance(image: AlpacaImage): Plane {
	const width = Math.floor(image.width / 2);
	const height = Math.floor(image.height / 2);
	const data = new Float32Array(width * height);
	const { pixels } = image;
	for (let y = 0; y < height; y++) {
		const top = 2 * y * image.width;
		const bottom = top + image.width;
		for (let x = 0; x < width; x++) {
			const left = 2 * x;
			data[y * width + x] =
				(pixels[top + left] as number) +
				(pixels[top + left + 1] as number) +
				(pixels[bottom + left] as number) +
				(pixels[bottom + left + 1] as number);
		}
	}
	return { width, height, data };
}

/**
 * A half-resolution colour image, one RGB pixel per Bayer cell ("superpixel" debayering).
 *
 * Good enough to see what the telescope sees; the real demosaic is Siril's job. A frame without a
 * pattern comes back grey.
 */
export function superpixelRgb(
	image: AlpacaImage,
	pattern: string | undefined,
): { width: number; height: number; red: Float32Array; green: Float32Array; blue: Float32Array } {
	const width = Math.floor(image.width / 2);
	const height = Math.floor(image.height / 2);
	const red = new Float32Array(width * height);
	const green = new Float32Array(width * height);
	const blue = new Float32Array(width * height);
	const { pixels } = image;

	// Position of each colour inside the 2×2 cell, as offsets into the block.
	const cell = pattern && /^[RGB]{4}$/.test(pattern) ? pattern : undefined;
	const offsets = [
		[0, 0],
		[1, 0],
		[0, 1],
		[1, 1],
	] as const;

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const out = y * width + x;
			let r = 0;
			let g = 0;
			let b = 0;
			for (let index = 0; index < 4; index++) {
				const [dx, dy] = offsets[index] as readonly [number, number];
				const value = pixels[(2 * y + dy) * image.width + 2 * x + dx] as number;
				const colour = cell ? cell[index] : "L";
				if (colour === "R") r += value;
				else if (colour === "G") g += value / 2;
				else if (colour === "B") b += value;
				else {
					r += value / 4;
					g += value / 4;
					b += value / 4;
				}
			}
			red[out] = r;
			green[out] = g;
			blue[out] = b;
		}
	}
	return { width, height, red, green, blue };
}
