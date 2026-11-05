/**
 * Writing FITS files.
 *
 * Two shapes are needed: the raw frame exactly as the sensor read it (16-bit unsigned, stored the
 * FITS way as signed 16-bit plus BZERO 32768), and a 32-bit float copy for the plate solver. Both
 * are a header of 80-character cards followed by big-endian pixels, each padded to 2880 bytes.
 *
 * Rows are written top-down — row 0 of the image first — and the header says so with
 * ROWORDER = 'TOP-DOWN', which Siril and ASTAP both honour.
 */

const BLOCK = 2880;
const CARD = 80;

export type FitsCardValue = string | number | boolean;

export interface FitsCard {
	key: string;
	value: FitsCardValue;
	comment?: string;
}

/** Format one header card. Keys are upper-cased and cut to the FITS limit of eight characters. */
export function formatCard({ key, value, comment }: FitsCard): string {
	const keyword = key.toUpperCase().slice(0, 8).padEnd(8);
	let text: string;
	if (typeof value === "boolean") {
		text = (value ? "T" : "F").padStart(20);
	} else if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`FITS card ${key} is not a finite number`);
		const formatted = Number.isInteger(value) ? String(value) : formatFloat(value);
		text = formatted.padStart(20);
	} else {
		// Strings are quoted, with embedded quotes doubled, and at least eight characters inside.
		const escaped = value.replace(/[^\x20-\x7e]/g, "?").replace(/'/g, "''");
		text = `'${escaped.padEnd(8)}'`.padEnd(20);
	}
	const card = `${keyword}= ${text}${comment ? ` / ${comment}` : ""}`;
	return card.slice(0, CARD).padEnd(CARD);
}

function formatFloat(value: number): string {
	const plain = String(value);
	if (plain.length <= 20) return plain.includes(".") || plain.includes("e") ? plain : `${plain}.0`;
	return value.toExponential(12).replace("e", "E");
}

function header(cards: FitsCard[]): Buffer {
	const text = `${cards.map(formatCard).join("")}${"END".padEnd(CARD)}`;
	const padded = text.padEnd(Math.ceil(text.length / BLOCK) * BLOCK);
	return Buffer.from(padded, "ascii");
}

function pad(data: Buffer): Buffer {
	const remainder = data.length % BLOCK;
	return remainder === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK - remainder)]);
}

function primaryCards(bitpix: number, width: number, height: number): FitsCard[] {
	return [
		{ key: "SIMPLE", value: true, comment: "conforms to FITS standard" },
		{ key: "BITPIX", value: bitpix },
		{ key: "NAXIS", value: 2 },
		{ key: "NAXIS1", value: width },
		{ key: "NAXIS2", value: height },
	];
}

/** Keys the writer sets itself; a caller passing them would produce a broken file. */
const RESERVED = new Set([
	"SIMPLE",
	"BITPIX",
	"NAXIS",
	"NAXIS1",
	"NAXIS2",
	"BZERO",
	"BSCALE",
	"END",
]);

function extraCards(cards: FitsCard[]): FitsCard[] {
	return cards.filter((card) => !RESERVED.has(card.key.toUpperCase()));
}

/** A 16-bit unsigned frame, clamped to 0..65535. */
export function encodeFits16(
	width: number,
	height: number,
	pixels: ArrayLike<number>,
	cards: FitsCard[] = [],
): Buffer {
	if (pixels.length !== width * height) {
		throw new Error(`expected ${width * height} pixels, got ${pixels.length}`);
	}
	const data = Buffer.alloc(width * height * 2);
	for (let index = 0; index < pixels.length; index++) {
		const value = Math.min(65535, Math.max(0, Math.round(pixels[index] as number)));
		data.writeInt16BE(value - 32768, index * 2);
	}
	return Buffer.concat([
		header([
			...primaryCards(16, width, height),
			{ key: "BZERO", value: 32768, comment: "unsigned 16-bit data" },
			{ key: "BSCALE", value: 1 },
			{ key: "ROWORDER", value: "TOP-DOWN" },
			...extraCards(cards),
		]),
		pad(data),
	]);
}

/** A 32-bit float frame. */
export function encodeFitsFloat(
	width: number,
	height: number,
	data: Float32Array,
	cards: FitsCard[] = [],
): Buffer {
	if (data.length !== width * height) {
		throw new Error(`expected ${width * height} pixels, got ${data.length}`);
	}
	const body = Buffer.alloc(width * height * 4);
	for (let index = 0; index < data.length; index++) {
		body.writeFloatBE(data[index] as number, index * 4);
	}
	return Buffer.concat([
		header([
			...primaryCards(-32, width, height),
			{ key: "ROWORDER", value: "TOP-DOWN" },
			...extraCards(cards),
		]),
		pad(body),
	]);
}
