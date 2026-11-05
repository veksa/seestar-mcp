import {
	AlpacaDeviceError,
	AlpacaHttpError,
	type AlpacaRequestContext,
	AlpacaTransportError,
} from "./errors.js";
import {
	type AlpacaImage,
	decodeImageBytes,
	decodeImageJson,
	ImageDecodeError,
} from "./imagebytes.js";

/** Every device type in the Alpaca specification. */
export const DEVICE_TYPES = [
	"telescope",
	"camera",
	"focuser",
	"filterwheel",
	"rotator",
	"dome",
	"switch",
	"covercalibrator",
	"observingconditions",
	"safetymonitor",
] as const;

export type DeviceType = (typeof DEVICE_TYPES)[number];

/** Values Alpaca accepts as request parameters. */
export type AlpacaParams = Record<string, string | number | boolean>;

/** The envelope every Alpaca response is wrapped in. */
export interface AlpacaResponse<T> {
	Value?: T;
	ClientTransactionID?: number;
	ServerTransactionID?: number;
	ErrorNumber?: number;
	ErrorMessage?: string;
}

export interface AlpacaClientOptions {
	host: string;
	port?: number;
	protocol?: "http" | "https";
	/** Identifies this client to the device. Random per process unless pinned. */
	clientId?: number;
	/** Per-request timeout. Slews are asynchronous, so this only covers the HTTP round trip. */
	timeoutMs?: number;
	/** Extra attempts for idempotent (GET) requests after a transport error or 5xx. */
	retries?: number;
	/** HTTP Basic credentials, for a server with "Require Authorization" turned on. */
	auth?: { username: string; password: string };
	/** Injected for tests. */
	fetch?: typeof globalThis.fetch;
}

export interface RequestOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Override retry behaviour for this call. PUTs default to no retries. */
	retries?: number;
}

const DEFAULT_PORT = 32323;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 150;
const MAX_CLIENT_ID = 0xffff;
const MAX_TRANSACTION_ID = 0xffff_ffff;

/**
 * Alpaca parameter names are case-sensitive on the wire (`Connected`, `RightAscension`), so we never
 * normalise the keys a caller passes. Booleans go out capitalised, which every server accepts.
 */
function encodeParams(params: AlpacaParams): URLSearchParams {
	const encoded = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		encoded.set(key, typeof value === "boolean" ? (value ? "True" : "False") : String(value));
	}
	return encoded;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A thin, device-agnostic ASCOM Alpaca HTTP client.
 *
 * Knows nothing about Seestar or MCP: it speaks the protocol and turns non-zero ErrorNumbers into
 * exceptions. Higher layers add device semantics on top.
 */
export class AlpacaClient {
	readonly host: string;
	readonly port: number;
	readonly protocol: "http" | "https";
	readonly clientId: number;

	private readonly timeoutMs: number;
	private readonly retries: number;
	private readonly fetchImpl: typeof globalThis.fetch;
	private readonly authorization: string | undefined;
	private transactionId = 0;

	constructor(options: AlpacaClientOptions) {
		this.host = options.host;
		this.port = options.port ?? DEFAULT_PORT;
		this.protocol = options.protocol ?? "http";
		this.clientId = options.clientId ?? 1 + Math.floor(Math.random() * MAX_CLIENT_ID);
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.retries = options.retries ?? DEFAULT_RETRIES;
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.authorization = options.auth
			? `Basic ${Buffer.from(`${options.auth.username}:${options.auth.password}`).toString("base64")}`
			: undefined;
	}

	/** `http://host:port` — the root every Alpaca URL hangs off. */
	get baseUrl(): string {
		return `${this.protocol}://${this.host}:${this.port}`;
	}

	deviceUrl(deviceType: DeviceType, deviceNumber: number, method: string): string {
		return `${this.baseUrl}/api/v1/${deviceType}/${deviceNumber}/${method.toLowerCase()}`;
	}

	/** Transaction IDs must rise monotonically and stay inside an unsigned 32-bit integer. */
	private nextTransactionId(): number {
		this.transactionId = (this.transactionId + 1) % MAX_TRANSACTION_ID;
		return this.transactionId;
	}

	/** Read a device property or a GET-style method. */
	async get<T>(
		deviceType: DeviceType,
		deviceNumber: number,
		method: string,
		params: AlpacaParams = {},
		options: RequestOptions = {},
	): Promise<T> {
		const url = new URL(this.deviceUrl(deviceType, deviceNumber, method));
		const query = encodeParams(params);
		query.set("ClientID", String(this.clientId));
		query.set("ClientTransactionID", String(this.nextTransactionId()));
		url.search = query.toString();

		return this.request<T>(
			url.toString(),
			{ method: "GET" },
			{ deviceType, deviceNumber, method },
			options.retries ?? this.retries,
			options,
		);
	}

	/**
	 * Write a device property or invoke a method.
	 *
	 * Not retried by default: `slewtocoordinatesasync` and friends are not idempotent, and a
	 * duplicate command is worse than a visible failure.
	 */
	async put<T>(
		deviceType: DeviceType,
		deviceNumber: number,
		method: string,
		params: AlpacaParams = {},
		options: RequestOptions = {},
	): Promise<T> {
		const body = encodeParams(params);
		body.set("ClientID", String(this.clientId));
		body.set("ClientTransactionID", String(this.nextTransactionId()));

		return this.request<T>(
			this.deviceUrl(deviceType, deviceNumber, method),
			{
				method: "PUT",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: body.toString(),
			},
			{ deviceType, deviceNumber, method },
			options.retries ?? 0,
			options,
		);
	}

	/** Call the management API, e.g. `apiversions` or `v1/configureddevices`. */
	async management<T>(path: string, options: RequestOptions = {}): Promise<T> {
		const url = new URL(`${this.baseUrl}/management/${path.replace(/^\/+/, "")}`);
		url.searchParams.set("ClientID", String(this.clientId));
		url.searchParams.set("ClientTransactionID", String(this.nextTransactionId()));

		return this.request<T>(
			url.toString(),
			{ method: "GET" },
			{ method: `management/${path}` },
			options.retries ?? this.retries,
			options,
		);
	}

	private async request<T>(
		url: string,
		init: RequestInit,
		context: AlpacaRequestContext,
		retries: number,
		options: RequestOptions,
	): Promise<T> {
		const fullContext: AlpacaRequestContext = { ...context, url };
		let lastError: unknown;

		for (let attempt = 0; attempt <= retries; attempt++) {
			if (attempt > 0) await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));

			try {
				return await this.attempt<T>(url, init, fullContext, options);
			} catch (error) {
				// A device that answered and said "no" will say "no" again; only retry transport
				// hiccups and server-side failures. Not timeouts: a server that did not answer in time
				// is busy or stuck, and a stuck one keeps every repeat waiting too — the Seestar's
				// built-in server holds a thread for each such request until it is restarted.
				const retryable =
					(error instanceof AlpacaTransportError && !error.timedOut) ||
					(error instanceof AlpacaHttpError && error.status >= 500);
				if (!retryable || options.signal?.aborted) throw error;
				lastError = error;
			}
		}

		throw lastError;
	}

	/**
	 * Download a camera image, as ImageBytes when the server offers it and as JSON otherwise.
	 *
	 * Never retried: a frame is large, and a server that failed to send one is better asked again by
	 * the caller, who knows whether the exposure is still worth having.
	 */
	async getImage(
		deviceType: DeviceType,
		deviceNumber: number,
		method = "imagearray",
		options: RequestOptions = {},
	): Promise<AlpacaImage> {
		const url = new URL(this.deviceUrl(deviceType, deviceNumber, method));
		url.searchParams.set("ClientID", String(this.clientId));
		url.searchParams.set("ClientTransactionID", String(this.nextTransactionId()));
		const context: AlpacaRequestContext = {
			deviceType,
			deviceNumber,
			method,
			url: url.toString(),
		};

		const timeoutMs = options.timeoutMs ?? this.timeoutMs;
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const response = await this.send(
			url.toString(),
			{
				method: "GET",
				headers: { Accept: "application/imagebytes, application/json;q=0.5" },
			},
			context,
			timeoutSignal,
			timeoutMs,
			options,
		);

		let body: Uint8Array;
		try {
			body = new Uint8Array(await response.arrayBuffer());
		} catch (error) {
			throw new AlpacaTransportError(
				timeoutSignal.aborted
					? `image download timed out after ${timeoutMs}ms`
					: `image download failed: ${describe(error)}`,
				context,
				{ cause: error, timedOut: timeoutSignal.aborted },
			);
		}

		if (!response.ok) {
			throw new AlpacaHttpError(response.status, new TextDecoder().decode(body), context);
		}

		if ((response.headers.get("content-type") ?? "").includes("imagebytes")) {
			try {
				return decodeImageBytes(body);
			} catch (error) {
				if (error instanceof ImageDecodeError && error.errorNumber !== undefined) {
					throw new AlpacaDeviceError(error.errorNumber, error.message, context);
				}
				throw new AlpacaTransportError(`could not decode the image: ${describe(error)}`, context, {
					cause: error,
				});
			}
		}

		const value = this.unwrap<unknown>(new TextDecoder().decode(body), context);
		try {
			return decodeImageJson(value);
		} catch (error) {
			throw new AlpacaTransportError(`could not decode the image: ${describe(error)}`, context, {
				cause: error,
			});
		}
	}

	/** One HTTP exchange, with the timeout and credentials every request needs. */
	private async send(
		url: string,
		init: RequestInit,
		context: AlpacaRequestContext,
		timeoutSignal: AbortSignal,
		timeoutMs: number,
		options: RequestOptions,
	): Promise<Response> {
		const signal = options.signal
			? AbortSignal.any([options.signal, timeoutSignal])
			: timeoutSignal;

		try {
			return await this.fetchImpl(url, {
				...init,
				signal,
				headers: {
					Accept: "application/json",
					...(this.authorization ? { Authorization: this.authorization } : {}),
					...init.headers,
				},
			});
		} catch (error) {
			const timedOut = timeoutSignal.aborted;
			throw new AlpacaTransportError(
				timedOut ? `request timed out after ${timeoutMs}ms` : `request failed: ${describe(error)}`,
				context,
				{ cause: error, timedOut },
			);
		}
	}

	private async attempt<T>(
		url: string,
		init: RequestInit,
		context: AlpacaRequestContext,
		options: RequestOptions,
	): Promise<T> {
		const timeoutMs = options.timeoutMs ?? this.timeoutMs;
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const response = await this.send(url, init, context, timeoutSignal, timeoutMs, options);

		const text = await response.text();

		if (!response.ok) {
			throw new AlpacaHttpError(response.status, text, context);
		}

		return this.unwrap<T>(text, context);
	}

	/** Parse an Alpaca JSON envelope, turning a non-zero ErrorNumber into an exception. */
	private unwrap<T>(text: string, context: AlpacaRequestContext): T {
		let payload: AlpacaResponse<T>;
		try {
			payload = JSON.parse(text) as AlpacaResponse<T>;
		} catch (error) {
			throw new AlpacaTransportError(`response was not JSON: ${text.slice(0, 200)}`, context, {
				cause: error,
			});
		}

		if (payload.ErrorNumber !== undefined && payload.ErrorNumber !== 0) {
			throw new AlpacaDeviceError(payload.ErrorNumber, payload.ErrorMessage ?? "", context);
		}

		return payload.Value as T;
	}
}

function describe(error: unknown): string {
	if (error instanceof Error) {
		const cause = error.cause;
		const causeMessage =
			cause instanceof Error && cause.message !== error.message ? ` (${cause.message})` : "";
		return `${error.message}${causeMessage}`;
	}
	return String(error);
}
