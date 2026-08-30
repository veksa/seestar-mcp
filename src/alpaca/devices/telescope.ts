import type { RequestOptions } from "../client.js";
import { AlpacaDevice } from "../device.js";

/** Everything worth knowing about where a mount is pointing and what it is doing. */
export interface TelescopeStatus {
	connected: boolean;
	name?: string;
	rightAscension?: number;
	declination?: number;
	altitude?: number;
	azimuth?: number;
	slewing?: boolean;
	tracking?: boolean;
	atPark?: boolean;
	atHome?: boolean;
	siderealTime?: number;
	siteLatitude?: number;
	siteLongitude?: number;
	siteElevation?: number;
	utcDate?: string;
	/** Properties the mount would not answer, with the reason. */
	unavailable: Record<string, string>;
}

/** What the mount says it can do. Drivers vary wildly, so ask rather than assume. */
export interface TelescopeCapabilities {
	canSlew?: boolean;
	canSlewAsync?: boolean;
	canSync?: boolean;
	canPark?: boolean;
	canUnpark?: boolean;
	canFindHome?: boolean;
	canSetTracking?: boolean;
	canPulseGuide?: boolean;
	unavailable: Record<string, string>;
}

const STATUS_PROPERTIES = {
	connected: "connected",
	name: "name",
	rightAscension: "rightascension",
	declination: "declination",
	altitude: "altitude",
	azimuth: "azimuth",
	slewing: "slewing",
	tracking: "tracking",
	atPark: "atpark",
	atHome: "athome",
	siderealTime: "siderealtime",
	siteLatitude: "sitelatitude",
	siteLongitude: "sitelongitude",
	siteElevation: "siteelevation",
	utcDate: "utcdate",
} as const;

const CAPABILITY_PROPERTIES = {
	canSlew: "canslew",
	canSlewAsync: "canslewasync",
	canSync: "cansync",
	canPark: "canpark",
	canUnpark: "canunpark",
	canFindHome: "canfindhome",
	canSetTracking: "cansettracking",
	canPulseGuide: "canpulseguide",
} as const;

/** A telescope on an Alpaca server (ASCOM `ITelescopeV3`). */
export class Telescope extends AlpacaDevice {
	constructor(client: ConstructorParameters<typeof AlpacaDevice>[0], deviceNumber: number) {
		super(client, "telescope", deviceNumber);
	}

	/**
	 * One round of parallel reads.
	 *
	 * Tolerant on purpose: a mount that does not implement `athome` should still report where it is
	 * pointing, so failures land in `unavailable` instead of sinking the whole status.
	 */
	async status(options?: RequestOptions): Promise<TelescopeStatus> {
		const collected = await readMany(this, STATUS_PROPERTIES, options);
		return {
			connected: collected.values.connected === true,
			...collected.values,
			unavailable: collected.unavailable,
		} as TelescopeStatus;
	}

	async capabilities(options?: RequestOptions): Promise<TelescopeCapabilities> {
		const collected = await readMany(this, CAPABILITY_PROPERTIES, options);
		return { ...collected.values, unavailable: collected.unavailable } as TelescopeCapabilities;
	}

	rightAscension(options?: RequestOptions): Promise<number> {
		return this.get<number>("rightascension", undefined, options);
	}

	declination(options?: RequestOptions): Promise<number> {
		return this.get<number>("declination", undefined, options);
	}

	isSlewing(options?: RequestOptions): Promise<boolean> {
		return this.get<boolean>("slewing", undefined, options);
	}

	/**
	 * Start a slew and return immediately.
	 *
	 * The synchronous `slewtocoordinates` is deliberately not wrapped: it holds the HTTP connection
	 * open for the whole slew, which is exactly what an MCP server must not do.
	 */
	async slewToCoordinates(ra: number, dec: number, options?: RequestOptions): Promise<void> {
		await this.put("slewtocoordinatesasync", { RightAscension: ra, Declination: dec }, options);
	}

	async syncToCoordinates(ra: number, dec: number, options?: RequestOptions): Promise<void> {
		await this.put("synctocoordinates", { RightAscension: ra, Declination: dec }, options);
	}

	async abortSlew(options?: RequestOptions): Promise<void> {
		await this.put("abortslew", undefined, options);
	}

	async park(options?: RequestOptions): Promise<void> {
		await this.put("park", undefined, options);
	}

	async unpark(options?: RequestOptions): Promise<void> {
		await this.put("unpark", undefined, options);
	}

	async findHome(options?: RequestOptions): Promise<void> {
		await this.put("findhome", undefined, options);
	}

	async setTracking(tracking: boolean, options?: RequestOptions): Promise<void> {
		await this.put("tracking", { Tracking: tracking }, options);
	}

	/** Poll until the mount stops slewing. Callers own the timeout. */
	async waitForSlewComplete(
		options: RequestOptions & { pollIntervalMs?: number; timeoutMs?: number } = {},
	): Promise<boolean> {
		const pollIntervalMs = options.pollIntervalMs ?? 1_000;
		const deadline = Date.now() + (options.timeoutMs ?? 120_000);

		while (Date.now() < deadline) {
			if (options.signal?.aborted) return false;
			if (!(await this.isSlewing(options))) return true;
			await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
		}

		return false;
	}
}

async function readMany<T extends Record<string, string>>(
	device: AlpacaDevice,
	properties: T,
	options?: RequestOptions,
): Promise<{ values: Record<string, unknown>; unavailable: Record<string, string> }> {
	const keys = Object.keys(properties) as (keyof T & string)[];
	const results = await Promise.allSettled(
		keys.map((key) => device.get<unknown>(properties[key] as string, undefined, options)),
	);

	const values: Record<string, unknown> = {};
	const unavailable: Record<string, string> = {};

	keys.forEach((key, index) => {
		const result = results[index];
		if (!result) return;
		if (result.status === "fulfilled") values[key] = result.value;
		else {
			unavailable[key] =
				result.reason instanceof Error ? result.reason.message : String(result.reason);
		}
	});

	return { values, unavailable };
}
