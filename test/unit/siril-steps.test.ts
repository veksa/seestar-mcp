import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	backgroundCommands,
	buildOperationScript,
	buildSessionScript,
	colorCalibrationCommands,
	deconvolveCommands,
	denoiseCommands,
	graxpertCommands,
	PRESETS,
	shapeCommands,
	starRemovalCommands,
	stretchCommands,
} from "../../src/processing/siril.js";

/**
 * The commands for each processing step.
 *
 * Every spelling here was read from `help <command>` of Siril 1.4.4 — these tests are what keeps
 * them from drifting into something that only looks plausible.
 */

describe("buildOperationScript", () => {
	it("wraps the work in load and save", () => {
		expect(
			buildOperationScript({
				directory: "/data/process",
				input: "stacked",
				output: "result",
				commands: ["subsky -rbf"],
			}),
		).toEqual([
			"requires 1.4.0",
			"setext fit",
			"cd /data/process",
			"load stacked",
			"subsky -rbf",
			"save result",
		]);
	});

	it("leaves out the save when there is nothing to write", () => {
		const script = buildOperationScript({
			directory: "/d",
			input: "stacked",
			commands: ["stat"],
		});

		expect(script.some((line) => line.startsWith("save"))).toBe(false);
	});
});

describe("background extraction", () => {
	it("uses the RBF model by default", () => {
		expect(backgroundCommands({})).toEqual(["subsky -rbf"]);
	});

	it("takes a polynomial degree instead, when one is given", () => {
		expect(backgroundCommands({ degree: 4 })).toEqual(["subsky 4"]);
	});

	it("passes the sampling options through", () => {
		expect(backgroundCommands({ samples: 30, tolerance: 2.5, smooth: 0.4, dither: true })).toEqual([
			"subsky -rbf -dither -samples=30 -tolerance=2.5 -smooth=0.4",
		]);
	});
});

describe("denoise", () => {
	it("runs Siril's own denoiser, blending most of it back by default", () => {
		// Full strength trades the grain for low-frequency mottle, which reads worse than the noise.
		expect(denoiseCommands({})).toEqual(["denoise -mod=0.7"]);
		expect(denoiseCommands({ modulation: 1 })).toEqual(["denoise -mod=1"]);
	});

	it("can skip the cosmetic correction it does by default", () => {
		expect(denoiseCommands({ noCosmetic: true })).toEqual(["denoise -nocosmetic -mod=0.7"]);
	});
});

describe("GraXpert through Siril", () => {
	it("calls the bundled script with the right flag for each operation", () => {
		expect(graxpertCommands("background")).toEqual(["pyscript GraXpert-AI.py -bge"]);
		expect(graxpertCommands("denoise")).toEqual(["pyscript GraXpert-AI.py -denoise"]);
		expect(graxpertCommands("deconvolve-object")).toEqual(["pyscript GraXpert-AI.py -deconv_obj"]);
		expect(graxpertCommands("deconvolve-stars")).toEqual([
			"pyscript GraXpert-AI.py -deconv_stellar",
		]);
	});

	it("quotes the model version the way the script expects", () => {
		expect(graxpertCommands("denoise", { model: "3.0.1" })).toEqual([
			"pyscript GraXpert-AI.py -denoise -model='3.0.1'",
		]);
	});

	it("appends anything else verbatim", () => {
		expect(graxpertCommands("denoise", { extraArgs: ["-strength", "0.5"] })).toEqual([
			"pyscript GraXpert-AI.py -denoise -strength 0.5",
		]);
	});
});

describe("deconvolution", () => {
	it("measures a PSF from the stars before deconvolving", () => {
		expect(deconvolveCommands({})).toEqual(["makepsf stars", "rl"]);
	});

	it("takes the iteration count and a blind PSF", () => {
		expect(deconvolveCommands({ psf: "blind", iterations: 25, alpha: 500 })).toEqual([
			"makepsf blind",
			"rl -iters=25 -alpha=500",
		]);
	});
});

describe("colour calibration", () => {
	it("plate-solves first, because both methods need it", () => {
		expect(colorCalibrationCommands({})).toEqual(["platesolve", "pcc"]);
	});

	it("skips solving for an image that already carries a solution", () => {
		expect(colorCalibrationCommands({ platesolve: false, method: "spcc" })).toEqual(["spcc"]);
	});

	it("passes the catalog and magnitude limit", () => {
		expect(
			colorCalibrationCommands({ platesolve: false, limitMagnitude: 17, catalog: "apass" }),
		).toEqual(["pcc -limitmag=17 -catalog=apass"]);
	});
});

describe("stretch", () => {
	it("defaults to auto-stretch, at a sky brightness someone would export at", () => {
		// Not a bare "autostretch": Siril's own default target background is 0.25, which is the
		// GUI's screen preview and leaves a real stack washed out at about 64/255.
		expect(stretchCommands({})).toEqual(["autostretch -2.8 0.08"]);
		expect(stretchCommands({ linked: true, targetBackground: 0.12 })).toEqual([
			"autostretch -linked -2.8 0.12",
		]);
	});

	it("keeps the clipping point when only the background is asked for", () => {
		// targetbg is the second positional argument, so it cannot be given on its own.
		expect(stretchCommands({ shadowsClip: -1.5, targetBackground: 0.1 })).toEqual([
			"autostretch -1.5 0.1",
		]);
	});

	it("gives asinh its mandatory stretch factor", () => {
		expect(stretchCommands({ method: "asinh" })).toEqual(["asinh 100"]);
		expect(stretchCommands({ method: "asinh", amount: 250 })).toEqual(["asinh 250"]);
	});

	it("passes both mandatory arguments to the hyperbolic stretch", () => {
		expect(stretchCommands({ method: "ghs", shadowsClip: -1, amount: 8 })).toEqual([
			"autoghs -1 8",
		]);
	});
});

describe("star removal", () => {
	it("keeps the star mask unless asked not to", () => {
		expect(starRemovalCommands({})).toEqual(["starnet"]);
		expect(starRemovalCommands({ starMask: false })).toEqual(["starnet -nostarmask"]);
	});

	it("passes the stretch and stride options", () => {
		expect(starRemovalCommands({ stretch: true, stride: 128 })).toEqual([
			"starnet -stretch -stride=128",
		]);
	});
});

describe("shapeCommands", () => {
	it("puts the symmetry point above the sky, where the object is", () => {
		// The same argument slot as autostretch's shadows clip, but the opposite intent: autostretch
		// clips below its value, autoghs stretches hardest at it. Zero would amplify the noise.
		expect(shapeCommands({})).toEqual(["autoghs -linked 3 0.1 -hp=0.9"]);
		expect(shapeCommands({ symmetry: 3, amount: 1.5, highlights: 0.95 })).toEqual([
			"autoghs -linked 3 1.5 -hp=0.95",
		]);
	});

	it("can stretch the channels apart, for data whose colour was never calibrated", () => {
		expect(shapeCommands({ linked: false })).toEqual(["autoghs 3 0.1 -hp=0.9"]);
	});
});

describe("buildSessionScript", () => {
	it("runs the whole night in one Siril session, with the image staying loaded", () => {
		const script = buildSessionScript({
			inputDir: "/data/M31/raw",
			outputDir: "/data/M31/process",
			output: "stacked",
			bestPercent: 90,
			background: "siril",
			colorCalibrate: true,
			stretch: "auto",
			exportName: "m31",
			exportFormat: "png",
		});

		expect(script).toEqual([
			"requires 1.4.0",
			"setext fit",
			"cd /data/M31/raw",
			"convert light -out=/data/M31/process",
			"cd /data/M31/process",
			"register light",
			"stack r_light rej w 3 3 -norm=addscale -filter-fwhm=90% -out=stacked",
			"load stacked",
			"subsky -rbf",
			"platesolve",
			"pcc",
			"autostretch -linked -2.8 0.08",
			"save stacked_processed",
			"savepng m31",
		]);
	});

	it("writes the finished picture to the result directory, not among the intermediates", () => {
		const script = buildSessionScript({
			inputDir: "/data/M31/raw",
			outputDir: "/data/M31/process",
			output: "stacked",
			stretch: "auto",
			exportName: "m31",
			exportFormat: "jpg",
			exportDir: "/data/M31/result",
		});

		// The FITS stays where the stack is; only the picture leaves.
		expect(script).toContain("save stacked_processed");
		expect(script).toContain(`savejpg ${join("/data/M31/result", "m31")} 90`);
	});

	it("links the channels when the colour has been calibrated, and not otherwise", () => {
		// Siril's help for autostretch: "Do not use the unlinked version after color calibration,
		// it will alter the white balance." Whether pcc ran is what decides it.
		const base = { inputDir: "/a", outputDir: "/b", output: "stacked", stretch: "auto" } as const;

		expect(buildSessionScript({ ...base, colorCalibrate: true })).toContain(
			"autostretch -linked -2.8 0.08",
		);
		expect(buildSessionScript({ ...base, colorCalibrate: false })).toContain(
			"autostretch -2.8 0.08",
		);
	});

	it("calibrates the colour before denoising, not after", () => {
		// pcc measures the flux of catalogued stars; denoise and deconvolution both alter the very
		// fluxes it is about to measure, so they have to come after it.
		const script = buildSessionScript({
			inputDir: "/a",
			outputDir: "/b",
			output: "stacked",
			colorCalibrate: true,
			denoise: "siril",
			deconvolve: true,
		});

		expect(script.indexOf("pcc")).toBeLessThan(script.indexOf("denoise -mod=0.7"));
		expect(script.indexOf("pcc")).toBeLessThan(script.indexOf("makepsf stars"));
	});

	it("shapes after the stretch, never before it", () => {
		const script = buildSessionScript({
			inputDir: "/a",
			outputDir: "/b",
			output: "stacked",
			colorCalibrate: true,
			stretch: "auto",
			shape: "ghs",
		});

		expect(script.indexOf("autostretch -linked -2.8 0.08")).toBeLessThan(
			script.indexOf("autoghs -linked 3 0.1 -hp=0.9"),
		);
	});

	it("does not shape data that was never stretched", () => {
		// autoghs redistributes the tones a stretch produced; on linear data it does almost nothing,
		// so asking for it without a stretch is a mistake worth not honouring.
		const script = buildSessionScript({
			inputDir: "/a",
			outputDir: "/b",
			output: "stacked",
			stretch: "none",
			shape: "ghs",
		});

		expect(script.some((line) => line.startsWith("autoghs"))).toBe(false);
	});

	it("puts star removal last, after the stretch", () => {
		const script = buildSessionScript({
			inputDir: "/a",
			outputDir: "/b",
			output: "stacked",
			stretch: "auto",
			removeStars: true,
		});

		expect(script.indexOf("starnet")).toBeGreaterThan(script.indexOf("autostretch"));
	});

	it("uses GraXpert for both AI steps when asked", () => {
		const script = buildSessionScript({
			inputDir: "/a",
			outputDir: "/b",
			output: "stacked",
			background: "graxpert",
			denoise: "graxpert",
			graxpertModel: "3.0.1",
		});

		expect(script).toContain("pyscript GraXpert-AI.py -bge -model='3.0.1'");
		expect(script).toContain("pyscript GraXpert-AI.py -denoise -model='3.0.1'");
	});

	it("skips every optional step when nothing is asked for", () => {
		const script = buildSessionScript({
			inputDir: "/a",
			outputDir: "/b",
			output: "stacked",
			background: "none",
			denoise: "none",
			stretch: "none",
		});

		expect(script.filter((line) => /subsky|denoise|pcc|autostretch|starnet/.test(line))).toEqual(
			[],
		);
		expect(script.at(-1)).toBe("save stacked_processed");
	});
});

describe("presets", () => {
	it("quick does the minimum: no gradient work, no colour, just a stretch", () => {
		expect(PRESETS.quick).toMatchObject({ background: "none", denoise: "none", stretch: "auto" });
	});

	it("standard drops the worst frames and fixes the sky and colour", () => {
		expect(PRESETS.standard).toMatchObject({
			bestPercent: 90,
			background: "siril",
			colorCalibrate: true,
		});
	});

	it("full turns on the AI steps, which is what needs GraXpert", () => {
		expect(PRESETS.full).toMatchObject({
			background: "graxpert",
			denoise: "graxpert",
			deconvolve: true,
		});
	});
});
