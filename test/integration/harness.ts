import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { loadConfig, type ServerConfig } from "../../src/config.js";
import { createServer } from "../../src/server.js";
import { type FakeAlpaca, startFakeAlpaca } from "../fake/alpaca-server.js";

export interface Harness {
	client: Client;
	fake: FakeAlpaca;
	close(): Promise<void>;
}

/**
 * Drive the real MCP server through a real MCP client, in-process.
 *
 * `createMcpHandler` is the same entry point the stdio transport wraps, so these tests exercise tool
 * registration, schema validation and results exactly as a host would see them — no mocked
 * transport, and no port.
 */
export async function startHarness(
	overrides: Partial<ServerConfig> = {},
	fakeOptions: Parameters<typeof startFakeAlpaca>[0] = {},
): Promise<Harness> {
	const fake = await startFakeAlpaca(fakeOptions);

	const config: ServerConfig = {
		...loadConfig([], {}),
		host: fake.host,
		port: fake.port,
		deviceNumber: 1,
		timeoutMs: 2_000,
		...overrides,
	};

	const handler = createMcpHandler(() => createServer(config).server);
	const transport = new StreamableHTTPClientTransport(new URL("http://seestar.test/mcp"), {
		fetch: (url, init) => handler.fetch(new Request(url, init)),
	});

	const client = new Client(
		{ name: "seestar-mcp-tests", version: "1.0.0" },
		{ versionNegotiation: { mode: "auto" } },
	);
	await client.connect(transport);

	return {
		client,
		fake,
		async close() {
			await client.close();
			await fake.close();
		},
	};
}

/** The text a tool returned, joined — what a person would read in the transcript. */
export function textOf(result: unknown): string {
	const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

export function structuredOf(result: unknown): Record<string, unknown> {
	return ((result as { structuredContent?: Record<string, unknown> }).structuredContent ??
		{}) as Record<string, unknown>;
}

export function isError(result: unknown): boolean {
	return (result as { isError?: boolean }).isError === true;
}
