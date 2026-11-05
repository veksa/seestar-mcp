import { AlpacaClient, type DeviceType } from "./alpaca/client.js";
import { AlpacaDevice } from "./alpaca/device.js";
import { Telescope } from "./alpaca/devices/telescope.js";
import { AlpacaDeviceError, AscomErrorCode } from "./alpaca/errors.js";
import type { ServerConfig } from "./config.js";
import { SeestarActions } from "./seestar/actions.js";
import { SeestarDevice } from "./seestar/device.js";

/** Raised when a tool needs a device and there is none — always with a way out in the message. */
export class SessionError extends Error {}

/**
 * What is answering on the other end.
 *
 * - `builtin`: the Alpaca server in the Seestar's own firmware. Standard ASCOM devices only.
 * - `seestar_alp`: the community driver, which adds the Seestar action layer the seestar_* tools use.
 * - `generic`: any other Alpaca device.
 */
export type DriverKind = "builtin" | "seestar_alp" | "generic";

/** Why a seestar_* tool cannot run, for each kind of driver that lacks the action layer. */
const NO_ACTION_LAYER: Record<Exclude<DriverKind, "seestar_alp">, string> = {
	builtin:
		"This is the Seestar's built-in Alpaca server. It offers the standard ASCOM devices — " +
		"use telescope_* for the mount, and alpaca_get_property / alpaca_put for the camera, " +
		"focuser, filter wheel and dew heater switch (all device 0). Plate-solved goto, stacking, " +
		"the scheduler and file downloads need seestar_alp; start the server with --profile seestar " +
		"against it to use them.",
	generic:
		"The selected device is not a Seestar driven by seestar_alp, so the seestar_* tools do not " +
		"apply. Use the telescope_* and alpaca_* tools, or start with --profile seestar to force them.",
};

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
	private driverCache = new Map<string, DriverKind>();

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
				...(this.config.password
					? { auth: { username: this.config.username, password: this.config.password } }
					: {}),
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

	/**
	 * The selected device driven through the Seestar action layer.
	 *
	 * Refuses up front, with directions, when the driver has no such layer — otherwise the first
	 * symptom would be a bare "action not implemented" from deep inside a tool.
	 */
	seestar(): SeestarDevice {
		return new SeestarDevice(new SeestarActions(this.device(), () => this.requireActionLayer()));
	}

	private async requireActionLayer(): Promise<void> {
		const kind = await this.driver();
		if (kind !== "seestar_alp") throw new SessionError(NO_ACTION_LAYER[kind]);
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

	/** Whether the seestar_* tools apply to the selected device. */
	async isSeestar(): Promise<boolean> {
		return (await this.driver()) === "seestar_alp";
	}

	/**
	 * Which kind of driver the selected device is.
	 *
	 * Both Seestar drivers put "Seestar" in the device's name or description, and neither advertises
	 * any actions, so the name only says "some Seestar". What tells them apart is whether the action
	 * layer exists: `test_connection` is the firmware's own heartbeat, harmless to send, and the
	 * built-in server answers ActionNotImplemented for anything it is asked through `action`.
	 */
	async driver(): Promise<DriverKind> {
		if (this.config.profile === "seestar") return "seestar_alp";
		if (this.config.profile === "generic") return "generic";

		const target = this.requireTarget();
		const key = `${target.host}:${target.port}/${target.deviceType}/${target.deviceNumber}`;
		const cached = this.driverCache.get(key);
		if (cached !== undefined) return cached;

		const device = this.device();
		const [description, driverInfo, name] = await Promise.all([
			device.description().catch(() => ""),
			device.driverInfo().catch(() => ""),
			device.name().catch(() => ""),
		]);

		// Only "seestar": seestar_alp calls itself "Alpaca Driver for Seestar S50 Smart Telescope" and
		// the built-in server "Seestar <ssid> Telescope", while matching "alp" would also catch every
		// "Alpaca …" device there is.
		if (!/seestar/i.test(`${description} ${driverInfo} ${name}`)) {
			this.driverCache.set(key, "generic");
			return "generic";
		}

		try {
			await device.action("method_sync", JSON.stringify({ method: "test_connection" }));
		} catch (error) {
			if (
				error instanceof AlpacaDeviceError &&
				(error.errorNumber === AscomErrorCode.ActionNotImplemented ||
					error.errorNumber === AscomErrorCode.NotImplemented)
			) {
				this.driverCache.set(key, "builtin");
				return "builtin";
			}
			// Asleep, not connected, a timeout: it is a Seestar driver all the same, but the answer is
			// not conclusive, so ask again next time rather than remember a guess.
			return "seestar_alp";
		}

		this.driverCache.set(key, "seestar_alp");
		return "seestar_alp";
	}
}
