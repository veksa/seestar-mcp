/**
 * Moving coordinates between J2000 — what catalogues and plate solvers use — and the equinox of
 * date, which is what most mounts, the Seestar's built-in server among them, expect.
 *
 * Precession only (IAU 1976, Meeus ch. 21). Nutation and aberration add up to about 20″, far inside
 * a Seestar field and well inside any centring tolerance worth asking for, so they are left out.
 * Over the 27 years since 2000 precession alone is about 0.4°, which is not.
 */

const ARCSEC = Math.PI / (180 * 3600);
const DEG = Math.PI / 180;

export interface Equatorial {
	/** Right ascension in hours, 0..24. */
	ra: number;
	/** Declination in degrees. */
	dec: number;
}

function julianDate(date: Date): number {
	return date.getTime() / 86_400_000 + 2_440_587.5;
}

function angles(date: Date): { zeta: number; z: number; theta: number } {
	const t = (julianDate(date) - 2_451_545.0) / 36_525;
	return {
		zeta: (2306.2181 * t + 0.30188 * t * t + 0.017998 * t ** 3) * ARCSEC,
		z: (2306.2181 * t + 1.09468 * t * t + 0.018203 * t ** 3) * ARCSEC,
		theta: (2004.3109 * t - 0.42665 * t * t - 0.041833 * t ** 3) * ARCSEC,
	};
}

function normalizeHours(radians: number): number {
	const hours = (radians / DEG / 15) % 24;
	return hours < 0 ? hours + 24 : hours;
}

/** J2000 → mean equinox of `date`. */
export function j2000ToDate(position: Equatorial, date: Date = new Date()): Equatorial {
	const { zeta, z, theta } = angles(date);
	const ra0 = position.ra * 15 * DEG;
	const dec0 = position.dec * DEG;

	const a = Math.cos(dec0) * Math.sin(ra0 + zeta);
	const b =
		Math.cos(theta) * Math.cos(dec0) * Math.cos(ra0 + zeta) - Math.sin(theta) * Math.sin(dec0);
	const c =
		Math.sin(theta) * Math.cos(dec0) * Math.cos(ra0 + zeta) + Math.cos(theta) * Math.sin(dec0);

	return {
		ra: normalizeHours(Math.atan2(a, b) + z),
		dec: Math.asin(Math.max(-1, Math.min(1, c))) / DEG,
	};
}

/** Mean equinox of `date` → J2000; the exact inverse rotation of `j2000ToDate`. */
export function dateToJ2000(position: Equatorial, date: Date = new Date()): Equatorial {
	const { zeta, z, theta } = angles(date);
	const ra = position.ra * 15 * DEG - z;
	const dec = position.dec * DEG;

	const a = Math.cos(dec) * Math.sin(ra);
	const b = Math.cos(theta) * Math.cos(dec) * Math.cos(ra) + Math.sin(theta) * Math.sin(dec);
	const c = -Math.sin(theta) * Math.cos(dec) * Math.cos(ra) + Math.cos(theta) * Math.sin(dec);

	return {
		ra: normalizeHours(Math.atan2(a, b) - zeta),
		dec: Math.asin(Math.max(-1, Math.min(1, c))) / DEG,
	};
}

/** Angular distance between two positions, in degrees. */
export function separationDegrees(first: Equatorial, second: Equatorial): number {
	const ra1 = first.ra * 15 * DEG;
	const ra2 = second.ra * 15 * DEG;
	const dec1 = first.dec * DEG;
	const dec2 = second.dec * DEG;
	// Haversine: stays accurate at the arcsecond separations a centring loop ends with.
	const h =
		Math.sin((dec2 - dec1) / 2) ** 2 +
		Math.cos(dec1) * Math.cos(dec2) * Math.sin((ra2 - ra1) / 2) ** 2;
	return (2 * Math.asin(Math.min(1, Math.sqrt(h)))) / DEG;
}

/**
 * Which equinox a mount's coordinates are in, from ASCOM `EquatorialSystem`.
 *
 * 2 is J2000. 1 is "topocentric" — equinox of date — and that is also the right reading of 0
 * ("other"), which in practice means a driver that did not bother to say.
 */
export type Equinox = "j2000" | "date";

export function equinoxOf(equatorialSystem: number | undefined): Equinox {
	return equatorialSystem === 2 ? "j2000" : "date";
}

export function toMount(position: Equatorial, equinox: Equinox, date?: Date): Equatorial {
	return equinox === "j2000" ? position : j2000ToDate(position, date);
}

export function fromMount(position: Equatorial, equinox: Equinox, date?: Date): Equatorial {
	return equinox === "j2000" ? position : dateToJ2000(position, date);
}
