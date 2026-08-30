import { AlpacaClient, type DeviceType } from "./alpaca/client.js";
import { AlpacaDevice } from "./alpaca/device.js";
import { Telescope } from "./alpaca/devices/telescope.js";
import type { ServerConfig } from "./config.js";

/** Raised when a tool needs a device and there is none — always with a way out in the message. */
export class SessionError extends Error {}

export interface Target {
	host: string;
	port: number;
	deviceType: DeviceType;
	deviceNumber: number;
}

export interface ConnectOptions {
	host?: string;
	port?: number;
	deviceType?: DeviceType;
	deviceNumber?: number;
}

/**
 * Which device the tools act on, for the life of the process.
 *
 * The server can be started already pointed at a telescope (`--host`), or the model can find one
 * with `alpaca_discover` and select it with `device_connect`. Either way, tools ask the session
 * rather than carrying host and port through every call.
 */
export class Session {
	private currentTarget: Target | undefined;
	private readonly clients = new Map<string, AlpacaClient>();
	private seestarCache = new Map<string, boolean>();

	constructor(readonly config: ServerConfig) {
		if (config.host) {
			this.currentTarget = {
				host: config.host,
				port: config.port,
				deviceType: config.deviceType,
				deviceNumber: config.deviceNumber,
			};
		}
	}

	get target(): Target | undefined {
		return this.currentTarget;
	}

	/** A client per host:port, so transaction IDs stay sequential per server. */
	client(host: string, port: number): AlpacaClient {
		const key = `${host}:${port}`;
		let client = this.clients.get(key);
		if (!client) {
			client = new AlpacaClient({
				host,
				port,
				timeoutMs: this.config.timeoutMs,
				...(this.config.clientId ? { clientId: this.config.clientId } : {}),
			});
			this.clients.set(key, client);
		}
		return client;
	}

	requireTarget(): Target {
		if (!this.currentTarget) {
			throw new SessionError(
				"No device selected. Run alpaca_discover to find one, then device_connect — " +
					"or start the server with --host.",
			);
		}
		return this.currentTarget;
	}

	/** The currently selected device, whatever its type. */
	device(): AlpacaDevice {
		const target = this.requireTarget();
		return new AlpacaDevice(
			this.client(target.host, target.port),
			target.deviceType,
			target.deviceNumber,
		);
	}

	/** The currently selected device as a telescope. */
	telescope(): Telescope {
		const target = this.requireTarget();
		if (target.deviceType !== "telescope") {
			throw new SessionError(
				`The selected device is a ${target.deviceType}, not a telescope. ` +
					'Run device_connect with device_type: "telescope".',
			);
		}
		return new Telescope(this.client(target.host, target.port), target.deviceNumber);
	}

	/** Point the session at a device and set its `Connected` property. */
	async connect(options: ConnectOptions = {}): Promise<Target> {
		const previous = this.currentTarget;
		const target: Target = {
			host: options.host ?? previous?.host ?? this.config.host ?? "",
			port: options.port ?? previous?.port ?? this.config.port,
			deviceType: options.deviceType ?? previous?.deviceType ?? this.config.deviceType,
			deviceNumber: options.deviceNumber ?? previous?.deviceNumber ?? this.config.deviceNumber,
		};

		if (!target.host) {
			throw new SessionError("No host given. Pass host, or start the server with --host.");
		}

		const device = new AlpacaDevice(
			this.client(target.host, target.port),
			target.deviceType,
			target.deviceNumber,
		);
		await device.setConnected(true);

		this.currentTarget = target;
		return target;
	}

	async disconnect(): Promise<Target> {
		const target = this.requireTarget();
		await this.device().setConnected(false);
		return target;
	}

	/**
	 * Whether the selected device is driven by seestar_alp.
	 *
	 * There is no capability flag for this — `supportedactions` is empty on that driver — so we go by
	 * how it describes itself, which is what a person would do.
	 */
	async isSeestar(): Promise<boolean> {
		if (this.config.profile === "seestar") return true;
		if (this.config.profile === "generic") return false;

		const target = this.requireTarget();
		const key = `${target.host}:${target.port}/${target.deviceType}/${target.deviceNumber}`;
		const cached = this.seestarCache.get(key);
		if (cached !== undefined) return cached;

		const device = this.device();
		const [description, driverInfo, name] = await Promise.all([
			device.description().catch(() => ""),
			device.driverInfo().catch(() => ""),
			device.name().catch(() => ""),
		]);

		const detected = /seestar|alp/i.test(`${description} ${driverInfo} ${name}`);
		this.seestarCache.set(key, detected);
		return detected;
	}
}
