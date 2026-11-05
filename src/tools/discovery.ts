import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DEVICE_TYPES } from "../alpaca/client.js";
import { type ConfiguredDevice, describeServer, discover } from "../alpaca/discovery.js";
import { formatFields } from "../format.js";
import type { DriverKind, Session } from "../session.js";
import { guard, textResult } from "./result.js";

const serverShape = z.object({
	address: z.string(),
	port: z.number(),
	server_name: z.string().optional(),
	devices: z
		.array(
			z.object({
				device_type: z.string(),
				device_number: z.number(),
				device_name: z.string(),
				unique_id: z.string(),
			}),
		)
		.optional(),
	error: z.string().optional(),
});

/** Discovery and device-selection tools. These work with any Alpaca server, not just Seestar. */
export function registerDiscoveryTools(server: McpServer, session: Session): void {
	server.registerTool(
		"alpaca_discover",
		{
			title: "Find Alpaca servers",
			description:
				"Broadcast on the local network for ASCOM Alpaca servers (a Seestar's built-in server, " +
				"seestar_alp, ASCOM simulators, " +
				"and any other Alpaca device) and list the devices each one exposes. Use this when you " +
				"do not know the telescope's address.",
			inputSchema: z.object({
				timeout_s: z
					.number()
					.min(0.2)
					.max(30)
					.optional()
					.describe("How long to listen for answers. Default 2 seconds."),
			}),
			outputSchema: z.object({ servers: z.array(serverShape) }),
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ timeout_s }) =>
			guard(async () => {
				const servers = await discover({ timeoutMs: (timeout_s ?? 2) * 1000 });
				const structured = { servers: servers.map(toStructuredServer) };

				if (servers.length === 0) {
					return textResult(
						"No Alpaca servers answered.\n\n" +
							"Check that the Seestar is on and on the same network (or that seestar_alp is running), " +
							"or connect directly with " +
							"device_connect if you know the address.",
						structured,
					);
				}

				const text = servers
					.map((found) => {
						const header =
							`${found.address}:${found.port}  ${found.description?.ServerName ?? ""}`.trim();
						if (found.error) return `${header}\n  could not read its device list: ${found.error}`;
						const devices = (found.devices ?? []).map(
							(device) =>
								`  ${device.DeviceType.toLowerCase()}/${device.DeviceNumber}  ${device.DeviceName}`,
						);
						return [header, ...devices].join("\n");
					})
					.join("\n\n");

				return textResult(
					`${text}\n\nSeestar tip: the built-in server (port 32323) numbers its devices from 0. On ` +
						'seestar_alp (port 5555) device 0 is the "federation" (all scopes at once) and a real scope is 1.',
					structured,
				);
			}),
	);

	server.registerTool(
		"alpaca_devices",
		{
			title: "List devices on a server",
			description:
				"Read the management API of one Alpaca server and list the devices it serves. Use when " +
				"you know the address but not the device numbers.",
			inputSchema: z.object({
				host: z.string().describe("Address of the Alpaca server, e.g. 192.168.1.20"),
				port: z.number().int().min(1).max(65535).optional().describe("Default 32323"),
			}),
			outputSchema: serverShape,
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ host, port }) =>
			guard(async () => {
				const found = await describeServer({ address: host, port: port ?? session.config.port });
				if (found.error) {
					return textResult(
						`Could not read ${host}:${found.port}: ${found.error}`,
						toStructuredServer(found),
					);
				}

				const lines = (found.devices ?? []).map(
					(device) =>
						`${device.DeviceType.toLowerCase()}/${device.DeviceNumber}  ${device.DeviceName}`,
				);
				return textResult(
					[
						formatFields([
							["server", found.description?.ServerName],
							["version", found.description?.ManufacturerVersion],
							["location", found.description?.Location],
						]),
						"",
						...lines,
					].join("\n"),
					toStructuredServer(found),
				);
			}),
	);

	server.registerTool(
		"device_connect",
		{
			title: "Connect to a device",
			description:
				"Select a device and open a connection to it. Every other tool acts on the device " +
				"selected here. On a Seestar's built-in server every device is number 0 on port 32323; on " +
				"seestar_alp a scope is device_number 1 on port 5555.",
			inputSchema: z.object({
				host: z
					.string()
					.optional()
					.describe("Alpaca server address. Keeps the current one if omitted."),
				port: z.number().int().min(1).max(65535).optional(),
				device_type: z.enum(DEVICE_TYPES).optional().describe("Default telescope"),
				device_number: z
					.number()
					.int()
					.min(0)
					.optional()
					.describe("Default 0. On seestar_alp, 0 addresses all scopes at once — use 1 there."),
				connected: z
					.boolean()
					.optional()
					.describe("Set false to disconnect from the currently selected device."),
			}),
			outputSchema: z.object({
				host: z.string(),
				port: z.number(),
				device_type: z.string(),
				device_number: z.number(),
				connected: z.boolean(),
				name: z.string().optional(),
				driver: z.string().optional(),
				interface_version: z.number().optional(),
				is_seestar: z.boolean().optional(),
				driver_kind: z.enum(["builtin", "seestar_alp", "generic"]).optional(),
			}),
		},
		async ({ host, port, device_type, device_number, connected }) =>
			guard(async () => {
				if (connected === false) {
					const target = await session.disconnect();
					return textResult(`Disconnected from ${target.deviceType}/${target.deviceNumber}.`, {
						host: target.host,
						port: target.port,
						device_type: target.deviceType,
						device_number: target.deviceNumber,
						connected: false,
					});
				}

				const target = await session.connect({
					...(host ? { host } : {}),
					...(port ? { port } : {}),
					...(device_type ? { deviceType: device_type } : {}),
					...(device_number !== undefined ? { deviceNumber: device_number } : {}),
				});

				const device = session.device();
				const described = await device.describe();
				const driver = await session.driver();
				const isSeestar = driver === "seestar_alp";

				const structured = {
					host: target.host,
					port: target.port,
					device_type: target.deviceType,
					device_number: target.deviceNumber,
					connected: true,
					...(described.name !== undefined ? { name: described.name } : {}),
					...(described.driverInfo !== undefined ? { driver: described.driverInfo } : {}),
					...(described.interfaceVersion !== undefined
						? { interface_version: described.interfaceVersion }
						: {}),
					is_seestar: isSeestar,
					driver_kind: driver,
				};

				const text = formatFields([
					[
						"connected to",
						`${target.host}:${target.port} ${target.deviceType}/${target.deviceNumber}`,
					],
					["name", described.name],
					["driver", described.driverInfo],
					["driver version", described.driverVersion],
					["interface", described.interfaceVersion?.toString()],
					["seestar", DRIVER_SUMMARY[driver]],
				]);

				// The default device number suits the built-in server; on seestar_alp the same number is
				// the federation, which sends every command to every scope it manages.
				const federation =
					driver === "seestar_alp" && target.deviceNumber === 0
						? "\n\nWarning: on seestar_alp device 0 is the federation — every command goes to " +
							"every scope it manages. Reconnect with device_number: 1 for a single scope."
						: "";

				return textResult(`${text}${federation}`, structured);
			}),
	);

	server.registerTool(
		"device_info",
		{
			title: "Describe the selected device",
			description:
				"Report what the connected device says about itself: name, driver, interface version " +
				"and the actions it advertises.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async () =>
			guard(async () => {
				const target = session.requireTarget();
				const described = await session.device().describe();
				const actions = described.supportedActions ?? [];

				const text = [
					formatFields([
						["device", `${target.host}:${target.port} ${target.deviceType}/${target.deviceNumber}`],
						["name", described.name],
						["description", described.description],
						["driver", described.driverInfo],
						["driver version", described.driverVersion],
						["interface", described.interfaceVersion?.toString()],
						[
							"connected",
							described.connected === undefined ? undefined : String(described.connected),
						],
						[
							"supported actions",
							actions.length > 0
								? actions.join(", ")
								: "none advertised (seestar_alp always reports none, so this says nothing about what it can do)",
						],
					]),
				].join("\n");

				return textResult(text, {
					host: target.host,
					port: target.port,
					device_type: target.deviceType,
					device_number: target.deviceNumber,
					name: described.name ?? null,
					driver: described.driverInfo ?? null,
					interface_version: described.interfaceVersion ?? null,
					connected: described.connected ?? null,
					supported_actions: actions,
					unavailable: described.unavailable,
				});
			}),
	);
}

function toStructuredServer(found: {
	address: string;
	port: number;
	description?: { ServerName?: string };
	devices?: ConfiguredDevice[];
	error?: string;
}): Record<string, unknown> {
	return {
		address: found.address,
		port: found.port,
		...(found.description?.ServerName ? { server_name: found.description.ServerName } : {}),
		...(found.devices
			? {
					devices: found.devices.map((device) => ({
						device_type: device.DeviceType.toLowerCase(),
						device_number: device.DeviceNumber,
						device_name: device.DeviceName,
						unique_id: device.UniqueID,
					})),
				}
			: {}),
		...(found.error ? { error: found.error } : {}),
	};
}

const DRIVER_SUMMARY: Record<DriverKind, string> = {
	builtin:
		"yes — the Seestar's built-in Alpaca server: telescope_* for the mount, alpaca_* for the rest",
	seestar_alp: "yes — seestar_alp: the seestar_* tools apply",
	generic: "no — generic Alpaca device",
};
