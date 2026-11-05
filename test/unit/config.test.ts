import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
	it("defaults to the Seestar's built-in Alpaca server", () => {
		const config = loadConfig([], {});

		expect(config.port).toBe(32323);
		expect(config.deviceNumber).toBe(0);
		expect(config.password).toBeUndefined();
		expect(config.username).toBe("User");
	});

	it("takes credentials from flags", () => {
		const config = loadConfig(["--username", "astro", "--password", "s3cret"], {});

		expect(config).toMatchObject({ username: "astro", password: "s3cret" });
	});

	it("takes credentials from the environment, with flags winning", () => {
		const env = { SEESTAR_USERNAME: "astro", SEESTAR_PASSWORD: "from-env" };

		expect(loadConfig([], env)).toMatchObject({ username: "astro", password: "from-env" });
		expect(loadConfig(["--password", "from-flag"], env)).toMatchObject({ password: "from-flag" });
	});
});
