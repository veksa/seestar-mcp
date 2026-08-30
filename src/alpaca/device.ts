import type { AlpacaClient, AlpacaParams, DeviceType, RequestOptions } from "./client.js";

/** The properties every Alpaca device exposes, regardless of type. */
export interface DeviceDescription {
	deviceType: DeviceType;
	deviceNumber: number;
	name?: string;
	description?: string;
	driverInfo?: string;
	driverVersion?: string;
	interfaceVersion?: number;
	supportedActions?: string[];
	connected?: boolean;
	/** Properties the device refused to answer, with the reason. */
	unavailable: Record<string, string>;
}

/**
 * One device on one Alpaca server.
 *
 * Covers the common interface (ASCOM `IDeviceV2`) that telescopes, cameras, focusers and the rest
 * all share. Type-specific facades build on this.
 */
export class AlpacaDevice {
	constructor(
		readonly client: AlpacaClient,
		readonly deviceType: DeviceType,
		readonly deviceNumber: number,
	) {}

	/** `telescope/1`, for logs and error messages. */
	get id(): string {
		return `${this.deviceType}/${this.deviceNumber}`;
	}

	get<T>(method: string, params?: AlpacaParams, options?: RequestOptions): Promise<T> {
		return this.client.get<T>(this.deviceType, this.deviceNumber, method, params, options);
	}

	put<T>(method: string, params?: AlpacaParams, options?: RequestOptions): Promise<T> {
		return this.client.put<T>(this.deviceType, this.deviceNumber, method, params, options);
	}

	isConnected(options?: RequestOptions): Promise<boolean> {
		return this.get<boolean>("connected", undefined, options);
	}

	async setConnected(connected: boolean, options?: RequestOptions): Promise<void> {
		await this.put("connected", { Connected: connected }, options);
	}

	name(options?: RequestOptions): Promise<string> {
		return this.get<string>("name", undefined, options);
	}

	description(options?: RequestOptions): Promise<string> {
		return this.get<string>("description", undefined, options);
	}

	driverInfo(options?: RequestOptions): Promise<string> {
		return this.get<string>("driverinfo", undefined, options);
	}

	driverVersion(options?: RequestOptions): Promise<string> {
		return this.get<string>("driverversion", undefined, options);
	}

	interfaceVersion(options?: RequestOptions): Promise<number> {
		return this.get<number>("interfaceversion", undefined, options);
	}

	/**
	 * Actions the driver claims to support.
	 *
	 * Worth knowing: seestar_alp always returns an empty list here, so an empty result means
	 * "unknown", not "none". Seestar's real action set is hard-coded in `src/seestar/`.
	 */
	supportedActions(options?: RequestOptions): Promise<string[]> {
		return this.get<string[]>("supportedactions", undefined, options);
	}

	/** Invoke a driver-specific action. `parameters` goes on the wire as a single string. */
	action(action: string, parameters = "", options?: RequestOptions): Promise<string> {
		return this.put<string>("action", { Action: action, Parameters: parameters }, options);
	}

	async commandBlind(command: string, raw = false, options?: RequestOptions): Promise<void> {
		await this.put("commandblind", { Command: command, Raw: raw }, options);
	}

	commandBool(command: string, raw = false, options?: RequestOptions): Promise<boolean> {
		return this.put<boolean>("commandbool", { Command: command, Raw: raw }, options);
	}

	commandString(command: string, raw = false, options?: RequestOptions): Promise<string> {
		return this.put<string>("commandstring", { Command: command, Raw: raw }, options);
	}

	/**
	 * Everything we can learn about the device in one round of parallel requests.
	 *
	 * Deliberately tolerant: a driver that does not implement a property should not sink the whole
	 * description, so failures are collected in `unavailable` instead of thrown.
	 */
	async describe(options?: RequestOptions): Promise<DeviceDescription> {
		const probes = {
			name: () => this.name(options),
			description: () => this.description(options),
			driverInfo: () => this.driverInfo(options),
			driverVersion: () => this.driverVersion(options),
			interfaceVersion: () => this.interfaceVersion(options),
			supportedActions: () => this.supportedActions(options),
			connected: () => this.isConnected(options),
		} as const;

		const keys = Object.keys(probes) as (keyof typeof probes)[];
		const results = await Promise.allSettled(keys.map((key) => probes[key]()));

		const described: DeviceDescription = {
			deviceType: this.deviceType,
			deviceNumber: this.deviceNumber,
			unavailable: {},
		};

		keys.forEach((key, index) => {
			const result = results[index];
			if (!result) return;
			if (result.status === "fulfilled") {
				Object.assign(described, { [key]: result.value });
			} else {
				described.unavailable[key] =
					result.reason instanceof Error ? result.reason.message : String(result.reason);
			}
		});

		return described;
	}
}
