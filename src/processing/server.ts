import { McpServer } from "@modelcontextprotocol/server";
import type { ProcessingConfig } from "./config.js";
import { JobStore } from "./jobs.js";
import { registerProcessingTools } from "./tools.js";

export const PROCESSING_SERVER_NAME = "astro-mcp";
export const PROCESSING_SERVER_VERSION = "0.1.0";

/**
 * The processing server.
 *
 * Deliberately independent of the telescope side: nothing under `src/processing/` imports from
 * `src/alpaca/` or `src/seestar/`, so the two can be run separately — or split into separate
 * packages later — without untangling anything.
 *
 * The job store is passed in rather than built here: transports may call this factory more than
 * once — per connection, and per request in stateless HTTP mode — and a store built inside would
 * lose every running job between calls.
 */
export function createProcessingServer(config: ProcessingConfig, jobs = new JobStore()): McpServer {
	const server = new McpServer({
		name: PROCESSING_SERVER_NAME,
		version: PROCESSING_SERVER_VERSION,
	});

	registerProcessingTools(server, config, jobs);

	return server;
}
