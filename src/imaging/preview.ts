import { crc32, deflateSync } from "node:zlib";
import type { AlpacaImage } from "../alpaca/imagebytes.js";
import { superpixelRgb } from "./frame.js";

/**
 * A small stretched PNG of a raw frame — enough to see stars, clouds, a wall or a balcony roof.
 *
 * A raw astro frame looks black on screen: the sky sits in the bottom few percent of the range and
 * the stars are single bright pixels. So each colour is clipped between its 0.5th and 99.8th
 * percentiles and then lifted with an asinh curve, the usual quick-look stretch.
 */

export interface PreviewOptions {
	/** Longest side of the result, in pixels. */
	maxSize?: number;
	/** Bayer pattern of the frame, e.g. "GRBG"; omitted for a mono frame. */
	pattern?: string | undefined;
}

export function previewPng(image: AlpacaImage, options: PreviewOptions = {}): Buffer {
	const rgb = superpixelRgb(image, options.pattern);
	const maxSize = options.maxSize ?? 800;
	const factor = Math.max(1, Math.ceil(Math.max(rgb.width, rgb.height) / maxSize));
	const width = Math.floor(rgb.width / factor);
	const height = Math.floor(rgb.height / factor);

	const channels = [rgb.red, rgb.green, rgb.blue].map((plane) =>
		stretch(downscale(plane, rgb.width, width, height, factor)),
	);

	const raw = Buffer.alloc((width * 3 + 1) * height);
	for (let y = 0; y < height; y++) {
		const row = y * (width * 3 + 1);
		raw[row] = 0; // filter: none
		for (let x = 0; x < width; x++) {
			for (let c = 0; c < 3; c++) {
				raw[row + 1 + x * 3 + c] = (channels[c] as Uint8Array)[y * width + x] as number;
			}
		}
	}
	return encodePng(width, height, raw);
}

/** Average `factor`×`factor` blocks. */
function downscale(
	plane: Float32Array,
	sourceWidth: number,
	width: number,
	height: number,
	factor: number,
): Float32Array {
	if (factor === 1) return plane;
	const out = new Float32Array(width * height);
	const area = factor * factor;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let sum = 0;
			for (let dy = 0; dy < factor; dy++) {
				const row = (y * factor + dy) * sourceWidth + x * factor;
				for (let dx = 0; dx < factor; dx++) sum += plane[row + dx] as number;
			}
			out[y * width + x] = sum / area;
		}
	}
	return out;
}

function stretch(plane: Float32Array): Uint8Array {
	const sorted = Float32Array.from(plane).sort();
	const at = (fraction: number) =>
		sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
	const low = at(0.005);
	const high = at(0.998);
	const range = Math.max(high - low, 1);
	const strength = 10;
	const norm = Math.asinh(strength);

	const out = new Uint8Array(plane.length);
	for (let index = 0; index < plane.length; index++) {
		const linear = Math.min(1, Math.max(0, ((plane[index] as number) - low) / range));
		out[index] = Math.round((Math.asinh(linear * strength) / norm) * 255);
	}
	return out;
}

function encodePng(width: number, height: number, raw: Buffer): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, crc]);
	};

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // colour type: truecolour
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}
