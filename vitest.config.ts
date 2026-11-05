import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// OmniSim tests need the downloaded simulator; they run via `npm run test:sim`. The built-in
		// server tests need Docker and the server itself; they run via `npm run test:zwo`.
		exclude: ["test/omnisim/**", "test/zwo/**"],
		testTimeout: 10_000,
		coverage: {
			include: ["src/**/*.ts"],
			reporter: ["text", "lcov"],
		},
	},
});
