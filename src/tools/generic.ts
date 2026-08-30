import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type AlpacaParams, DEVICE_TYPES, type DeviceType } from "../alpaca/client.js";
import { AlpacaDevice } from "../alpaca/device.js";
import type { Session } from "../session.js";
import { errorResult, guard, textResult } from "./result.js";

/**
 * The generic Alpaca escape hatch.
 *
 * Dedicated tools exist for telescopes and for Seestar; these two reach anything else in the
 * specification — a focuser's position, a filter wheel's names, a switch, a dome — without needing a
 * typed wrapper for every device class.
 */
export function registerGenericTools(server: McpServer, session: Session): void {
	const target = (deviceType?: DeviceType, deviceNumber?: number): AlpacaDevice => {
		const current = session.requireTarget();
		return new AlpacaDevice(
			session.client(current.host, current.port),
			deviceType ?? current.deviceType,
			deviceNumber ?? current.deviceNumber,
		);
	};

	server.registerTool(
		"alpaca_get_property",
		{
			title: "Read any Alpaca property",
			description:
				"Read one property from any device on the connected server — for example focuser " +
				"position, filterwheel names, camera ccdtemperature. Property names are the Alpaca ones, " +
				"lower case.",
			inputSchema: z.object({
				property: z.string().describe("Property or GET method name, e.g. position or names"),
				device_type: z.enum(DEVICE_TYPES).optional().describe("Defaults to the connected device"),
				device_number: z.number().int().min(0).optional(),
			}),
			annotations: { readOnlyHint: true },
		},
		async ({ property, device_type, device_number }) =>
			guard(async () => {
				const device = target(device_type, device_number);
				const value = await device.get<unknown>(property);
				return textResult(`${device.id}/${property} = ${format(value)}`, {
					device_type: device.deviceType,
					device_number: device.deviceNumber,
					property,
					value: value as unknown,
				});
			}),
	);

	if (session.config.readOnly) return;

	server.registerTool(
		"alpaca_put",
		{
			title: "Write any Alpaca property or call any method",
			description:
				"Send a PUT to any device on the connected server — set a property, or invoke a method " +
				"such as focuser move or filterwheel position. Parameter names are case-sensitive and " +
				'must match the Alpaca specification exactly, e.g. {"Position": 3}.',
			inputSchema: z.object({
				method: z.string().describe("Property or method name, e.g. position or move"),
				params: z.string().optional().describe('Parameters as a JSON object, e.g. {"Position": 3}'),
				device_type: z.enum(DEVICE_TYPES).optional(),
				device_number: z.number().int().min(0).optional(),
			}),
		},
		async ({ method, params, device_type, device_number }) =>
			guard(async () => {
				const parsed: AlpacaParams = {};
				if (params !== undefined && params !== "") {
					let decoded: unknown;
					try {
						decoded = JSON.parse(params);
					} catch (error) {
						return errorResult(
							`params must be a JSON object: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
					if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
						return errorResult('params must be a JSON object, e.g. {"Position": 3}');
					}
					// Alpaca takes form fields, so every value goes on the wire as a scalar.
					for (const [key, value] of Object.entries(decoded as Record<string, unknown>)) {
						if (typeof value === "object" && value !== null) {
							return errorResult(`params.${key} must be a string, number or boolean`);
						}
						parsed[key] = value as string | number | boolean;
					}
				}

				const device = target(device_type, device_number);
				const value = await device.put<unknown>(method, parsed);
				return textResult(
					`${device.id}/${method} accepted.${value === null ? "" : `\n${format(value)}`}`,
					{
						device_type: device.deviceType,
						device_number: device.deviceNumber,
						method,
						result: value as unknown,
					},
				);
			}),
	);
}

function format(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value === "object") return JSON.stringify(value, null, 2);
	return String(value);
}
