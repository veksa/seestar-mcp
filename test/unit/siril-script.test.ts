import { describe, expect, it } from "vitest";
import {
	buildExportScript,
	buildStackScript,
	quote,
	renderScript,
} from "../../src/processing/siril.js";

/**
 * The scripts are the part we actually write.
 *
 * Everything else in the processing layer is Siril doing the work, so these assertions are on the
 * exact text handed to it — command names and option spellings taken from `help <command>` of
 * Siril 1.4.4, not from memory.
 */

describe("buildStackScript", () => {
	it("converts, registers and stacks, in that order", () => {
		const script = buildStackScript({
			inputDir: "/data/M31/raw",
			outputDir: "/data/M31/process",
			output: "stacked",
		});

		expect(script).toEqual([
			"requires 1.4.0",
			"setext fit",
			"cd /data/M31/raw",
			"convert light -out=/data/M31/process",
			"cd /data/M31/process",
			"register light",
			"stack r_light rej w 3 3 -norm=addscale -out=stacked",
		]);
	});

	it("skips registration when the frames are already aligned", () => {
		const script = buildStackScript({
			inputDir: "/data/raw",
			outputDir: "/data/process",
			output: "stacked",
			register: false,
		});

		expect(script).not.toContain("register light");
		expect(script.at(-1)).toContain("stack light ");
	});

	it("uses the letter Siril expects for each rejection algorithm", () => {
		const sigma = buildStackScript({
			inputDir: "/a",
			outputDir: "/b",
			output: "out",
			rejection: "sigma",
			sigmaLow: 2.5,
			sigmaHigh: 2,
		});

		expect(sigma.at(-1)).toBe("stack r_light rej s 2.5 2 -norm=addscale -out=out");
	});

	it("leaves the sigma bounds out when rejection is off", () => {
		const script = buildStackScript({
			inputDir: "/a",
			outputDir: "/b",
			output: "out",
			rejection: "none",
		});

		expect(script.at(-1)).toBe("stack r_light rej n -norm=addscale -out=out");
	});

	it("keeps only the best frames, by FWHM", () => {
		const script = buildStackScript({
			inputDir: "/a",
			outputDir: "/b",
			output: "out",
			bestPercent: 80,
		});

		expect(script.at(-1)).toContain("-filter-fwhm=80%");
	});

	it("does not filter by FWHM without registration, since there would be no data to filter on", () => {
		const script = buildStackScript({
			inputDir: "/a",
			outputDir: "/b",
			output: "out",
			bestPercent: 80,
			register: false,
		});

		expect(script.at(-1)).not.toContain("-filter-fwhm");
	});

	it("calibrates first when masters are given, and stacks the pp_ sequence", () => {
		const script = buildStackScript({
			inputDir: "/a",
			outputDir: "/b",
			output: "out",
			dark: "/masters/dark.fit",
			flat: "/masters/flat.fit",
		});

		expect(script).toContain("calibrate light -dark=/masters/dark.fit -flat=/masters/flat.fit");
		expect(script).toContain("register pp_light");
		expect(script.at(-1)).toContain("stack r_pp_light ");
	});

	it("turns off normalization with the flag rather than an empty value", () => {
		const script = buildStackScript({
			inputDir: "/a",
			outputDir: "/b",
			output: "out",
			normalization: "none",
		});

		expect(script.at(-1)).toContain("-nonorm");
		expect(script.at(-1)).not.toContain("-norm=");
	});

	it("quotes paths with spaces", () => {
		const script = buildStackScript({
			inputDir: "C:/Users/me/My Astro/raw",
			outputDir: "C:/Users/me/My Astro/process",
			output: "stacked",
		});

		expect(script).toContain('cd "C:/Users/me/My Astro/raw"');
		expect(script).toContain('convert light -out="C:/Users/me/My Astro/process"');
	});
});

describe("buildExportScript", () => {
	it("loads, stretches and saves a PNG", () => {
		expect(
			buildExportScript({ inputDir: "/data/process", input: "stacked", output: "m31" }),
		).toEqual([
			"requires 1.4.0",
			"setext fit",
			"cd /data/process",
			"load stacked",
			"autostretch",
			"savepng m31",
		]);
	});

	it("can skip the stretch, for data that is already stretched", () => {
		const script = buildExportScript({
			inputDir: "/d",
			input: "stacked",
			output: "m31",
			stretch: false,
		});

		expect(script).not.toContain("autostretch");
	});

	it("passes the quality to savejpg", () => {
		const script = buildExportScript({
			inputDir: "/d",
			input: "stacked",
			output: "m31",
			format: "jpg",
			quality: 75,
		});

		expect(script.at(-1)).toBe("savejpg m31 75");
	});

	it("writes TIFF with savetif", () => {
		const script = buildExportScript({
			inputDir: "/d",
			input: "stacked",
			output: "m31",
			format: "tif",
		});

		expect(script.at(-1)).toBe("savetif m31");
	});
});

describe("quote and renderScript", () => {
	it("only quotes what needs it", () => {
		expect(quote("/simple/path")).toBe("/simple/path");
		expect(quote("/with space/path")).toBe('"/with space/path"');
	});

	it("renders one command per line, with a trailing newline", () => {
		expect(renderScript(["requires 1.4.0", "close"])).toBe("requires 1.4.0\nclose\n");
	});
});
