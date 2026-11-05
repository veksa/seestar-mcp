/**
 * Camera images as an Alpaca server sends them.
 *
 * `imagearray` comes back either as JSON (`Value` is a nested array) or, when the client asks for
 * `application/imagebytes`, as a binary block. A full Seestar S50 Pro frame is 2160×3840 pixels:
 * 16.6 MB as ImageBytes, several times that as JSON. The built-in server supports both.
 *
 * Both encodings carry the ASCOM array, which is indexed [x][y] — the first dimension is the
 * column, the second the row, and the row index varies fastest. Everything here converts to the
 * row-major layout the rest of the code expects: `pixels[y * width + x]`.
 */

export interface AlpacaImage {
	width: number;
	height: number;
	/** Row-major: the pixel at column x, row y is `pixels[y * width + x]`. */
	pixels: Int32Array;
}

/** ASCOM ImageArrayElementTypes. */
const ELEMENT_TYPES: Record<
	number,
	{ bytes: number; read: (view: DataView, at: number) => number }
> = {
	1: { bytes: 2, read: (view, at) => view.getInt16(at, true) },
	2: { bytes: 4, read: (view, at) => view.getInt32(at, true) },
	3: { bytes: 8, read: (view, at) => view.getFloat64(at, true) },
	4: { bytes: 4, read: (view, at) => view.getFloat32(at, true) },
	6: { bytes: 1, read: (view, at) => view.getUint8(at) },
	8: { bytes: 2, read: (view, at) => view.getUint16(at, true) },
	9: { bytes: 4, read: (view, at) => view.getUint32(at, true) },
};

const HEADER_BYTES = 44;

/** What the ImageBytes header says about the payload. */
export interface ImageBytesHeader {
	metadataVersion: number;
	errorNumber: number;
	clientTransactionId: number;
	serverTransactionId: number;
	dataStart: number;
	imageElementType: number;
	transmissionElementType: number;
	rank: number;
	dimensions: [number, number, number];
}

export class ImageDecodeError extends Error {
	constructor(
		message: string,
		/** The ASCOM error the server reported inside the block, if that is what it was. */
		readonly errorNumber?: number,
	) {
		super(message);
	}
}

export function readImageBytesHeader(buffer: Uint8Array): ImageBytesHeader {
	if (buffer.byteLength < HEADER_BYTES) {
		throw new ImageDecodeError(`ImageBytes block is only ${buffer.byteLength} bytes long`);
	}
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	const int = (index: number) => view.getInt32(index * 4, true);
	return {
		metadataVersion: int(0),
		errorNumber: int(1),
		clientTransactionId: int(2),
		serverTransactionId: int(3),
		dataStart: int(4),
		imageElementType: int(5),
		transmissionElementType: int(6),
		rank: int(7),
		dimensions: [int(8), int(9), int(10)],
	};
}

/** Decode an `application/imagebytes` response body. */
export function decodeImageBytes(buffer: Uint8Array): AlpacaImage {
	const header = readImageBytesHeader(buffer);

	if (header.errorNumber !== 0) {
		const message = new TextDecoder().decode(buffer.subarray(header.dataStart));
		throw new ImageDecodeError(message || `error ${header.errorNumber}`, header.errorNumber);
	}
	if (header.rank !== 2) {
		throw new ImageDecodeError(
			`only single-plane images are supported; this one has rank ${header.rank}`,
		);
	}

	const element = ELEMENT_TYPES[header.transmissionElementType];
	if (!element) {
		throw new ImageDecodeError(
			`unsupported ImageBytes element type ${header.transmissionElementType}`,
		);
	}

	const [width, height] = header.dimensions;
	const expected = header.dataStart + width * height * element.bytes;
	if (width <= 0 || height <= 0 || buffer.byteLength < expected) {
		throw new ImageDecodeError(
			`ImageBytes block is truncated: ${width}×${height} needs ${expected} bytes, got ${buffer.byteLength}`,
		);
	}

	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	const pixels = new Int32Array(width * height);
	let at = header.dataStart;
	for (let x = 0; x < width; x++) {
		for (let y = 0; y < height; y++) {
			pixels[y * width + x] = Math.round(element.read(view, at));
			at += element.bytes;
		}
	}
	return { width, height, pixels };
}

/** Decode the JSON form: `Value[x][y]`. */
export function decodeImageJson(value: unknown): AlpacaImage {
	if (!Array.isArray(value) || value.length === 0 || !Array.isArray(value[0])) {
		throw new ImageDecodeError("imagearray did not return a two-dimensional array");
	}
	const columns = value as unknown[][];
	const width = columns.length;
	const height = (columns[0] as unknown[]).length;
	const pixels = new Int32Array(width * height);
	for (let x = 0; x < width; x++) {
		const column = columns[x] as unknown[];
		if (column.length !== height) {
			throw new ImageDecodeError("imagearray rows have different lengths");
		}
		for (let y = 0; y < height; y++) {
			const pixel = column[y];
			if (typeof pixel !== "number") {
				throw new ImageDecodeError("only single-plane images are supported");
			}
			pixels[y * width + x] = Math.round(pixel);
		}
	}
	return { width, height, pixels };
}

/** Build an ImageBytes block — the inverse of `decodeImageBytes`, for tests and fakes. */
export function encodeImageBytes(image: AlpacaImage, transmissionElementType = 8): Uint8Array {
	const element = ELEMENT_TYPES[transmissionElementType];
	if (!element) throw new Error(`unsupported element type ${transmissionElementType}`);

	const buffer = new Uint8Array(HEADER_BYTES + image.width * image.height * element.bytes);
	const view = new DataView(buffer.buffer);
	const header = [
		1,
		0,
		0,
		0,
		HEADER_BYTES,
		2,
		transmissionElementType,
		2,
		image.width,
		image.height,
		0,
	];
	header.forEach((value, index) => {
		view.setInt32(index * 4, value, true);
	});

	let at = HEADER_BYTES;
	for (let x = 0; x < image.width; x++) {
		for (let y = 0; y < image.height; y++) {
			const value = image.pixels[y * image.width + x] ?? 0;
			switch (transmissionElementType) {
				case 1:
					view.setInt16(at, value, true);
					break;
				case 2:
					view.setInt32(at, value, true);
					break;
				case 6:
					view.setUint8(at, value);
					break;
				case 8:
					view.setUint16(at, value, true);
					break;
				default:
					throw new Error(`encoding element type ${transmissionElementType} is not supported`);
			}
			at += element.bytes;
		}
	}
	return buffer;
}
