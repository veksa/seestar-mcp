import { defineConfig } from "vitest/config";

/**
 * The suite that runs against a real Siril.
 *
 * Separate because it needs the program downloaded (`yarn siril:fetch`) and because stacking takes
 * seconds rather than milliseconds. Run with `yarn test:siril`.
 */
export default defineConfig({
	test: {
		include: ["test/siril/**/*.test.ts"],
		testTimeout: 300_000,
		hookTimeout: 180_000,
		fileParallelism: false,
	},
});
