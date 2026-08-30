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

export type FitsCards = Record<string, string | number | boolean>;

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
		...Object.entries(options.cards ?? {}).map(([keyword, value]) => card(keyword, value)),
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

/** What a Seestar writes into a light frame, as far as we know it. */
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
		...overrides,
	};
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
