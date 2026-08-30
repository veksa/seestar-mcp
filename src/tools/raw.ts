import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Session } from "../session.js";
import { errorResult, guard, textResult } from "./result.js";

/**
 * The tools that can do anything — and the ones that can end the night.
 *
 * `seestar_raw` reaches firmware methods no dedicated tool covers; the power tools turn the
 * telescope off. Both are off the default path: raw can be hidden with `--no-raw`, and power needs
 * `--allow-destructive` plus an explicit confirmation in the call.
 */
export function registerRawTools(server: McpServer, session: Session): void {
	const { allowRaw, allowDestructive, readOnly } = session.config;

	if (allowRaw && !readOnly) {
		server.registerTool(
			"seestar_raw",
			{
				title: "Raw firmware command",
				description:
					"Send a JSON-RPC method straight to the telescope firmware, for anything the other " +
					"tools do not cover — for example get_camera_info, get_disk_volume, iscope_start_view. " +
					"Prefer a dedicated tool where one exists; this one has no guard rails.",
				inputSchema: z.object({
					method: z.string().describe("Firmware method name, e.g. get_camera_info"),
					params: z
						.string()
						.optional()
						.describe(
							'Parameters as JSON — an object like {"stage":"Stack"} or an array like ["gain",80]',
						),
					wait: z
						.boolean()
						.optional()
						.describe("Wait for the reply (default). False fires the command and returns."),
				}),
			},
			async ({ method, params, wait }) =>
				guard(async () => {
					let parsed: unknown;
					if (params !== undefined && params !== "") {
						try {
							parsed = JSON.parse(params);
						} catch (error) {
							return errorResult(
								`params must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
					}

					const actions = session.seestar().actions;
					const result =
						wait === false
							? await actions.methodAsync(method, parsed)
							: await actions.methodSync(method, parsed);

					return textResult(`${method} returned:\n${JSON.stringify(result, null, 2)}`, {
						method,
						result: result as unknown,
					});
				}),
		);
	}

	if (!allowDestructive || readOnly) return;

	server.registerTool(
		"seestar_power",
		{
			title: "Shut down or reboot",
			description:
				"Power the telescope off or reboot it. Shutting down ends the session: the telescope " +
				"has to be woken by its button afterwards, so it cannot be undone remotely. Park first " +
				"if the arm is still open.",
			inputSchema: z.object({
				operation: z.enum(["shutdown", "reboot"]),
				confirm: z
					.literal(true)
					.describe("Must be true. Confirms that ending the session now is intended."),
			}),
			annotations: { destructiveHint: true, idempotentHint: false },
		},
		async ({ operation }) =>
			guard(async () => {
				const seestar = session.seestar();
				if (operation === "shutdown") {
					await seestar.shutdown();
					return textResult(
						"Shutting down. The telescope will not answer again until it is switched on by hand.",
					);
				}
				await seestar.reboot();
				return textResult("Rebooting. Give it a minute, then run device_connect again.");
			}),
	);
}
