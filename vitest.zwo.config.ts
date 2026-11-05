import { defineConfig } from "vitest/config";

/**
 * Integration tests against the Seestar's built-in Alpaca server, run in Docker.
 *
 * Separate from the default config because they need Docker and a copy of the server, and take
 * seconds rather than milliseconds. Run with `yarn test:zwo`.
 */
export default defineConfig({
	test: {
		include: ["test/zwo/**/*.test.ts"],
		testTimeout: 90_000,
		hookTimeout: 600_000,
		// One container at a time keeps the logs comprehensible.
		fileParallelism: false,
	},
});
