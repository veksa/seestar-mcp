import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Build real FITS files for tests.
 *
 * Small enough to keep in a temporary directory, real enough that the parser is exercised the way
 * it will be on a telescope's output: 80-character cards, 2880-byte blocks, an `END` card, and a
 * data block of the size the header claims.
 */

const CARD_LENGTH = 80;
const BLOCK_SIZE = 2880;

/** A card whose value is undefined is left out, which is how a fixture drops one of the defaults. */
export type FitsCards = Record<string, string | number | boolean | undefined>;

export interface FitsFixtureOptions {
	width?: number;
	height?: number;
	bitpix?: number;
	/** Extra cards, e.g. what a Seestar writes. */
	cards?: FitsCards;
	/** Write a file that is not FITS at all. */
	corrupt?: boolean;
}

export function buildFits(options: FitsFixtureOptions = {}): Buffer {
	if (options.corrupt) return Buffer.from("this is not a FITS file\n".repeat(200), "latin1");

	const width = options.width ?? 8;
	const height = options.height ?? 6;
	const bitpix = options.bitpix ?? 16;

	const cards = [
		card("SIMPLE", true),
		card("BITPIX", bitpix),
		card("NAXIS", 2),
		card("NAXIS1", width),
		card("NAXIS2", height),
		...extraCards(options.cards),
		"END".padEnd(CARD_LENGTH, " "),
	].join("");

	const header = Buffer.from(pad(cards), "latin1");
	const dataBytes = (Math.abs(bitpix) / 8) * width * height;
	const data = Buffer.alloc(Math.ceil(dataBytes / BLOCK_SIZE) * BLOCK_SIZE);

	return Buffer.concat([header, data]);
}

export async function writeFits(path: string, options: FitsFixtureOptions = {}): Promise<string> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, buildFits(options));
	return path;
}

/** What a Seestar writes into a light frame, read off a real S50 sub-frame. */
export function seestarLightCards(overrides: FitsCards = {}): FitsCards {
	return {
		OBJECT: "M 31",
		"DATE-OBS": "2026-08-30T21:14:07.123",
		EXPTIME: 10,
		GAIN: 80,
		"CCD-TEMP": 12.5,
		INSTRUME: "Seestar S50",
		TELESCOP: "Seestar S50",
		FILTER: "IRCUT",
		XBINNING: 1,
		FOCALLEN: 250,
		IMAGETYP: "LIGHT",
		// The sensor is one-shot colour and the telescope saves what it read, so a sub-frame is a
		// Bayer mosaic in one plane. Pass BAYERPAT: undefined for an already-demosaiced frame.
		BAYERPAT: "GRBG",
		...overrides,
	};
}

/** The fixture's own cards. A value of undefined drops the card, rather than writing one. */
function extraCards(cards: FitsCards | undefined): string[] {
	return Object.entries(cards ?? {})
		.filter(([, value]) => value !== undefined)
		.map(([keyword, value]) => card(keyword, value as string | number | boolean));
}

function card(keyword: string, value: string | number | boolean): string {
	const key = keyword.slice(0, 8).padEnd(8, " ");
	const formatted =
		typeof value === "string"
			? `'${value.replace(/'/g, "''")}'`.padEnd(20, " ")
			: typeof value === "boolean"
				? (value ? "T" : "F").padStart(20, " ")
				: String(value).padStart(20, " ");

	return `${key}= ${formatted}`.padEnd(CARD_LENGTH, " ").slice(0, CARD_LENGTH);
}

/** FITS is written in fixed 2880-byte blocks, padded with spaces. */
function pad(text: string): string {
	const remainder = text.length % BLOCK_SIZE;
	return remainder === 0 ? text : text + " ".repeat(BLOCK_SIZE - remainder);
}

/**
 * A frame with stars in it.
 *
 * Registration needs something to match on, so blank fixtures are no good for an end-to-end run
 * against a real Siril. This paints Gaussian stars onto a noisy background and writes it as
 * standard unsigned 16-bit FITS: big-endian samples with BZERO 32768, which is how the format
 * expresses unsigned data.
 */
export interface StarfieldOptions {
	width?: number;
	height?: number;
	/** Shift of the whole field, so consecutive frames need aligning. */
	offsetX?: number;
	offsetY?: number;
	stars?: number;
	seed?: number;
	cards?: FitsCards;
}

export function buildStarfieldFits(options: StarfieldOptions = {}): Buffer {
	const width = options.width ?? 256;
	const height = options.height ?? 256;
	const starCount = options.stars ?? 40;
	const offsetX = options.offsetX ?? 0;
	const offsetY = options.offsetY ?? 0;

	const random = mulberry32(options.seed ?? 1);
	const pixels = new Uint16Array(width * height);

	// A dim, slightly noisy sky.
	for (let index = 0; index < pixels.length; index++) {
		pixels[index] = 800 + Math.floor(random() * 120);
	}

	// The same stars in every frame — only the frame's own offset moves them.
	const starRandom = mulberry32(4242);
	for (let star = 0; star < starCount; star++) {
		const x = 12 + starRandom() * (width - 24) + offsetX;
		const y = 12 + starRandom() * (height - 24) + offsetY;
		const peak = 8000 + starRandom() * 40000;
		const sigma = 1.4 + starRandom() * 0.6;

		for (let dy = -5; dy <= 5; dy++) {
			for (let dx = -5; dx <= 5; dx++) {
				const px = Math.round(x) + dx;
				const py = Math.round(y) + dy;
				if (px < 0 || py < 0 || px >= width || py >= height) continue;

				const falloff = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
				const index = py * width + px;
				pixels[index] = Math.min(65535, (pixels[index] ?? 0) + Math.round(peak * falloff));
			}
		}
	}

	const cards = [
		card("SIMPLE", true),
		card("BITPIX", 16),
		card("NAXIS", 2),
		card("NAXIS1", width),
		card("NAXIS2", height),
		// Unsigned 16-bit is signed samples plus this offset — the standard trick.
		card("BZERO", 32768),
		card("BSCALE", 1),
		...extraCards(options.cards),
		"END".padEnd(CARD_LENGTH, " "),
	].join("");

	const header = Buffer.from(pad(cards), "latin1");
	const data = Buffer.alloc(Math.ceil((width * height * 2) / BLOCK_SIZE) * BLOCK_SIZE);
	for (let index = 0; index < pixels.length; index++) {
		// FITS is big-endian, and the samples are stored signed.
		data.writeInt16BE((pixels[index] ?? 0) - 32768, index * 2);
	}

	return Buffer.concat([header, data]);
}

export async function writeStarfieldFits(
	path: string,
	options: StarfieldOptions = {},
): Promise<string> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, buildStarfieldFits(options));
	return path;
}

/** A small deterministic generator, so fixtures are identical on every machine. */
function mulberry32(seed: number): () => number {
	let state = seed;
	return () => {
		state |= 0;
		state = (state + 0x6d2b79f5) | 0;
		let value = Math.imul(state ^ (state >>> 15), 1 | state);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}
