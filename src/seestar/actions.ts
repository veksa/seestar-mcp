import type { RequestOptions } from "../alpaca/client.js";
import type { AlpacaDevice } from "../alpaca/device.js";

/**
 * The Seestar action layer.
 *
 * seestar_alp exposes everything Seestar-specific through the single Alpaca `action` endpoint:
 * `Action` names the operation and `Parameters` carries a JSON string. Two of those actions,
 * `method_sync` and `method_async`, are a passthrough to the telescope's own JSON-RPC protocol.
 *
 * Results come back in one of two envelopes — the driver's `{jsonrpc, command, code, result}` or the
 * firmware's `{jsonrpc, method, code, result}` — so unwrapping is done in one place here rather than
 * in every caller.
 */

/** An operation the telescope refused, as opposed to a transport or protocol failure. */
export class SeestarError extends Error {
	readonly code: number | undefined;
	readonly action: string;

	constructor(action: string, message: string, code?: number) {
		super(`${action} failed: ${message}`);
		this.name = "SeestarError";
		this.action = action;
		this.code = code;
	}
}

export class SeestarActions {
	constructor(readonly device: AlpacaDevice) {}

	/** Invoke a Seestar action by name. */
	async call<T>(
		action: string,
		parameters: Record<string, unknown> = {},
		options?: RequestOptions,
	): Promise<T> {
		const raw = await this.device.action(action, JSON.stringify(parameters), options);
		return unwrap<T>(action, raw);
	}

	/**
	 * Send a firmware JSON-RPC method and wait for its reply.
	 *
	 * This is how everything the driver has no dedicated action for is reached: settings, the
	 * focuser, the filter wheel, device state.
	 */
	async methodSync<T>(method: string, params?: unknown, options?: RequestOptions): Promise<T> {
		return this.call<T>(
			"method_sync",
			{ method, ...(params !== undefined ? { params } : {}) },
			options,
		);
	}

	/** Fire a firmware method without waiting for the telescope to finish it. */
	async methodAsync(method: string, params?: unknown, options?: RequestOptions): Promise<string> {
		return this.call<string>(
			"method_async",
			{ method, ...(params !== undefined ? { params } : {}) },
			options,
		);
	}
}

/**
 * Peel the response envelopes and turn a refusal into an error.
 *
 * `start_mosaic` answers `code: -1` with a sentence when a schedule is already running; a firmware
 * method answers with an `error` member. Both are failures the caller must see, not values.
 */
export function unwrap<T>(action: string, raw: unknown): T {
	if (raw === null || raw === undefined || typeof raw !== "object") return raw as T;

	const payload = raw as Record<string, unknown>;

	if ("error" in payload && payload.error) {
		throw new SeestarError(action, describe(payload.error), asNumber(payload.code));
	}

	if ("code" in payload && asNumber(payload.code) !== 0 && asNumber(payload.code) !== undefined) {
		throw new SeestarError(action, describe(payload.result ?? payload), asNumber(payload.code));
	}

	if ("result" in payload) return payload.result as T;

	return payload as T;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function describe(value: unknown): string {
	if (typeof value === "string") return value;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (typeof record.message === "string") return record.message;
		return JSON.stringify(value);
	}
	return String(value);
}
