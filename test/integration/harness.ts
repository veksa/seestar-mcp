import type { Client } from "@modelcontextprotocol/client";
import type { ServerConfig } from "../../src/config.js";
import { type FakeAlpaca, startFakeAlpaca } from "../fake/alpaca-server.js";
import { connectClient } from "../mcp-client.js";

export { isError, structuredOf, textOf } from "../mcp-client.js";

export interface Harness {
	client: Client;
	fake: FakeAlpaca;
	close(): Promise<void>;
}

/** An MCP server, a client, and a fake Alpaca telescope behind it — the whole stack, in-process. */
export async function startHarness(
	overrides: Partial<ServerConfig> = {},
	fakeOptions: Parameters<typeof startFakeAlpaca>[0] = {},
): Promise<Harness> {
	const fake = await startFakeAlpaca(fakeOptions);

	const client = await connectClient({
		host: fake.host,
		port: fake.port,
		deviceNumber: 1,
		timeoutMs: 2_000,
		...overrides,
	});

	return {
		client,
		fake,
		async close() {
			await client.close();
			await fake.close();
		},
	};
}
