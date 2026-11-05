import { createSocket, type Socket } from "node:dgram";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type AlpacaImage, encodeImageBytes } from "../../src/alpaca/imagebytes.js";
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
	/** Apply only to requests whose path ends with this, letting others through untouched. */
	path?: string;
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
	/** Serve a camera as well (add "camera" to deviceTypes). */
	camera?: FakeCameraOptions;
}

/** A camera the way the Seestar's built-in server presents one. */
export interface FakeCameraOptions {
	width?: number;
	height?: number;
	/** ASCOM SensorType; 2 is RGGB. */
	sensorType?: number;
	bayerOffsetX?: number;
	bayerOffsetY?: number;
	gain?: number;
	/** Pixel value at (x, y). Defaults to a flat 2000. */
	pixel?: (x: number, y: number) => number;
	/** Real milliseconds per exposure second, so tests do not wait for the sky. Default 10. */
	msPerSecond?: number;
	/** Answer imagearray as JSON even when ImageBytes is asked for. */
	jsonOnly?: boolean;
}

/** What the fake camera remembers, per device number. */
export interface FakeCameraState {
	gain: number;
	exposures: Array<{ duration: number; light: boolean }>;
	readyAt: number | undefined;
}

export interface FakeAlpaca {
	readonly host: string;
	readonly port: number;
	readonly url: string;
	/** Port the UDP discovery responder listens on, when `discovery` was enabled. */
	readonly discoveryPort: number | undefined;
	readonly sim: SeestarSim;
	readonly requests: RecordedRequest[];
	/** Per-device state of the fake camera, when one is served. */
	readonly cameras: Map<number, FakeCameraState>;
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
	const cameras = new Map<number, FakeCameraState>();
	const connected = new Map<number, boolean>();
	const failures: FailureSpec[] = [];
	let serverTransactionId = 0;

	const takeFailure = (pathname: string): FailureSpec | undefined => {
		const failure = failures[0];
		if (!failure) return undefined;
		if (failure.path && !pathname.endsWith(failure.path)) return undefined;
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

		const failure = takeFailure(url.pathname);
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

		if (deviceType === "camera") {
			handleCamera({
				options: options.camera ?? {},
				cameras,
				deviceNumber,
				method,
				httpMethod: request.method ?? "GET",
				params,
				accept: request.headers.accept ?? "",
				connected,
				send,
				sendError,
				response,
			});
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
		cameras,
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

interface CameraRequest {
	options: FakeCameraOptions;
	cameras: Map<number, FakeCameraState>;
	deviceNumber: number;
	method: string;
	httpMethod: string;
	params: Record<string, string>;
	accept: string;
	connected: Map<number, boolean>;
	send: (payload: Record<string, unknown>) => void;
	sendError: (errorNumber: number, errorMessage: string) => void;
	response: ServerResponse;
}

function handleCamera(request: CameraRequest): void {
	const { options, cameras, deviceNumber, method, params, send, sendError } = request;
	const width = options.width ?? 64;
	const height = options.height ?? 32;
	let state = cameras.get(deviceNumber);
	if (!state) {
		state = { gain: options.gain ?? 0, exposures: [], readyAt: undefined };
		cameras.set(deviceNumber, state);
	}

	if (request.httpMethod === "PUT") {
		switch (method) {
			case "connected":
				request.connected.set(deviceNumber, (params.Connected ?? "").toLowerCase() === "true");
				send({ Value: null });
				return;
			case "gain":
				state.gain = Number(params.Gain);
				send({ Value: null });
				return;
			case "startexposure": {
				const duration = Number(params.Duration);
				state.exposures.push({ duration, light: (params.Light ?? "").toLowerCase() === "true" });
				state.readyAt = Date.now() + duration * (options.msPerSecond ?? 10);
				send({ Value: null });
				return;
			}
			case "abortexposure":
				state.readyAt = undefined;
				send({ Value: null });
				return;
			default:
				sendError(0x400, `${method} is not implemented`);
				return;
		}
	}

	const imageReady = state.readyAt !== undefined && Date.now() >= state.readyAt;
	const values: Record<string, unknown> = {
		connected: request.connected.get(deviceNumber) ?? false,
		name: `Fake Seestar ${deviceNumber === 0 ? "Telephoto" : "Wide Angle"} Camera`,
		description: "Camera V3",
		driverinfo: "Camera V3",
		driverversion: "1.3.1-1",
		interfaceversion: 3,
		sensorname: "",
		sensortype: options.sensorType ?? 2,
		cameraxsize: width,
		cameraysize: height,
		pixelsizex: 2.9,
		pixelsizey: 2.9,
		bayeroffsetx: options.bayerOffsetX ?? 1,
		bayeroffsety: options.bayerOffsetY ?? 0,
		gain: state.gain,
		gainmin: 0,
		gainmax: 600,
		offset: 0,
		exposuremin: 0.00003,
		exposuremax: 2000,
		maxadu: 65535,
		ccdtemperature: 25.5,
		camerastate: state.readyAt !== undefined && !imageReady ? 2 : 0,
		imageready: imageReady,
	};

	if (method === "imagearray") {
		if (!imageReady) {
			sendError(0x40b, "No image available");
			return;
		}
		const pixel = options.pixel ?? (() => 2000);
		const pixels = new Int32Array(width * height);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) pixels[y * width + x] = pixel(x, y);
		}
		const image: AlpacaImage = { width, height, pixels };

		if (!options.jsonOnly && request.accept.includes("application/imagebytes")) {
			const body = encodeImageBytes(image, 8);
			request.response.writeHead(200, {
				"Content-Type": "application/imagebytes",
				"Content-Length": String(body.byteLength),
			});
			request.response.end(Buffer.from(body));
			return;
		}
		const columns: number[][] = [];
		for (let x = 0; x < width; x++) {
			const column: number[] = [];
			for (let y = 0; y < height; y++) column.push(pixels[y * width + x] as number);
			columns.push(column);
		}
		send({ Type: 2, Rank: 2, Value: columns });
		return;
	}

	if (!(method in values)) {
		sendError(0x400, `${method} is not implemented`);
		return;
	}
	send({ Value: values[method] });
}
