/**
 * Rendering helpers for tool output.
 *
 * Every tool returns structured data for the model to reason over *and* a readable text block, since
 * that text is what a person sees in the transcript. Coordinates in particular are unreadable as raw
 * floats: `5.588` means nothing, `05h 35m 17s` is Orion.
 */

/**
 * Split a decimal quantity into whole units, minutes and seconds.
 *
 * Rounding is applied first and then carried, because rounding the seconds on their own produces
 * "05h 59m 60.0s" for anything just short of the next unit.
 */
function sexagesimal(value: number, secondsDecimals: number): [number, number, string] {
	const factor = 10 ** secondsDecimals;
	let totalSeconds = Math.round(value * 3600 * factor) / factor;

	const units = Math.floor(totalSeconds / 3600);
	totalSeconds -= units * 3600;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds - minutes * 60;

	return [
		units,
		minutes,
		seconds.toFixed(secondsDecimals).padStart(secondsDecimals > 0 ? 3 + secondsDecimals : 2, "0"),
	];
}

/** Right ascension in hours (0..24) as `05h 35m 17.3s`. */
export function formatRightAscension(hours: number): string {
	if (!Number.isFinite(hours)) return "unknown";
	const normalised = ((hours % 24) + 24) % 24;
	const [h, m, s] = sexagesimal(normalised, 1);
	// Rounding can push 23:59:59.99 to a full 24 hours, which is 0 hours.
	return `${pad(h % 24)}h ${pad(m)}m ${s}s`;
}

/** Declination in degrees (-90..90) as `+22° 00′ 52″`. */
export function formatDeclination(degrees: number): string {
	if (!Number.isFinite(degrees)) return "unknown";
	const sign = degrees < 0 ? "-" : "+";
	const [d, m, s] = sexagesimal(Math.abs(degrees), 0);
	return `${sign}${pad(d)}° ${pad(m)}′ ${s}″`;
}

/** Degrees as `45.0°`, for altitude and azimuth. */
export function formatDegrees(degrees: number | undefined): string {
	return degrees === undefined ? "unknown" : `${degrees.toFixed(1)}°`;
}

/** A key/value block: aligned labels, one per line. */
export function formatFields(fields: Array<[string, string | undefined]>): string {
	const present = fields.filter((entry): entry is [string, string] => entry[1] !== undefined);
	const width = Math.max(0, ...present.map(([label]) => label.length));
	return present.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join("\n");
}

/** `1h 12m`, `45s` — for session lengths and exposure times. */
export function formatDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const rest = Math.round(seconds % 60);
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${rest}s`;
	return `${rest}s`;
}

export function formatBoolean(value: boolean | undefined, yes: string, no: string): string {
	if (value === undefined) return "unknown";
	return value ? yes : no;
}

/** Reasons a device would not answer, appended to a status block when there are any. */
export function formatUnavailable(unavailable: Record<string, string>): string {
	const entries = Object.entries(unavailable);
	if (entries.length === 0) return "";
	const lines = entries.map(([key, reason]) => `  ${key}: ${reason}`).join("\n");
	return `\n\nNot reported by this device:\n${lines}`;
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}
