import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type AlpacaImage,
	decodeImageBytes,
	decodeImageJson,
	encodeImageBytes,
	ImageDecodeError,
} from "../../src/alpaca/imagebytes.js";
import { astapArguments, parseAstapIni, SolveError } from "../../src/imaging/astap.js";
import { framePath } from "../../src/imaging/capture.js";
import { type CenterDeps, centerOn } from "../../src/imaging/center.js";
import {
	dateToJ2000,
	type Equatorial,
	equinoxOf,
	j2000ToDate,
	separationDegrees,
} from "../../src/imaging/coords.js";
import { encodeFits16, encodeFitsFloat, formatCard } from "../../src/imaging/fits-write.js";
import { bayerPattern, binnedLuminance, frameStats } from "../../src/imaging/frame.js";
import { previewPng } from "../../src/imaging/preview.js";
import { readFitsHeader } from "../../src/processing/fits.js";
import { expectFailure } from "../helpers.js";

let workDir: string;

beforeAll(async () => {
	workDir = await mkdtemp(join(tmpdir(), "seestar-imaging-"));
});

afterAll(async () => {
	await rm(workDir, { recursive: true, force: true });
});

/** A small image whose every pixel says where it is: value = 100 * y + x. */
function positional(width: number, height: number): AlpacaImage {
	const pixels = new Int32Array(width * height);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) pixels[y * width + x] = 100 * y + x;
	return { width, height, pixels };
}

describe("ImageBytes", () => {
	it("reads the ASCOM [x][y] order into row-major pixels", () => {
		// Built by hand: x is the outer index and y varies fastest, as the Seestar sends it.
		const width = 3;
		const height = 2;
		const buffer = new Uint8Array(44 + width * height * 2);
		const view = new DataView(buffer.buffer);
		[1, 0, 0, 0, 44, 2, 8, 2, width, height, 0].forEach((value, index) => {
			view.setInt32(index * 4, value, true);
		});
		let at = 44;
		for (let x = 0; x < width; x++) {
			for (let y = 0; y < height; y++) {
				view.setUint16(at, 100 * y + x, true);
				at += 2;
			}
		}

		const image = decodeImageBytes(buffer);
		expect(image.width).toBe(3);
		expect(image.height).toBe(2);
		expect(Array.from(image.pixels)).toEqual([0, 1, 2, 100, 101, 102]);
	});

	it("round-trips through the encoder", () => {
		const image = positional(5, 4);
		expect(decodeImageBytes(encodeImageBytes(image))).toEqual(image);
	});

	it("reads the JSON form, which is indexed the same way", () => {
		const value = [
			[0, 100],
			[1, 101],
			[2, 102],
		];
		expect(Array.from(decodeImageJson(value).pixels)).toEqual([0, 1, 2, 100, 101, 102]);
	});

	it("surfaces an error the server put inside the block", () => {
		const message = new TextEncoder().encode("No image available");
		const buffer = new Uint8Array(44 + message.length);
		const view = new DataView(buffer.buffer);
		[1, 0x40b, 0, 0, 44, 0, 0, 0, 0, 0, 0].forEach((value, index) => {
			view.setInt32(index * 4, value, true);
		});
		buffer.set(message, 44);

		const error = (() => {
			try {
				decodeImageBytes(buffer);
			} catch (caught) {
				return caught;
			}
		})();
		expect(error).toBeInstanceOf(ImageDecodeError);
		expect((error as ImageDecodeError).errorNumber).toBe(0x40b);
		expect((error as Error).message).toBe("No image available");
	});

	it("refuses a truncated block", () => {
		const block = encodeImageBytes(positional(4, 4));
		expect(() => decodeImageBytes(block.subarray(0, block.length - 2))).toThrow(/truncated/);
	});
});

describe("bayerPattern", () => {
	it("folds the ASCOM offset into the pattern, as on the S50 Pro", () => {
		expect(bayerPattern(2, 1, 0)).toBe("GRBG");
		expect(bayerPattern(2, 0, 0)).toBe("RGGB");
		expect(bayerPattern(2, 0, 1)).toBe("GBRG");
		expect(bayerPattern(2, 1, 1)).toBe("BGGR");
	});

	it("has no pattern for a mono sensor", () => {
		expect(bayerPattern(0)).toBeUndefined();
	});
});

describe("frame helpers", () => {
	it("bins 2×2 blocks into luminance", () => {
		const plane = binnedLuminance(positional(4, 2));
		expect(plane.width).toBe(2);
		expect(plane.height).toBe(1);
		expect(Array.from(plane.data)).toEqual([0 + 1 + 100 + 101, 2 + 3 + 102 + 103]);
	});

	it("reports statistics, counting saturated pixels", () => {
		// 65520 is what a blown star reads on the Seestar: 12 bits shifted into 16.
		const image: AlpacaImage = {
			width: 2,
			height: 2,
			pixels: Int32Array.from([1, 60000, 65520, 65535]),
		};
		const stats = frameStats(image);
		expect(stats.min).toBe(1);
		expect(stats.max).toBe(65535);
		expect(stats.saturated).toBe(2);
	});

	it("makes a PNG preview", () => {
		const png = previewPng(positional(64, 32), { pattern: "GRBG", maxSize: 16 });
		expect(png.subarray(0, 8)).toEqual(
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		);
		// IHDR: width 16 (64 / 2 superpixel / 2 downscale), height 8.
		expect(png.readUInt32BE(16)).toBe(16);
		expect(png.readUInt32BE(20)).toBe(8);
	});
});

describe("FITS writer", () => {
	it("formats cards the way FITS readers expect", () => {
		expect(formatCard({ key: "exptime", value: 5 })).toBe(
			`EXPTIME =                    5${" ".repeat(50)}`,
		);
		expect(formatCard({ key: "OBJECT", value: "M45" }).slice(0, 30)).toBe(
			"OBJECT  = 'M45     '          ",
		);
		expect(formatCard({ key: "OBJECT", value: "it's" }).slice(10, 20)).toBe("'it''s   '");
		expect(formatCard({ key: "SIMPLE", value: true }).slice(0, 30)).toBe(
			`SIMPLE  = ${"T".padStart(20)}`,
		);
	});

	it("writes a 16-bit frame that the header reader understands", async () => {
		const image = positional(6, 4);
		const path = join(workDir, "frame16.fits");
		const file = encodeFits16(image.width, image.height, image.pixels, [
			{ key: "BAYERPAT", value: "GRBG" },
			{ key: "EXPTIME", value: 2.5 },
			// The writer owns these and must not let a caller break the file.
			{ key: "BITPIX", value: 8 },
		]);
		await writeFile(path, file);

		expect(file.length % 2880).toBe(0);
		const header = await readFitsHeader(path);
		expect(header.cards.get("BITPIX")).toBe(16);
		expect(header.cards.get("NAXIS1")).toBe(6);
		expect(header.cards.get("NAXIS2")).toBe(4);
		expect(header.cards.get("BZERO")).toBe(32768);
		expect(header.cards.get("BAYERPAT")).toBe("GRBG");
		expect(header.cards.get("EXPTIME")).toBe(2.5);
		expect(header.cards.get("ROWORDER")).toBe("TOP-DOWN");

		// Pixel (x=5, y=3) = 305, stored as signed 16-bit with BZERO.
		const headerBytes = 2880;
		expect(file.readInt16BE(headerBytes + (3 * 6 + 5) * 2) + 32768).toBe(305);
	});

	it("writes a float frame", () => {
		const file = encodeFitsFloat(2, 1, Float32Array.from([1.5, -2]));
		expect(file.readFloatBE(2880)).toBe(1.5);
		expect(file.readFloatBE(2884)).toBe(-2);
	});
});

describe("coordinates", () => {
	const night = new Date("2026-11-05T18:00:00Z");

	it("precesses J2000 to the equinox of date", () => {
		// The Double Cluster, checked against a hand calculation on the night of the first test.
		const now = j2000ToDate({ ra: 2.3333, dec: 57.1333 }, night);
		expect(now.ra).toBeCloseTo(2.3651, 3);
		expect(now.dec).toBeCloseTo(57.256, 2);
	});

	it("goes back to J2000 exactly", () => {
		for (const position of [
			{ ra: 0.1, dec: 89 },
			{ ra: 12, dec: -45 },
			{ ra: 23.9, dec: 0 },
		]) {
			const back = dateToJ2000(j2000ToDate(position, night), night);
			expect(separationDegrees(back, position) * 3600).toBeLessThan(0.01);
		}
	});

	it("measures separation", () => {
		expect(separationDegrees({ ra: 0, dec: 0 }, { ra: 1, dec: 0 })).toBeCloseTo(15, 9);
		expect(separationDegrees({ ra: 3, dec: 89 }, { ra: 15, dec: 89 })).toBeCloseTo(2, 9);
	});

	it("reads the mount's equinox from EquatorialSystem", () => {
		expect(equinoxOf(1)).toBe("date");
		expect(equinoxOf(2)).toBe("j2000");
		expect(equinoxOf(undefined)).toBe("date");
	});
});

describe("ASTAP", () => {
	// What ASTAP CLI-2026.10.30 wrote for the first M45 frame from the real telescope.
	const solved = [
		"PLTSOLVD=T",
		"CRPIX1= 5.4050000000000000E+002",
		"CRPIX2= 9.6050000000000000E+002",
		"CRVAL1= 5.6452623272390262E+001",
		"CRVAL2= 2.0456142327784942E+001",
		"CDELT1= 1.2466518686702170E-003",
		"CDELT2= 1.2462582171385314E-003",
		"CROTA1=-1.1655769605836896E+002",
		"CROTA2=-1.1655241309836642E+002",
		"CD1_1=-5.5737652117495589E-004",
		"CD1_2= 1.1151108892401007E-003",
		"CD2_1=-1.1148101459709982E-003",
		"CD2_2=-5.5709773130522839E-004",
		'WARNING=Warning scale was inaccurate! Set FOV=2.39d, scale=4.5", FL=267mm',
	].join("\n");

	it("reads a solution", () => {
		const solution = parseAstapIni(solved, 1080, 1920);
		expect(solution.center.ra).toBeCloseTo(3.76351, 4);
		expect(solution.center.dec).toBeCloseTo(20.4561, 4);
		expect(solution.scaleArcsec).toBeCloseTo(4.49, 1);
		expect(solution.heightDeg).toBeCloseTo(2.39, 1);
		expect(solution.warning).toMatch(/scale was inaccurate/);
	});

	it("says why there is no solution", () => {
		expect(() => parseAstapIni("PLTSOLVD=F\nERROR=Not enough stars", 10, 10)).toThrow(SolveError);
		expect(() => parseAstapIni("PLTSOLVD=F\nERROR=Not enough stars", 10, 10)).toThrow(
			/Not enough stars/,
		);
	});

	it("passes the hint as RA in hours and south-pole distance", () => {
		const args = astapArguments(
			"/tmp/frame.fits",
			{ hint: { ra: 3.79, dec: 24.1 }, radiusDeg: 15 },
			{ path: "/opt/astap/astap_cli", catalog: "d05" },
		);
		expect(args).toEqual([
			"-f",
			"/tmp/frame.fits",
			"-d",
			"/opt/astap",
			"-D",
			"d05",
			"-fov",
			"0",
			"-z",
			"0",
			"-ra",
			"3.79000",
			"-spd",
			"114.10000",
			"-r",
			"15",
		]);
	});

	it("searches the whole sky without a hint", () => {
		const args = astapArguments("/f.fits", {}, { path: "/a/astap_cli", databaseDir: "/db" });
		expect(args).toContain("/db");
		expect(args.slice(-2)).toEqual(["-r", "180"]);
	});
});

describe("framePath", () => {
	it("files a frame under the night it belongs to", () => {
		// 01:30 local belongs with the evening before.
		const late = new Date(2026, 10, 6, 1, 30, 5);
		expect(
			framePath({ captureDir: "/c", name: "M 45", exposureSeconds: 2.5, gain: 80 }, late),
		).toBe(join("/c", "2026-11-05", "M_45", "M_45_2p5s_g80_013005.fits"));
	});

	it("keeps centring frames in their own folder", () => {
		const evening = new Date(2026, 10, 5, 21, 0, 0);
		expect(
			framePath(
				{ captureDir: "/c", name: "M45", subdirectory: "center", exposureSeconds: 3 },
				evening,
			),
		).toBe(join("/c", "2026-11-05", "M45", "center", "M45_3s_210000.fits"));
	});

	it("cannot be steered out of the capture directory", () => {
		const path = framePath({ captureDir: "/c", name: "../../etc", exposureSeconds: 1 }, new Date());
		expect(path.startsWith(join("/c", ""))).toBe(true);
		expect(path).not.toContain("..");
	});
});

/**
 * A mount whose idea of where it points is off by a fixed amount until it is synced — what the
 * real one did after power-on — and a solver that reports where it really points.
 */
function mountModel(offset: Equatorial, options: { syncError?: Equatorial } = {}) {
	let believed: Equatorial = { ra: 0, dec: 0 };
	let error = { ...offset };
	const calls: string[] = [];
	const truth = () => ({ ra: believed.ra + error.ra, dec: believed.dec + error.dec });

	const deps: CenterDeps = {
		equinox: "j2000",
		now: () => new Date("2026-11-05T18:00:00Z"),
		slew: async (position) => {
			calls.push("slew");
			believed = { ...position };
		},
		sync: async (position) => {
			calls.push("sync");
			// After a sync the mount's belief matches the given position; what is left is how wrong
			// that position was.
			const real = truth();
			error = options.syncError ?? { ra: real.ra - position.ra, dec: real.dec - position.dec };
			believed = { ra: real.ra - error.ra, dec: real.dec - error.dec };
		},
		mountPosition: async () => believed,
		captureAndSolve: async () => {
			calls.push("solve");
			return {
				path: `/frames/${calls.length}.fits`,
				solution: {
					center: truth(),
					scaleArcsec: 4.5,
					rotationDeg: 0,
					widthDeg: 1.35,
					heightDeg: 2.39,
				},
			};
		},
	};
	return { deps, calls };
}

describe("centerOn", () => {
	const target = { ra: 3.79, dec: 24.12 };

	it("corrects a 3.8° pointing error with one sync", async () => {
		const { deps, calls } = mountModel({ ra: -0.0, dec: -3.8 });
		const report = await centerOn(target, { toleranceArcmin: 2, maxAttempts: 3 }, deps);

		expect(report.centered).toBe(true);
		expect(report.attempts).toHaveLength(2);
		expect(report.attempts[0]?.errorArcmin).toBeCloseTo(228, 0);
		expect(report.attempts[0]?.synced).toBe(true);
		expect(report.attempts[1]?.errorArcmin).toBeLessThan(0.01);
		expect(calls).toEqual(["slew", "solve", "sync", "slew", "solve"]);
	});

	it("does not sync when the first goto is already good enough", async () => {
		const { deps, calls } = mountModel({ ra: 0, dec: 0.01 });
		const report = await centerOn(target, { toleranceArcmin: 2, maxAttempts: 3 }, deps);
		expect(report.centered).toBe(true);
		expect(calls).toEqual(["slew", "solve"]);
	});

	it("gives up after the last attempt, without a pointless final sync", async () => {
		// A mount that never takes the correction.
		const { deps, calls } = mountModel({ ra: 0, dec: 1 }, { syncError: { ra: 0, dec: 1 } });
		const report = await centerOn(target, { toleranceArcmin: 2, maxAttempts: 2 }, deps);

		expect(report.centered).toBe(false);
		expect(report.attempts).toHaveLength(2);
		expect(calls).toEqual(["slew", "solve", "sync", "slew", "solve"]);
		expect(report.attempts[1]?.synced).toBe(false);
	});

	it("slews in mount coordinates when the mount works in the equinox of date", async () => {
		const { deps } = mountModel({ ra: 0, dec: 0 });
		const slews: Equatorial[] = [];
		const slew = deps.slew;
		deps.equinox = "date";
		deps.slew = async (position) => {
			slews.push(position);
			await slew(position);
		};

		await centerOn(target, { toleranceArcmin: 60, maxAttempts: 1 }, deps);
		expect(slews[0]?.ra).toBeCloseTo(j2000ToDate(target, new Date("2026-11-05T18:00:00Z")).ra, 9);
	});

	it("passes solver failures through", async () => {
		const { deps } = mountModel({ ra: 0, dec: 0 });
		deps.captureAndSolve = async () => {
			throw new SolveError("ASTAP found no solution: Not enough stars");
		};
		await expectFailure(centerOn(target, { toleranceArcmin: 2, maxAttempts: 3 }, deps), SolveError);
	});
});
