import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";
import { loadConfig, type ServerConfig } from "../src/config.js";
import type { ProcessingConfig } from "../src/processing/config.js";
import { JobStore } from "../src/processing/jobs.js";
import { createProcessingServer } from "../src/processing/server.js";
import { createServer } from "../src/server.js";

/**
 * Connect a real MCP client to a real MCP server, in the same process.
 *
 * `createMcpHandler` is the entry point the stdio transport wraps, so tests exercise tool
 * registration, schema validation and results exactly as a host would — no mocked transport, and no
 * port. Shared by the fake-Alpaca tests and the simulator tests.
 */
export async function connectClient(overrides: Partial<ServerConfig> = {}): Promise<Client> {
	const config: ServerConfig = { ...loadConfig([], {}), ...overrides };
	return connectToFactory(() => createServer(config).server);
}

async function connectToFactory(factory: () => McpServer): Promise<Client> {
	const handler = createMcpHandler(factory);

	const transport = new StreamableHTTPClientTransport(new URL("http://seestar.test/mcp"), {
		fetch: (url, init) => handler.fetch(new Request(url, init)),
	});

	const client = new Client(
		{ name: "seestar-mcp-tests", version: "1.0.0" },
		{ versionNegotiation: { mode: "auto" } },
	);
	await client.connect(transport);
	return client;
}

/** The same, for the processing server — a separate process in real use, a separate factory here. */
export async function connectProcessingClient(
	config: ProcessingConfig,
	jobs = new JobStore(),
): Promise<Client> {
	return connectToFactory(() => createProcessingServer(config, jobs));
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
