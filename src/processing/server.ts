import { McpServer } from "@modelcontextprotocol/server";
import type { ProcessingConfig } from "./config.js";
import { registerProcessingTools } from "./tools.js";

export const PROCESSING_SERVER_NAME = "astro-mcp";
export const PROCESSING_SERVER_VERSION = "0.1.0";

/**
 * The processing server.
 *
 * Deliberately independent of the telescope side: nothing under `src/processing/` imports from
 * `src/alpaca/` or `src/seestar/`, so the two can be run separately — or split into separate
 * packages later — without untangling anything.
 */
export function createProcessingServer(config: ProcessingConfig): McpServer {
	const server = new McpServer({
		name: PROCESSING_SERVER_NAME,
		version: PROCESSING_SERVER_VERSION,
	});

	registerProcessingTools(server, config);

	return server;
}
