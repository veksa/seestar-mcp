import {
	AlpacaDeviceError,
	AlpacaHttpError,
	AlpacaTransportError,
	AscomErrorCode,
} from "../alpaca/errors.js";
import { SeestarError } from "../seestar/actions.js";
import { SessionError } from "../session.js";

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
	[key: string]: unknown;
}

export function textResult(text: string, structured?: Record<string, unknown>): ToolResult {
	return {
		content: [{ type: "text", text }],
		...(structured ? { structuredContent: structured } : {}),
	};
}

export function errorResult(text: string): ToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

/**
 * Run a tool body, turning failures into readable results rather than protocol errors.
 *
 * A tool that throws gives the model a stack trace; a tool that returns `isError` with a sentence
 * about what to do next gives it a way forward. Astronomy failures are mostly of the second kind:
 * the scope is parked, or asleep, or on a different network.
 */
export async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
	try {
		return await run();
	} catch (error) {
		return errorResult(explain(error));
	}
}

/** Turn an error into something worth reading, with the next step where there is one. */
export function explain(error: unknown): string {
	if (error instanceof SessionError) return error.message;

	if (error instanceof SeestarError) {
		// The driver refuses a new session while one is running, and says so in prose.
		const hint = /scheduler is (still )?active/i.test(error.message)
			? "\n\nA session is already running. Stop it with imaging_stop, then try again."
			: "";
		return `${error.message}${hint}`;
	}

	if (error instanceof AlpacaDeviceError) {
		const hint = deviceErrorHint(error);
		return hint ? `${error.message}\n\n${hint}` : error.message;
	}

	if (error instanceof AlpacaTransportError) {
		const where = error.context.url ? ` (${new URL(error.context.url).host})` : "";
		return error.timedOut
			? `The Alpaca server did not answer in time${where}. It may be busy plate-solving; try again, or raise --timeout. If it keeps happening on a Seestar's built-in server, that server may have lost its link to the firmware: stop or park with the Seestar app, then switch the telescope off and on again.`
			: `Could not reach the Alpaca server${where}: ${error.message}\n\nIs the Seestar (or seestar_alp) on, and is the host reachable from this machine?`;
	}

	if (error instanceof AlpacaHttpError) {
		if (error.status === 401) {
			return (
				`${error.message}\n\nThe Alpaca server requires a password. Restart this server with ` +
				"--password (and --username if it is not User), or turn authorization off in the " +
				"Alpaca server's settings page."
			);
		}
		return error.status === 404
			? `${error.message}\n\nThat endpoint does not exist on this server — check the device type and number.`
			: error.message;
	}

	return error instanceof Error ? error.message : String(error);
}

function deviceErrorHint(error: AlpacaDeviceError): string | undefined {
	switch (error.errorNumber) {
		case AscomErrorCode.NotConnected:
			return "Run device_connect first.";
		case AscomErrorCode.InvalidWhileParked:
			return "The telescope is parked. Unpark it (telescope_unpark), or run the Seestar startup sequence.";
		case AscomErrorCode.NotImplemented:
		case AscomErrorCode.ActionNotImplemented:
			return "This driver does not implement that. For Seestar-specific features use the seestar_* tools.";
		case AscomErrorCode.InvalidValue:
			return "Check the units: right ascension is in hours (0-24), declination in degrees (-90..90).";
		default:
			return undefined;
	}
}
