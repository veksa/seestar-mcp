import { describe, expect, it } from "vitest";
import {
	backgroundCommands,
	buildOperationScript,
	colorCalibrationCommands,
	deconvolveCommands,
	denoiseCommands,
	graxpertCommands,
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
	it("runs Siril's own denoiser", () => {
		expect(denoiseCommands({})).toEqual(["denoise"]);
		expect(denoiseCommands({ modulation: 0.7 })).toEqual(["denoise -mod=0.7"]);
	});

	it("can skip the cosmetic correction it does by default", () => {
		expect(denoiseCommands({ noCosmetic: true })).toEqual(["denoise -nocosmetic"]);
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
	it("defaults to auto-stretch", () => {
		expect(stretchCommands({})).toEqual(["autostretch"]);
		expect(stretchCommands({ linked: true, shadowsClip: -2.8 })).toEqual([
			"autostretch -linked -2.8",
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
