import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// OmniSim tests need the downloaded simulator; they run via `npm run test:sim`.
		exclude: ["test/omnisim/**"],
		testTimeout: 10_000,
		coverage: {
			include: ["src/**/*.ts"],
			reporter: ["text", "lcov"],
		},
	},
});
