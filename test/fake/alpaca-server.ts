import { createSocket, type Socket } from "node:dgram";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SeestarSim } from "./seestar-sim.js";

/**
 * An ASCOM Alpaca server that behaves like `seestar_alp`.
 *
 * Deliberately faithful to the quirks that bite real clients:
 *   - only the `telescope` device type exists
 *   - device 0 is the "federation" (all scopes), real scopes start at 1
 *   - `supportedactions` is always empty
 *   - almost every property fails with NotConnected until `connected` is set
 *
 * It also injects failures on demand, which is the whole point of owning the fake instead of
 * pointing the tests at a real simulator.
 */

export interface FailureSpec {
	/** Answer with this HTTP status instead of a normal response. */
	status?: number;
	/** Answer with a normal envelope carrying this ASCOM error. */
	errorNumber?: number;
	errorMessage?: string;
	/** Return a body that is not JSON. */
	garbage?: boolean;
	/** Destroy the socket without answering. */
	drop?: boolean;
	/** Delay the answer, to trip client timeouts. */
	delayMs?: number;
	/** How many requests this failure applies to. Defaults to 1. */
	times?: number;
}

export interface RecordedRequest {
	method: string;
	path: string;
	params: Record<string, string>;
}

export interface FakeAlpacaOptions {
	sim?: SeestarSim;
	/** Device numbers that exist. Seestar uses 0 (federation) and 1..n (scopes). */
	deviceNumbers?: number[];
	/** Device types this server serves. seestar_alp serves telescopes only. */
	deviceTypes?: string[];
	serverName?: string;
	/** Override how the device describes itself, to stand in for a non-Seestar driver. */
	identity?: { name?: string; description?: string; driverInfo?: string };
	/** Start a UDP discovery responder as well. */
	discovery?: boolean;
	/**
	 * Behave like the Seestar's built-in Alpaca server: same "Seestar" naming, but no action layer,
	 * so every `action` answers ActionNotImplemented.
	 */
	builtin?: boolean;
	/** Require HTTP Basic credentials on the device API, as "Require Authorization" does. */
	credentials?: { username: string; password: string };
}

export interface FakeAlpaca {
	readonly host: string;
	readonly port: number;
	readonly url: string;
	/** Port the UDP discovery responder listens on, when `discovery` was enabled. */
	readonly discoveryPort: number | undefined;
	readonly sim: SeestarSim;
	readonly requests: RecordedRequest[];
	/** Queue a failure for the next request(s). */
	failNext(spec: FailureSpec): void;
	/** Mark a device connected or not without going through the protocol. */
	setConnected(deviceNumber: number, connected: boolean): void;
	close(): Promise<void>;
}

const NOT_FOUND = Symbol("not-found");
const NOT_CONNECTED = 0x407;
const ACTION_NOT_IMPLEMENTED = 0x40c;
const INVALID_VALUE = 0x401;

/** Properties readable before the device is connected. */
const ALWAYS_READABLE = new Set([
	"connected",
	"name",
	"description",
	"driverinfo",
	"driverversion",
	"interfaceversion",
	"supportedactions",
]);

export async function startFakeAlpaca(options: FakeAlpacaOptions = {}): Promise<FakeAlpaca> {
	const sim = options.sim ?? new SeestarSim();
	const deviceNumbers = new Set(options.deviceNumbers ?? [0, 1]);
	const deviceTypes = new Set(options.deviceTypes ?? ["telescope"]);
	const serverName = options.serverName ?? "seestar_alp (fake)";
	// The strings the real driver reports (device/telescope.py, TelescopeMetadata).
	const identity = {
		description: options.identity?.description ?? "Alpaca Driver for Seestar S50 Smart Telescope",
		driverInfo:
			options.identity?.driverInfo ??
			"Alpaca Driver for Seestar S50 Smart Telescope\nImplements ITelescope",
		name: options.identity?.name,
	};
	const requests: RecordedRequest[] = [];
	const connected = new Map<number, boolean>();
	const failures: FailureSpec[] = [];
	let serverTransactionId = 0;

	const takeFailure = (): FailureSpec | undefined => {
		const failure = failures[0];
		if (!failure) return undefined;
		const remaining = (failure.times ?? 1) - 1;
		if (remaining <= 0) failures.shift();
		else failure.times = remaining;
		return failure;
	};

	const server = createServer((request, response) => {
		handle(request, response).catch(() => {
			if (!response.writableEnded) {
				response.writeHead(500, { "Content-Type": "text/plain" });
				response.end("fake server error");
			}
		});
	});

	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", "http://localhost");
		const params = await readParams(request, url);
		requests.push({
			method: request.method ?? "GET",
			path: url.pathname,
			params,
		});

		// Only the device API is protected; management stays open, as on the real server.
		if (options.credentials && url.pathname.startsWith("/api/")) {
			const { username, password } = options.credentials;
			const expected = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
			if (request.headers.authorization !== expected) {
				response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Alpaca"' });
				response.end();
				return;
			}
		}

		const clientTransactionId = Number(findCaseless(params, "ClientTransactionID") ?? "0");
		const send = (payload: Record<string, unknown>) => {
			respond(response, 200, {
				ClientTransactionID: clientTransactionId,
				ServerTransactionID: ++serverTransactionId,
				ErrorNumber: 0,
				ErrorMessage: "",
				...payload,
			});
		};
		const sendError = (errorNumber: number, errorMessage: string) => {
			send({
				Value: null,
				ErrorNumber: errorNumber,
				ErrorMessage: errorMessage,
			});
		};

		const failure = takeFailure();
		if (failure) {
			if (failure.delayMs) await delay(failure.delayMs);
			if (failure.drop) {
				request.destroy();
				response.destroy();
				return;
			}
			if (failure.garbage) {
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end("<html>not json</html>");
				return;
			}
			if (failure.status) {
				respondText(response, failure.status, `injected failure ${failure.status}`);
				return;
			}
			if (failure.errorNumber) {
				sendError(failure.errorNumber, failure.errorMessage ?? "injected device error");
				return;
			}
		}

		// The telescope's own file store, served over plain HTTP the way the real one serves MyWorks.
		if (url.pathname.startsWith("/MyWorks/")) {
			const name = decodeURIComponent(url.pathname.split("/").pop() ?? "");
			if (!/\.(jpg|jpeg|fit|fits)$/i.test(name)) {
				respondText(response, 404, "not an image");
				return;
			}
			// Deterministic contents, and a different length per file so tests can tell them apart.
			const body = Buffer.from(`FAKE-IMAGE:${url.pathname}`.padEnd(256 + name.length, "."));
			response.writeHead(200, {
				"Content-Type": name.toLowerCase().endsWith(".jpg") ? "image/jpeg" : "application/fits",
				"Content-Length": String(body.length),
			});
			response.end(body);
			return;
		}

		if (url.pathname.startsWith("/management")) {
			handleManagement(url.pathname, send, response, serverName, deviceNumbers);
			return;
		}

		const route = url.pathname.match(/^\/api\/v1\/([a-z]+)\/(\d+)\/([a-z]+)$/i);
		if (!route) {
			respondText(response, 400, "unknown route");
			return;
		}

		const [, deviceTypeRaw = "", deviceNumberRaw = "", methodRaw = ""] = route;
		const deviceType = deviceTypeRaw.toLowerCase();
		const deviceNumber = Number(deviceNumberRaw);
		const method = methodRaw.toLowerCase();

		if (!deviceTypes.has(deviceType)) {
			respondText(response, 400, `device type ${deviceType} not served`);
			return;
		}
		if (!deviceNumbers.has(deviceNumber)) {
			respondText(response, 400, `device number ${deviceNumber} out of range`);
			return;
		}

		// Device 0 is the federation endpoint and does not require a connection of its own.
		const isConnected = deviceNumber === 0 || (connected.get(deviceNumber) ?? false);
		if (!isConnected && !ALWAYS_READABLE.has(method)) {
			sendError(NOT_CONNECTED, "Not connected.");
			return;
		}

		if (request.method === "GET") {
			const value = readProperty(sim, method, deviceNumber, connected, identity);
			if (value === NOT_FOUND) {
				respondText(response, 400, `unknown property ${method}`);
				return;
			}
			send({ Value: value });
			return;
		}

		if (request.method === "PUT") {
			const result =
				options.builtin && method === "action"
					? {
							error: {
								number: ACTION_NOT_IMPLEMENTED,
								message: `Action ${params.Action} is not implemented by this driver`,
							},
						}
					: writeProperty(sim, method, params, deviceNumber, connected);
			if (result === NOT_FOUND) {
				respondText(response, 400, `unknown method ${method}`);
				return;
			}
			if (typeof result === "object" && result !== null && "error" in result) {
				const { error } = result as {
					error: { number: number; message: string };
				};
				sendError(error.number, error.message);
				return;
			}
			send({ Value: (result as { value: unknown }).value });
			return;
		}

		respondText(response, 405, "method not allowed");
	}

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	// The telescope serves its files from its own address; point the simulated one at this server.
	sim.imageBaseUrl = `http://127.0.0.1:${port}`;

	let discoverySocket: Socket | undefined;
	let discoveryPort: number | undefined;
	if (options.discovery) {
		discoverySocket = createSocket({ type: "udp4", reuseAddr: true });
		discoverySocket.on("message", (message, remote) => {
			if (message.toString("utf8").trim() !== "alpacadiscovery1") return;
			const reply = Buffer.from(JSON.stringify({ AlpacaPort: port }), "utf8");
			discoverySocket?.send(reply, remote.port, remote.address, () => undefined);
		});
		await new Promise<void>((resolve) => discoverySocket?.bind(0, "127.0.0.1", resolve));
		discoveryPort = (discoverySocket.address() as AddressInfo).port;
	}

	return {
		host: "127.0.0.1",
		port,
		url: `http://127.0.0.1:${port}`,
		discoveryPort,
		sim,
		requests,
		failNext(spec) {
			failures.push(spec);
		},
		setConnected(deviceNumber, value) {
			connected.set(deviceNumber, value);
		},
		async close() {
			await new Promise<void>((resolve) => {
				discoverySocket ? discoverySocket.close(() => resolve()) : resolve();
			});
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		},
	};
}

function handleManagement(
	pathname: string,
	send: (payload: Record<string, unknown>) => void,
	response: ServerResponse,
	serverName: string,
	deviceNumbers: Set<number>,
): void {
	if (pathname === "/management/apiversions") {
		send({ Value: [1] });
		return;
	}
	if (pathname === "/management/v1/description") {
		send({
			Value: {
				ServerName: serverName,
				Manufacturer: "smart-underworld",
				ManufacturerVersion: "test",
				Location: "Anywhere on Earth",
			},
		});
		return;
	}
	if (pathname === "/management/v1/configureddevices") {
		send({
			Value: [...deviceNumbers].map((deviceNumber) => ({
				DeviceName: deviceNumber === 0 ? "Seestar Federation" : `Seestar ${deviceNumber}`,
				DeviceType: "Telescope",
				DeviceNumber: deviceNumber,
				UniqueID: `fake-seestar-${deviceNumber}`,
			})),
		});
		return;
	}
	respondText(response, 404, "unknown management endpoint");
}

function readProperty(
	sim: SeestarSim,
	method: string,
	deviceNumber: number,
	connected: Map<number, boolean>,
	identity: { name?: string; description: string; driverInfo: string },
): unknown {
	switch (method) {
		case "connected":
			return deviceNumber === 0 || (connected.get(deviceNumber) ?? false);
		case "name":
			return (
				identity.name ?? (deviceNumber === 0 ? "Seestar Federation" : `Seestar ${deviceNumber}`)
			);
		case "description":
			return identity.description;
		case "driverinfo":
			return identity.driverInfo;
		case "driverversion":
			return "1.0";
		case "interfaceversion":
			return 3;
		// Always empty on the real driver, which is why we cannot discover actions.
		case "supportedactions":
			return [];
		case "alignmentmode":
			return 1;
		case "equatorialsystem":
			return 1;
		case "focallength":
			return 0.25;
		case "aperturediameter":
			return 0.05;
		case "aperturearea":
			return Math.PI * 0.025 ** 2;
		case "rightascension":
			sim.settle();
			return sim.rightAscension;
		case "declination":
			sim.settle();
			return sim.declination;
		case "targetrightascension":
			return sim.targetRightAscension;
		case "targetdeclination":
			return sim.targetDeclination;
		case "altitude":
			return sim.altitude;
		case "azimuth":
			return sim.azimuth;
		case "siderealtime":
			return sim.siderealTime;
		case "slewing":
			return sim.slewing;
		case "tracking":
			sim.settle();
			return sim.tracking;
		case "atpark":
			sim.settle();
			return sim.atPark;
		case "athome":
			sim.settle();
			return sim.atHome;
		case "sitelatitude":
			return sim.siteLatitude;
		case "sitelongitude":
			return sim.siteLongitude;
		case "siteelevation":
			return sim.siteElevation;
		case "slewsettletime":
			return sim.slewSettleTime;
		case "utcdate":
			return new Date().toISOString();
		case "trackingrate":
			return 0;
		case "trackingrates":
			return [0];
		case "doesrefraction":
			return false;
		case "ispulseguiding":
			return false;
		case "sideofpier":
			return 0;
		case "declinationrate":
		case "rightascensionrate":
		case "guideratedeclination":
		case "guideraterightascension":
			return 0;
		case "canslewasync":
		case "cansync":
		case "canpark":
		case "canunpark":
		case "canfindhome":
		case "cansettracking":
			return true;
		case "canslew":
		case "canslewaltaz":
		case "canslewaltazasync":
		case "cansyncaltaz":
		case "canpulseguide":
		case "cansetpark":
		case "cansetpierside":
		case "cansetguiderates":
		case "cansetdeclinationrate":
		case "cansetrightascensionrate":
			return false;
		default:
			return NOT_FOUND;
	}
}

function writeProperty(
	sim: SeestarSim,
	method: string,
	params: Record<string, string>,
	deviceNumber: number,
	connected: Map<number, boolean>,
): typeof NOT_FOUND | { value: unknown } | { error: { number: number; message: string } } {
	const number = (name: string): number => Number(params[name]);
	const boolean = (name: string): boolean => (params[name] ?? "").toLowerCase() === "true";

	switch (method) {
		case "connected":
			connected.set(deviceNumber, boolean("Connected"));
			return { value: null };
		case "tracking":
			sim.tracking = boolean("Tracking");
			return { value: null };
		case "sitelatitude":
			sim.siteLatitude = number("SiteLatitude");
			return { value: null };
		case "sitelongitude":
			sim.siteLongitude = number("SiteLongitude");
			return { value: null };
		case "siteelevation":
			sim.siteElevation = number("SiteElevation");
			return { value: null };
		case "slewsettletime":
			sim.slewSettleTime = number("SlewSettleTime");
			return { value: null };
		case "targetrightascension":
			sim.targetRightAscension = number("TargetRightAscension");
			return { value: null };
		case "targetdeclination":
			sim.targetDeclination = number("TargetDeclination");
			return { value: null };
		case "slewtocoordinates":
		case "slewtocoordinatesasync": {
			const ra = number("RightAscension");
			const dec = number("Declination");
			if (!Number.isFinite(ra) || ra < 0 || ra > 24) {
				return {
					error: {
						number: INVALID_VALUE,
						message: `RightAscension ${ra} out of range`,
					},
				};
			}
			if (!Number.isFinite(dec) || dec < -90 || dec > 90) {
				return {
					error: {
						number: INVALID_VALUE,
						message: `Declination ${dec} out of range`,
					},
				};
			}
			if (sim.atPark) {
				return {
					error: { number: 0x408, message: "Cannot slew while parked" },
				};
			}
			sim.startSlew(ra, dec);
			return { value: null };
		}
		case "slewtotargetasync":
			if (sim.atPark) {
				return {
					error: { number: 0x408, message: "Cannot slew while parked" },
				};
			}
			sim.startSlew(sim.targetRightAscension, sim.targetDeclination);
			return { value: null };
		case "synctocoordinates":
			sim.rightAscension = number("RightAscension");
			sim.declination = number("Declination");
			return { value: null };
		case "abortslew":
			sim.abortSlew();
			return { value: null };
		case "park":
			sim.park();
			return { value: null };
		case "unpark":
			sim.unpark();
			return { value: null };
		case "findhome":
			sim.findHome();
			return { value: null };
		case "moveaxis":
		case "pulseguide":
			return { value: null };
		case "commandblind":
		case "commandbool":
		case "commandstring":
			return {
				error: { number: 0x400, message: "CommandBlind is not implemented" },
			};
		case "action": {
			const action = params.Action;
			if (!action) {
				return {
					error: {
						number: INVALID_VALUE,
						message: 'Missing parameter "Action"',
					},
				};
			}
			let parsed: Record<string, unknown> = {};
			if (params.Parameters) {
				try {
					parsed = JSON.parse(params.Parameters) as Record<string, unknown>;
				} catch {
					return {
						error: {
							number: INVALID_VALUE,
							message: "Parameters is not valid JSON",
						},
					};
				}
			}
			return { value: sim.action(action, parsed) ?? "" };
		}
		default:
			return NOT_FOUND;
	}
}

async function readParams(request: IncomingMessage, url: URL): Promise<Record<string, string>> {
	const params: Record<string, string> = {};
	for (const [key, value] of url.searchParams) params[key] = value;

	if (request.method === "PUT" || request.method === "POST") {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk as Buffer);
		const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
		for (const [key, value] of body) params[key] = value;
	}

	return params;
}

/** ClientID and ClientTransactionID are matched case-insensitively by the real server. */
function findCaseless(params: Record<string, string>, name: string): string | undefined {
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(params)) {
		if (key.toLowerCase() === wanted) return value;
	}
	return undefined;
}

function respond(response: ServerResponse, status: number, payload: unknown): void {
	response.writeHead(status, { "Content-Type": "application/json" });
	response.end(JSON.stringify(payload));
}

function respondText(response: ServerResponse, status: number, text: string): void {
	response.writeHead(status, { "Content-Type": "text/plain" });
	response.end(text);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
