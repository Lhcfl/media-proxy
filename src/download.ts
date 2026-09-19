import * as fs from 'node:fs';
import * as stream from 'node:stream';
import * as util from 'node:util';
import * as http from 'node:http';
import * as https from 'node:https';
import ipaddr from 'ipaddr.js';
import got, * as Got from 'got';
import { StatusError } from './status-error.ts';
import { getAgents } from './agents.ts';
import { parseContentDispositionFilename } from './web.ts';

const pipeline = util.promisify(stream.pipeline);

export type DownloadConfig = {
	userAgent: string;
	allowedPrivateNetworks: string[];
	maxSize: number;
	httpAgent: http.Agent;
	httpsAgent: https.Agent;
	/** True when requests are sent through a forward proxy. */
	proxy?: boolean;
};

export const defaultDownloadConfig: DownloadConfig = {
	userAgent: 'MisskeyMediaProxy/0.0.0',
	allowedPrivateNetworks: [],
	maxSize: 262144000,
	proxy: false,
	...getAgents(),
};

/** True when the address must not be reached through the proxy. */
function isBlockedAddress(ip: string, allowedPrivateNetworks: string[]): boolean {
	let parsed: ipaddr.IPv4 | ipaddr.IPv6;
	try {
		parsed = ipaddr.parse(ip);
	} catch {
		return true;
	}

	for (const network of allowedPrivateNetworks ?? []) {
		try {
			if (parsed.match(ipaddr.parseCIDR(network))) return false;
		} catch {
			// ignore malformed allowlist entries
		}
	}

	return parsed.range() !== 'unicast';
}

/**
 * With a forward proxy, got connects to the proxy, so res.ip is the proxy's
 * address and cannot vouch for the target. Resolve the target locally and check
 * every answer instead. This leaves a small DNS-rebinding window, unlike the
 * direct path which checks the connected socket.
 */
async function assertPublicHost(hostname: string, allowedPrivateNetworks: string[]): Promise<void> {
	let host = hostname;
	if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

	const check = (ip: string) => {
		if (isBlockedAddress(ip, allowedPrivateNetworks)) {
			throw new StatusError(`Blocked address: ${ip}`, 403, 'Blocked address');
		}
	};

	if (ipaddr.isValid(host)) {
		check(host);
		return;
	}

	let addresses: Array<{ address: string }>;
	try {
		addresses = await Bun.dns.lookup(host);
	} catch {
		// Let got surface the real error for an unresolvable host.
		return;
	}
	for (const { address } of addresses) check(address);
}

export async function downloadUrl(url: string, path: string, settings: DownloadConfig = defaultDownloadConfig): Promise<{ filename: string }> {
	const urlObj = new URL(url);
	let filename = urlObj.pathname.split('/').pop() || 'unknown';

	if (settings.proxy) {
		await assertPublicHost(urlObj.hostname, settings.allowedPrivateNetworks);
	}

	const timeout = 30 * 1000;
	const operationTimeout = 60 * 1000;

	const req = got.stream(url, {
		headers: {
			'User-Agent': settings.userAgent,
		},
		timeout: {
			lookup: timeout,
			connect: timeout,
			secureConnect: timeout,
			socket: timeout, // read timeout
			response: timeout,
			send: timeout,
			request: operationTimeout, // whole operation timeout
		},
		agent: {
			http: settings.httpAgent,
			https: settings.httpsAgent,
		},
		http2: false,
		retry: {
			limit: 0,
		},
		enableUnixSockets: false,
	}).on('response', (res: Got.Response) => {
		if (!settings.proxy && res.ip) {
			if (isBlockedAddress(res.ip, settings.allowedPrivateNetworks)) {
				console.log(`Blocked address: ${res.ip}`);
				req.destroy();
			}
		}

		const contentLength = res.headers['content-length'];
		if (contentLength != null) {
			const size = Number(contentLength);
			if (size > settings.maxSize) {
				console.log(`maxSize exceeded (${size} > ${settings.maxSize}) on response`);
				req.destroy();
			}
		}

		const fromHeader = parseContentDispositionFilename(res.headers['content-disposition'] ?? null);
		if (fromHeader) filename = fromHeader;
	}).on('downloadProgress', (progress: Got.Progress) => {
		if (progress.transferred > settings.maxSize) {
			console.log(`maxSize exceeded (${progress.transferred} > ${settings.maxSize}) on downloadProgress`);
			req.destroy();
		}
	});

	try {
		await pipeline(req, fs.createWriteStream(path));
	} catch (error) {
		if (error instanceof Got.HTTPError) {
			throw new StatusError(
				`${error.response.statusCode} ${error.response.statusMessage}`,
				error.response.statusCode,
				error.response.statusMessage,
			);
		}
		throw error;
	}

	return { filename };
}
