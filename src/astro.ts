#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
	isProcessingConfigError,
	loadProcessingConfig,
	PROCESSING_USAGE,
} from "./processing/config.js";
import { createProcessingServer, PROCESSING_SERVER_VERSION } from "./processing/server.js";

const argv = process.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
	console.log(PROCESSING_USAGE);
	process.exit(0);
}

if (argv.includes("--version") || argv.includes("-v")) {
	console.log(PROCESSING_SERVER_VERSION);
	process.exit(0);
}

let config: ReturnType<typeof loadProcessingConfig>;
try {
	config = loadProcessingConfig(argv);
} catch (error) {
	// stdout is the JSON-RPC channel; everything human goes to stderr.
	console.error(isProcessingConfigError(error) ? `astro-mcp: ${error.message}` : error);
	console.error(`\n${PROCESSING_USAGE}`);
	process.exit(2);
}

serveStdio(() => createProcessingServer(config));

console.error(
	`astro-mcp ${PROCESSING_SERVER_VERSION} on stdio — sessions in ${config.workDir}\n` +
		"Run astro_tools to see which processing programs were found.",
);
