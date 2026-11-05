import type { PlateSolution } from "./astap.js";
import { type Equatorial, type Equinox, fromMount, separationDegrees, toMount } from "./coords.js";

/**
 * Plate-solved centring: slew, look, correct, repeat.
 *
 * A goto without plate solving lands wherever the mount's own model says the target is. On a
 * Seestar right after power-on — or after it has been picked up and put down — that is degrees off:
 * on the first real test it was 3.8°, wider than the whole telephoto field. Solving a frame says
 * where the telescope really points; syncing to that and slewing again closes the gap. One round
 * took that 3.8° down to 5′.
 *
 * The mechanics (how to slew, take a frame, solve it) come in through `CenterDeps`, so the loop can
 * be tested without a telescope.
 */

export interface CenterDeps {
	/** Which equinox the mount's coordinates are in. */
	equinox: Equinox;
	/** Slew to mount coordinates and wait until the slew is over. */
	slew(position: Equatorial): Promise<void>;
	/** Tell the mount it is pointing at these mount coordinates. */
	sync(position: Equatorial): Promise<void>;
	/** Where the mount believes it is pointing, in mount coordinates. */
	mountPosition(): Promise<Equatorial>;
	/** Take a frame and solve it. `hint` is J2000. */
	captureAndSolve(hint: Equatorial): Promise<{ solution: PlateSolution; path: string }>;
	now?: () => Date;
}

export interface CenterOptions {
	toleranceArcmin: number;
	maxAttempts: number;
}

export interface CenterAttempt {
	attempt: number;
	/** The frame this attempt took. */
	path: string;
	/** Where the frame was really centred, J2000. */
	solved: Equatorial;
	/** Where the mount thought it was, J2000. */
	mountBelieved: Equatorial;
	/** Distance from the target, arcminutes. */
	errorArcmin: number;
	/** How far the mount's own idea was off, arcminutes. */
	mountErrorArcmin: number;
	synced: boolean;
	solution: PlateSolution;
}

export interface CenterReport {
	target: Equatorial;
	centered: boolean;
	attempts: CenterAttempt[];
}

export async function centerOn(
	target: Equatorial,
	options: CenterOptions,
	deps: CenterDeps,
): Promise<CenterReport> {
	const now = deps.now ?? (() => new Date());
	const attempts: CenterAttempt[] = [];

	for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
		await deps.slew(toMount(target, deps.equinox, now()));

		const mountBelieved = fromMount(await deps.mountPosition(), deps.equinox, now());
		const { solution, path } = await deps.captureAndSolve(mountBelieved);

		const errorArcmin = separationDegrees(solution.center, target) * 60;
		const record: CenterAttempt = {
			attempt,
			path,
			solved: solution.center,
			mountBelieved,
			errorArcmin,
			mountErrorArcmin: separationDegrees(solution.center, mountBelieved) * 60,
			synced: false,
			solution,
		};
		attempts.push(record);

		if (errorArcmin <= options.toleranceArcmin) {
			return { target, centered: true, attempts };
		}

		if (attempt < options.maxAttempts) {
			await deps.sync(toMount(solution.center, deps.equinox, now()));
			record.synced = true;
		}
	}

	return { target, centered: false, attempts };
}
