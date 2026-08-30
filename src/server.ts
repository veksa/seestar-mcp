import { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "./config.js";
import { Session } from "./session.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
import { registerGenericTools } from "./tools/generic.js";
import { registerImagingTools } from "./tools/imaging.js";
import { registerRawTools } from "./tools/raw.js";
import { registerSchedulerTools } from "./tools/scheduler.js";
import { registerSeestarTools } from "./tools/seestar.js";
import { registerTelescopeTools } from "./tools/telescope.js";

export const SERVER_NAME = "seestar-mcp";
export const SERVER_VERSION = "0.1.0";

export interface CreatedServer {
	server: McpServer;
	session: Session;
}

/**
 * Build a server instance.
 *
 * Returned rather than started, because the transport owns the lifecycle: stdio builds one per
 * process, and the tests build one per case in memory. Nothing below this line knows which.
 */
export function createServer(config: ServerConfig): CreatedServer {
	const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
	const session = new Session(config);

	registerDiscoveryTools(server, session);
	registerTelescopeTools(server, session);
	registerGenericTools(server, session);

	// The Seestar tools stay registered in `auto`: whether the device is a Seestar is only known
	// once something connects, and by then the tool list has been sent.
	if (config.profile !== "generic") {
		registerSeestarTools(server, session);
		registerImagingTools(server, session);
		registerSchedulerTools(server, session);
		registerRawTools(server, session);
	}

	return { server, session };
}

/** The factory shape the MCP transports expect. */
export function serverFactory(config: ServerConfig): () => McpServer {
	return () => createServer(config).server;
}
