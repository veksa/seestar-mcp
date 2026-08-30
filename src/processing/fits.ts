import { open } from "node:fs/promises";

/**
 * A FITS header reader.
 *
 * FITS is an old, plain format: the file starts with 80-character ASCII "cards", padded into
 * 2880-byte blocks, ending with an `END` card. That is all we need to answer "what is in this
 * session" — exposure, gain, filter, target, dimensions — so there is no reason to pull in a
 * library or to shell out to Siril just to look at a frame.
 *
 * Pixel data is never read: only the leading blocks, up to `END`.
 */

const CARD_LENGTH = 80;
const BLOCK_SIZE = 2880;
const CARDS_PER_BLOCK = BLOCK_SIZE / CARD_LENGTH;
/** Enough for any sane header; a runaway file should not be read to the end. */
const MAX_BLOCKS = 40;

export type FitsValue = string | number | boolean | undefined;

export interface FitsHeader {
	/** Every card, in file order, keyed by keyword. Later duplicates win, as FITS readers do. */
	cards: Map<string, FitsValue>;
	comments: string[];
	history: string[];
}

/** The subset an astrophotographer actually asks about. */
export interface FrameInfo {
	path: string;
	width?: number;
	height?: number;
	channels?: number;
	bitpix?: number;
	object?: string;
	dateObs?: string;
	exposureSeconds?: number;
	gain?: number;
	offset?: number;
	temperatureC?: number;
	filter?: string;
	instrument?: string;
	telescope?: string;
	binning?: number;
	focalLengthMm?: number;
	/** Frames the telescope had already stacked into this file, when it says so. */
	stackedFrames?: number;
	imageType?: string;
	/**
	 * True for an already-stacked frame. Matters because EXPTIME on a master is the exposure of one
	 * sub, not the total — summing it across masters gives a number that is wrong by hours.
	 */
	isMaster?: boolean;
	/**
	 * Bayer pattern of a frame that still carries its mosaic, e.g. "GRBG".
	 *
	 * Present on every Seestar sub-frame: the telescope saves what the sensor read, undemosaiced.
	 */
	bayerPattern?: string;
	/** Where the frame points, when the header says. Useful when OBJECT is "Unknown". */
	rightAscensionDeg?: number;
	declinationDeg?: number;
	sizeBytes: number;
	header: FitsHeader;
}

/** Read the header of one FITS file. Rejects anything that is not FITS. */
export async function readFitsHeader(path: string): Promise<FitsHeader> {
	const file = await open(path, "r");
	try {
		const header: FitsHeader = { cards: new Map(), comments: [], history: [] };
		const buffer = Buffer.alloc(BLOCK_SIZE);

		for (let block = 0; block < MAX_BLOCKS; block++) {
			const { bytesRead } = await file.read(buffer, 0, BLOCK_SIZE, block * BLOCK_SIZE);
			if (bytesRead === 0) break;

			const text = buffer.subarray(0, bytesRead).toString("latin1");

			if (block === 0 && !text.startsWith("SIMPLE  =")) {
				throw new Error(`${path} does not start with a FITS SIMPLE card`);
			}

			for (let index = 0; index < CARDS_PER_BLOCK; index++) {
				const card = text.slice(index * CARD_LENGTH, (index + 1) * CARD_LENGTH);
				if (card.length < 8) break;

				const keyword = card.slice(0, 8).trim();
				if (keyword === "END") return header;
				if (keyword === "") continue;

				if (keyword === "COMMENT") {
					header.comments.push(card.slice(8).trim());
					continue;
				}
				if (keyword === "HISTORY") {
					header.history.push(card.slice(8).trim());
					continue;
				}

				// A value card has "= " in columns 9-10; anything else is a bare comment card.
				if (card.slice(8, 10) !== "= ") continue;
				header.cards.set(keyword, parseValue(card.slice(10)));
			}
		}

		return header;
	} finally {
		await file.close();
	}
}

/** Read one frame and pull out the fields worth reporting. */
export async function readFrameInfo(path: string): Promise<FrameInfo> {
	const header = await readFitsHeader(path);
	const file = await open(path, "r");
	let sizeBytes = 0;
	try {
		sizeBytes = (await file.stat()).size;
	} finally {
		await file.close();
	}

	const number = (...keywords: string[]): number | undefined => {
		for (const keyword of keywords) {
			const value = header.cards.get(keyword);
			if (typeof value === "number") return value;
			if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
				return Number(value);
			}
		}
		return undefined;
	};

	const text = (...keywords: string[]): string | undefined => {
		for (const keyword of keywords) {
			const value = header.cards.get(keyword);
			if (typeof value === "string" && value.trim() !== "") return value.trim();
		}
		return undefined;
	};

	return {
		path,
		sizeBytes,
		header,
		...defined("width", number("NAXIS1")),
		...defined("height", number("NAXIS2")),
		...defined("channels", number("NAXIS3")),
		...defined("bitpix", number("BITPIX")),
		...defined("object", text("OBJECT", "TARGET")),
		...defined("dateObs", text("DATE-OBS", "DATE_OBS")),
		// Different capture software writes a different one of these three.
		...defined("exposureSeconds", number("EXPTIME", "EXPOSURE", "EXPTIMES")),
		...defined("gain", number("GAIN", "EGAIN")),
		...defined("offset", number("OFFSET", "BLKLEVEL")),
		...defined("temperatureC", number("CCD-TEMP", "CCDTEMP", "TEMPERAT")),
		...defined("filter", text("FILTER", "FILTNAME")),
		...defined("instrument", text("INSTRUME", "CAMERA")),
		...defined("telescope", text("TELESCOP")),
		...defined("binning", number("XBINNING", "BINNING", "BINX")),
		...defined("focalLengthMm", number("FOCALLEN")),
		...defined("stackedFrames", number("STACKCNT", "NCOMBINE", "STACKED")),
		...defined("imageType", text("IMAGETYP", "FRAME")),
		...defined("isMaster", isMasterFrame(text("IMAGETYP", "FRAME"))),
		...defined("bayerPattern", text("BAYERPAT")),
		...defined("rightAscensionDeg", number("RA", "CRVAL1")),
		...defined("declinationDeg", number("DEC", "CRVAL2")),
	};
}

/**
 * True for a frame that still holds its Bayer mosaic, and so has to be demosaiced before stacking.
 *
 * One plane plus a BAYERPAT card is raw one-shot-colour data: stacked as it stands it gives a grey
 * image with the mosaic baked into it. Three planes means something has already demosaiced it — a
 * master the telescope stacked itself, for instance — and then there is nothing to do.
 */
export function isCfa(frame: FrameInfo): boolean {
	return frame.bayerPattern !== undefined && (frame.channels ?? 1) === 1;
}

/** Stacking software writes "Master Light", "Master Dark" and the like into IMAGETYP. */
function isMasterFrame(imageType: string | undefined): boolean | undefined {
	return imageType === undefined ? undefined : /master/i.test(imageType);
}

/**
 * Parse the value part of a card.
 *
 * Strings are single-quoted with `''` for a literal quote; numbers may use FORTRAN exponents (`D`);
 * `T`/`F` are booleans. Everything after an unquoted `/` is a comment.
 */
export function parseValue(raw: string): FitsValue {
	const text = raw.trimStart();
	if (text === "") return undefined;

	if (text.startsWith("'")) {
		let value = "";
		let index = 1;
		while (index < text.length) {
			if (text[index] === "'") {
				if (text[index + 1] === "'") {
					value += "'";
					index += 2;
					continue;
				}
				break;
			}
			value += text[index];
			index++;
		}
		return value.trimEnd();
	}

	const beforeComment = text.split("/")[0]?.trim() ?? "";
	if (beforeComment === "") return undefined;
	if (beforeComment === "T") return true;
	if (beforeComment === "F") return false;

	const numeric = Number(beforeComment.replace(/[dD]/, "e"));
	if (Number.isFinite(numeric)) return numeric;

	return beforeComment;
}

function defined<K extends string, T>(key: K, value: T | undefined): Partial<Record<K, T>> {
	return value === undefined ? {} : ({ [key]: value } as Record<K, T>);
}
