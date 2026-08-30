/**
 * Rendering helpers for tool output.
 *
 * Every tool returns structured data for the model to reason over *and* a readable text block, since
 * that text is what a person sees in the transcript. Coordinates in particular are unreadable as raw
 * floats: `5.588` means nothing, `05h 35m 17s` is Orion.
 */

/** Right ascension in hours (0..24) as `05h 35m 17.3s`. */
export function formatRightAscension(hours: number): string {
	if (!Number.isFinite(hours)) return "unknown";
	const normalised = ((hours % 24) + 24) % 24;
	const h = Math.floor(normalised);
	const minutesTotal = (normalised - h) * 60;
	const m = Math.floor(minutesTotal);
	const s = (minutesTotal - m) * 60;
	return `${pad(h)}h ${pad(m)}m ${s.toFixed(1).padStart(4, "0")}s`;
}

/** Declination in degrees (-90..90) as `+22° 00′ 52″`. */
export function formatDeclination(degrees: number): string {
	if (!Number.isFinite(degrees)) return "unknown";
	const sign = degrees < 0 ? "-" : "+";
	const absolute = Math.abs(degrees);
	const d = Math.floor(absolute);
	const minutesTotal = (absolute - d) * 60;
	const m = Math.floor(minutesTotal);
	const s = Math.round((minutesTotal - m) * 60);
	return `${sign}${pad(d)}° ${pad(m)}′ ${pad(s)}″`;
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
