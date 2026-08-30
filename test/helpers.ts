import { expect } from "vitest";

/**
 * Await a call that must fail, and hand back the error already narrowed to the expected type.
 *
 * `expect(...).rejects.toBeInstanceOf(...)` cannot follow up with assertions on the error's own
 * fields, and `.catch(e => e)` gives back `unknown`.
 */
export async function expectFailure<T extends Error>(
	promise: Promise<unknown>,
	type: new (...args: never[]) => T,
): Promise<T> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(type);
		return error as T;
	}
	throw new Error(`expected the call to fail with ${type.name}, but it resolved`);
}
