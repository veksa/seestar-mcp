import { defineConfig } from "vitest/config";

/**
 * Integration tests against the real ASCOM simulators.
 *
 * Separate from the default config because they need a downloaded binary and take seconds rather
 * than milliseconds. Run with `yarn test:sim`.
 */
export default defineConfig({
	test: {
		include: ["test/omnisim/**/*.test.ts"],
		testTimeout: 60_000,
		hookTimeout: 90_000,
		// One simulator process at a time keeps the ports and the logs comprehensible.
		fileParallelism: false,
	},
});
