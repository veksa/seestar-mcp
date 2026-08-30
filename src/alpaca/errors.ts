/**
 * Errors raised by the Alpaca layer.
 *
 * Three things can go wrong, and callers usually want to treat them differently:
 *   - the device answered, but reported a problem  -> AlpacaDeviceError (has an ASCOM ErrorNumber)
 *   - the server answered with a bad HTTP status   -> AlpacaHttpError
 *   - we never got a usable answer at all          -> AlpacaTransportError
 */

/** ASCOM error numbers that every Alpaca device shares. */
export const AscomErrorCode = {
	NotImplemented: 0x400,
	InvalidValue: 0x401,
	ValueNotSet: 0x402,
	NotConnected: 0x407,
	InvalidWhileParked: 0x408,
	InvalidWhileSlaved: 0x409,
	SettingsProviderError: 0x40a,
	InvalidOperation: 0x40b,
	ActionNotImplemented: 0x40c,
	NotInCache: 0x40d,
	Unspecified: 0x4ff,
} as const;

const ERROR_NAMES = new Map<number, string>(
	Object.entries(AscomErrorCode).map(([name, code]) => [code, name]),
);

/** Driver-specific errors live in 0x500..0xFFF; everything below 0x400 is not an ASCOM code. */
const DRIVER_ERROR_MIN = 0x500;
const DRIVER_ERROR_MAX = 0xfff;

/** Human-readable name for an ASCOM error number, e.g. `0x407` -> `NotConnected`. */
export function describeErrorNumber(errorNumber: number): string {
	const known = ERROR_NAMES.get(errorNumber);
	if (known) return known;
	if (errorNumber >= DRIVER_ERROR_MIN && errorNumber <= DRIVER_ERROR_MAX) return "DriverError";
	return "UnknownError";
}

/** Where a failing request was aimed, for error messages: `telescope/1/slewtocoordinatesasync`. */
export interface AlpacaRequestContext {
	deviceType?: string;
	deviceNumber?: number;
	method?: string;
	url?: string;
}

function contextSuffix(context: AlpacaRequestContext): string {
	const { deviceType, deviceNumber, method } = context;
	const target =
		deviceType !== undefined && deviceNumber !== undefined
			? `${deviceType}/${deviceNumber}${method ? `/${method}` : ""}`
			: method;
	return target ? ` (${target})` : "";
}

/** Base class for everything this layer throws, so callers can catch one thing. */
export abstract class AlpacaError extends Error {
	readonly context: AlpacaRequestContext;

	constructor(message: string, context: AlpacaRequestContext, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
		this.context = context;
	}
}

/** The device answered with a non-zero ErrorNumber. */
export class AlpacaDeviceError extends AlpacaError {
	readonly errorNumber: number;
	readonly errorName: string;

	constructor(errorNumber: number, errorMessage: string, context: AlpacaRequestContext) {
		const errorName = describeErrorNumber(errorNumber);
		const hex = `0x${errorNumber.toString(16).toUpperCase()}`;
		super(`${errorName} ${hex}: ${errorMessage || "no message"}${contextSuffix(context)}`, context);
		this.errorNumber = errorNumber;
		this.errorName = errorName;
	}
}

/** The server answered, but with an HTTP status we cannot use. */
export class AlpacaHttpError extends AlpacaError {
	readonly status: number;
	readonly body: string;

	constructor(status: number, body: string, context: AlpacaRequestContext) {
		const excerpt = body.trim().slice(0, 200);
		super(`HTTP ${status}${contextSuffix(context)}${excerpt ? `: ${excerpt}` : ""}`, context);
		this.status = status;
		this.body = body;
	}
}

/** No usable answer: connection refused, DNS failure, timeout, or unparseable body. */
export class AlpacaTransportError extends AlpacaError {
	readonly timedOut: boolean;

	constructor(
		message: string,
		context: AlpacaRequestContext,
		options?: ErrorOptions & { timedOut?: boolean },
	) {
		super(`${message}${contextSuffix(context)}`, context, options);
		this.timedOut = options?.timedOut ?? false;
	}
}

/** True when the device told us it is not connected — the most common recoverable case. */
export function isNotConnected(error: unknown): boolean {
	return error instanceof AlpacaDeviceError && error.errorNumber === AscomErrorCode.NotConnected;
}

/** True when the device does not implement the property or method at all. */
export function isNotImplemented(error: unknown): boolean {
	return (
		error instanceof AlpacaDeviceError &&
		(error.errorNumber === AscomErrorCode.NotImplemented ||
			error.errorNumber === AscomErrorCode.ActionNotImplemented)
	);
}
