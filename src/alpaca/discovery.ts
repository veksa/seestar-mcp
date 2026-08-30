import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";
import { AlpacaClient } from "./client.js";

/** Alpaca discovery is a UDP broadcast: send this string, get a port back. */
const DISCOVERY_MESSAGE = "alpacadiscovery1";
export const DEFAULT_DISCOVERY_PORT = 32227;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 2_000;

export interface AlpacaServerAddress {
	address: string;
	/** The port the Alpaca management and device APIs listen on — not the discovery port. */
	port: number;
}

export interface ConfiguredDevice {
	DeviceName: string;
	DeviceType: string;
	DeviceNumber: number;
	UniqueID: string;
}

export interface ServerDescription {
	ServerName?: string;
	Manufacturer?: string;
	ManufacturerVersion?: string;
	Location?: string;
}

export interface DiscoveredServer extends AlpacaServerAddress {
	description?: ServerDescription;
	devices?: ConfiguredDevice[];
	/** Set when the server answered discovery but its management API could not be read. */
	error?: string;
}

export interface DiscoveryOptions {
	/** How long to listen for answers. Every reachable device answers within a few ms. */
	timeoutMs?: number;
	/** Port to broadcast on. Only worth changing in tests. */
	discoveryPort?: number;
	/** Addresses to probe. Defaults to the broadcast address of every IPv4 interface. */
	addresses?: string[];
	/** Local address to bind the probe socket to. Tests use 127.0.0.1 to stay off the network. */
	bindAddress?: string;
	signal?: AbortSignal;
}

/**
 * Broadcast addresses for every non-internal IPv4 interface, plus the global one.
 *
 * The global 255.255.255.255 alone is not enough: it is dropped by some stacks and routers, while a
 * per-interface directed broadcast reaches devices on that subnet.
 */
export function broadcastAddresses(): string[] {
	const addresses = new Set<string>(["255.255.255.255"]);

	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.internal || entry.family !== "IPv4" || !entry.netmask) continue;
			const address = entry.address.split(".").map(Number);
			const netmask = entry.netmask.split(".").map(Number);
			if (address.length !== 4 || netmask.length !== 4) continue;

			const broadcast = address.map((octet, index) => {
				const mask = netmask[index] ?? 0;
				return (octet & mask) | (~mask & 0xff);
			});
			addresses.add(broadcast.join("."));
		}
	}

	return [...addresses];
}

/** Send the discovery probe and collect every server that answers. */
export function discoverServers(options: DiscoveryOptions = {}): Promise<AlpacaServerAddress[]> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
	const discoveryPort = options.discoveryPort ?? DEFAULT_DISCOVERY_PORT;
	const targets = options.addresses ?? broadcastAddresses();

	return new Promise((resolve, reject) => {
		const found = new Map<string, AlpacaServerAddress>();
		const socket = createSocket({ type: "udp4", reuseAddr: true });
		let settled = false;

		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			socket.close(() => (error ? reject(error) : resolve([...found.values()])));
		};

		const timer = setTimeout(() => finish(), timeoutMs);
		const onAbort = () => finish();
		options.signal?.addEventListener("abort", onAbort, { once: true });

		socket.on("message", (message, remote) => {
			try {
				const payload = JSON.parse(message.toString("utf8")) as {
					AlpacaPort?: number;
				};
				if (typeof payload.AlpacaPort !== "number") return;
				const server = { address: remote.address, port: payload.AlpacaPort };
				found.set(`${server.address}:${server.port}`, server);
			} catch {
				// Not an Alpaca answer — some other service replying on the same port.
			}
		});

		socket.on("error", (error) => finish(error));

		socket.bind(
			{
				port: 0,
				...(options.bindAddress ? { address: options.bindAddress } : {}),
			},
			() => {
				socket.setBroadcast(true);
				const probe = Buffer.from(DISCOVERY_MESSAGE, "utf8");
				for (const address of targets) {
					// A single unreachable interface must not abort the whole sweep.
					socket.send(probe, discoveryPort, address, () => undefined);
				}
			},
		);
	});
}

/** Read a server's management API: who it is and what devices it exposes. */
export async function describeServer(
	server: AlpacaServerAddress,
	options: {
		timeoutMs?: number;
		signal?: AbortSignal;
		fetch?: typeof globalThis.fetch;
	} = {},
): Promise<DiscoveredServer> {
	const client = new AlpacaClient({
		host: server.address,
		port: server.port,
		timeoutMs: options.timeoutMs ?? 5_000,
		...(options.fetch ? { fetch: options.fetch } : {}),
	});

	const requestOptions = options.signal ? { signal: options.signal } : {};

	try {
		const [description, devices] = await Promise.all([
			client.management<ServerDescription>("v1/description", requestOptions),
			client.management<ConfiguredDevice[]>("v1/configureddevices", requestOptions),
		]);
		return { ...server, description, devices };
	} catch (error) {
		return {
			...server,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Discover servers and describe each one. The tool layer calls this. */
export async function discover(options: DiscoveryOptions = {}): Promise<DiscoveredServer[]> {
	const servers = await discoverServers(options);
	const described = await Promise.all(
		servers.map((server) =>
			describeServer(server, options.signal ? { signal: options.signal } : {}),
		),
	);
	return described;
}
