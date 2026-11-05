import type { RequestOptions } from "../client.js";
import { AlpacaDevice } from "../device.js";
import type { AlpacaImage } from "../imagebytes.js";
import { readMany } from "./telescope.js";

/** ASCOM SensorType. */
export const SensorType = {
	Monochrome: 0,
	Color: 1,
	RGGB: 2,
	CMYG: 3,
	CMYG2: 4,
	LRGB: 5,
} as const;

/** ASCOM CameraStates. */
export const CameraState = {
	Idle: 0,
	Waiting: 1,
	Exposing: 2,
	Reading: 3,
	Download: 4,
	Error: 5,
} as const;

/** What a camera says about itself — the parts that matter for taking and labelling a frame. */
export interface CameraInfo {
	name?: string;
	sensorName?: string;
	sensorType?: number;
	width?: number;
	height?: number;
	pixelSizeX?: number;
	pixelSizeY?: number;
	bayerOffsetX?: number;
	bayerOffsetY?: number;
	gain?: number;
	gainMin?: number;
	gainMax?: number;
	offset?: number;
	exposureMin?: number;
	exposureMax?: number;
	maxAdu?: number;
	ccdTemperature?: number;
	cameraState?: number;
	unavailable: Record<string, string>;
}

const INFO_PROPERTIES = {
	name: "name",
	sensorName: "sensorname",
	sensorType: "sensortype",
	width: "cameraxsize",
	height: "cameraysize",
	pixelSizeX: "pixelsizex",
	pixelSizeY: "pixelsizey",
	bayerOffsetX: "bayeroffsetx",
	bayerOffsetY: "bayeroffsety",
	gain: "gain",
	gainMin: "gainmin",
	gainMax: "gainmax",
	offset: "offset",
	exposureMin: "exposuremin",
	exposureMax: "exposuremax",
	maxAdu: "maxadu",
	ccdTemperature: "ccdtemperature",
	cameraState: "camerastate",
} as const;

/** A camera on an Alpaca server (ASCOM `ICameraV3`). */
export class Camera extends AlpacaDevice {
	constructor(client: ConstructorParameters<typeof AlpacaDevice>[0], deviceNumber: number) {
		super(client, "camera", deviceNumber);
	}

	/** One round of parallel reads; whatever the camera refuses lands in `unavailable`. */
	async info(options?: RequestOptions): Promise<CameraInfo> {
		const collected = await readMany(this, INFO_PROPERTIES, options);
		return { ...collected.values, unavailable: collected.unavailable } as CameraInfo;
	}

	gain(options?: RequestOptions): Promise<number> {
		return this.get<number>("gain", undefined, options);
	}

	async setGain(gain: number, options?: RequestOptions): Promise<void> {
		await this.put("gain", { Gain: gain }, options);
	}

	cameraState(options?: RequestOptions): Promise<number> {
		return this.get<number>("camerastate", undefined, options);
	}

	imageReady(options?: RequestOptions): Promise<boolean> {
		return this.get<boolean>("imageready", undefined, options);
	}

	/** Start an exposure and return at once; poll `imageReady`. */
	async startExposure(seconds: number, light = true, options?: RequestOptions): Promise<void> {
		await this.put("startexposure", { Duration: seconds, Light: light }, options);
	}

	async abortExposure(options?: RequestOptions): Promise<void> {
		await this.put("abortexposure", undefined, options);
	}

	/** Download the last image. Frames are large: give this a generous timeout. */
	image(options?: RequestOptions): Promise<AlpacaImage> {
		return this.client.getImage(this.deviceType, this.deviceNumber, "imagearray", options);
	}

	/**
	 * Poll until the image is ready.
	 *
	 * Returns false on timeout. The poll interval is short because the readout after a short
	 * exposure takes about as long as the exposure itself on a Seestar, and every second counts when
	 * the frame is only there to be plate-solved.
	 */
	async waitForImage(
		options: RequestOptions & { pollIntervalMs?: number; timeoutMs?: number } = {},
	): Promise<boolean> {
		const pollIntervalMs = options.pollIntervalMs ?? 500;
		const deadline = Date.now() + (options.timeoutMs ?? 60_000);

		while (Date.now() < deadline) {
			if (options.signal?.aborted) return false;
			if (await this.imageReady(options)) return true;
			await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
		}
		return false;
	}
}
