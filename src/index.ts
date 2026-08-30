#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { isConfigError, loadConfig, USAGE } from "./config.js";
import { SERVER_VERSION, serverFactory } from "./server.js";

const argv = process.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
	console.log(USAGE);
	process.exit(0);
}

if (argv.includes("--version") || argv.includes("-v")) {
	console.log(SERVER_VERSION);
	process.exit(0);
}

let config: ReturnType<typeof loadConfig>;
try {
	config = loadConfig(argv);
} catch (error) {
	// stdout is the JSON-RPC channel, so everything human goes to stderr.
	console.error(isConfigError(error) ? `seestar-mcp: ${error.message}` : error);
	console.error(`\n${USAGE}`);
	process.exit(2);
}

serveStdio(serverFactory(config));

console.error(
	config.host
		? `seestar-mcp ${SERVER_VERSION} on stdio — device ${config.deviceType}/${config.deviceNumber} at ${config.host}:${config.port}`
		: `seestar-mcp ${SERVER_VERSION} on stdio — no host configured, use alpaca_discover then device_connect`,
);
