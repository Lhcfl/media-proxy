import * as http from 'node:http';
import * as https from 'node:https';
import * as tls from 'node:tls';
import * as zlib from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { Socket } from 'node:net';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { StatusError } from './status-error.ts';
import { parseContentDispositionFilename } from './web.ts';

export type DownloadConfig = {
	userAgent: string;
	allowedPrivateNetworks: string[];
	maxSize: number;
	/** Forward proxy URL (usually from HTTP_PROXY / HTTPS_PROXY). */
	proxy?: string | false;
	/** Idle/socket timeout in milliseconds. */
	timeout?: number;
	/** Whole-operation timeout in milliseconds. */
	operationTimeout?: number;
};

export const defaultDownloadConfig: DownloadConfig = {
	userAgent: 'MisskeyMediaProxy/0.0.0',
	allowedPrivateNetworks: [],
	maxSize: 262144000,
	proxy: false,
	timeout: 30_000,
	operationTimeout: 60_000,
};

// ---------------------------------------------------------------------------
// DNS. Bun.dns.lookup has no cache that node:http's agent lookup hook can use,
// and the agent calls it per new connection; that is fine, the OS/c-ares layer
// resolves cheaply. This just adapts Bun's Promise API to the callback
// signature node:http expects.
// ---------------------------------------------------------------------------

type LookupAddress = { address: string; family: number };
type LookupOptions = { family?: number | 'IPv4' | 'IPv6' | 0; all?: boolean };
type LookupCallback = (error: Error | null, address?: any, family?: number) => void;

async function resolveHost(hostname: string): Promise<LookupAddress[]> {
	const rows = await Bun.dns.lookup(hostname);
	if (!rows || rows.length === 0) throw new Error(`No address found for ${hostname}`);
	return rows.map(row => ({ address: row.address, family: row.family }));
}

function lookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
	resolveHost(hostname).then(
		addresses => {
			let list = addresses;
			const family = options?.family;
			if (family === 4 || family === 'IPv4') list = addresses.filter(a => a.family === 4);
			else if (family === 6 || family === 'IPv6') list = addresses.filter(a => a.family === 6);
			if (list.length === 0) list = addresses;

			if (options?.all) callback(null, list);
			else callback(null, list[0].address, list[0].family);
		},
		error => callback(error as Error),
	);
}

const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 30 * 1000, lookup: lookup as any });
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30 * 1000, lookup: lookup as any });

// ---------------------------------------------------------------------------
// SSRF
// ---------------------------------------------------------------------------

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

function hostWithoutBrackets(hostname: string): string {
	if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname.slice(1, -1);
	return hostname;
}

/**
 * Used when a forward proxy is configured: the connection goes to the proxy,
 * so the target name has to be resolved and checked locally first. This leaves
 * a small DNS-rebinding window; the direct path checks the connected socket.
 */
async function assertPublicHost(hostname: string, allowedPrivateNetworks: string[]): Promise<void> {
	const host = hostWithoutBrackets(hostname);

	const check = (ip: string) => {
		if (isBlockedAddress(ip, allowedPrivateNetworks)) {
			throw new StatusError(`Blocked address: ${ip}`, 403, 'Blocked address');
		}
	};

	if (isIP(host)) {
		check(host);
		return;
	}

	let addresses: LookupAddress[];
	try {
		addresses = await resolveHost(host);
	} catch {
		// Let the actual request surface the resolution error.
		return;
	}
	for (const { address } of addresses) check(address);
}

// ---------------------------------------------------------------------------
// Forward proxy
// ---------------------------------------------------------------------------

type ProxyConfig = { host: string; port: number; auth?: string };

function parseProxy(raw: string): ProxyConfig {
	const url = new URL(raw);
	if (url.protocol !== 'http:') {
		throw new StatusError(`Unsupported proxy protocol: ${url.protocol}`, 500, 'Unsupported proxy');
	}
	let auth: string | undefined;
	if (url.username || url.password) {
		const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
		auth = 'Basic ' + Buffer.from(credentials).toString('base64');
	}
	return { host: url.hostname, port: Number(url.port || 80), auth };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

type HttpResult = {
	statusCode: number;
	statusMessage: string;
	headers: http.IncomingHttpHeaders;
	stream: http.IncomingMessage;
	socket: Socket | undefined;
	request: http.ClientRequest;
};

function defaultHeaders(config: DownloadConfig): http.OutgoingHttpHeaders {
	return {
		'User-Agent': config.userAgent,
		'Accept': '*/*',
		'Accept-Encoding': 'identity',
	};
}

function requestOptions(config: DownloadConfig, extra: http.RequestOptions = {}): http.RequestOptions {
	return {
		method: 'GET',
		headers: defaultHeaders(config),
		...extra,
	};
}

function attachTimeouts(req: http.ClientRequest, config: DownloadConfig): void {
	req.setTimeout(config.timeout ?? 30_000, () => {
		req.destroy(new StatusError('Download timed out', 504, 'Gateway Timeout'));
	});
	req.on('error', () => {});
}

function requestDirect(target: URL, config: DownloadConfig): Promise<HttpResult> {
	return new Promise((resolve, reject) => {
		const isHttps = target.protocol === 'https:';
		const mod = isHttps ? https : http;
		const req = mod.request(target, requestOptions(config, isHttps ? { agent: httpsAgent } : { agent: httpAgent }), res => {
			resolve({
				statusCode: res.statusCode ?? 0,
				statusMessage: res.statusMessage ?? '',
				headers: res.headers,
				stream: res,
				socket: res.socket ?? undefined,
				request: req,
			});
		});
		attachTimeouts(req, config);
		req.on('error', reject);
		req.end();
	});
}

/** Plain HTTP target through a proxy: absolute-form request line. */
function requestViaProxyHttp(target: URL, proxy: ProxyConfig, config: DownloadConfig): Promise<HttpResult> {
	return new Promise((resolve, reject) => {
		const headers: http.OutgoingHttpHeaders = {
			...defaultHeaders(config),
			Host: target.host,
		};
		if (proxy.auth) headers['Proxy-Authorization'] = proxy.auth;

		const req = http.request({
			host: proxy.host,
			port: proxy.port,
			path: target.href,
			method: 'GET',
			headers,
		}, res => {
			resolve({
				statusCode: res.statusCode ?? 0,
				statusMessage: res.statusMessage ?? '',
				headers: res.headers,
				stream: res,
				socket: res.socket ?? undefined,
				request: req,
			});
		});
		attachTimeouts(req, config);
		req.on('error', reject);
		req.end();
	});
}

function connectTunnel(target: URL, proxy: ProxyConfig, config: DownloadConfig): Promise<tls.TLSSocket> {
	return new Promise((resolve, reject) => {
		const authority = `${target.hostname}:${target.port || 443}`;
		const headers: http.OutgoingHttpHeaders = { Host: authority };
		if (proxy.auth) headers['Proxy-Authorization'] = proxy.auth;

		const req = http.request({
			host: proxy.host,
			port: proxy.port,
			method: 'CONNECT',
			path: authority,
			headers,
		});
		req.setTimeout(config.timeout ?? 30_000, () => {
			req.destroy(new StatusError('Proxy connect timed out', 504, 'Gateway Timeout'));
		});
		req.on('connect', (res, socket) => {
			if (res.statusCode !== 200) {
				socket.destroy();
				reject(new StatusError(`Proxy CONNECT failed: ${res.statusCode}`, 502, 'Proxy Error'));
				return;
			}
			const host = hostWithoutBrackets(target.hostname);
			const tlsSocket = tls.connect(
				isIP(host) ? { socket } : { socket, servername: host },
				() => resolve(tlsSocket),
			);
			tlsSocket.on('error', reject);
		});
		req.on('error', reject);
		req.end();
	});
}

/** HTTPS target through a proxy: CONNECT tunnel, then TLS over it. */
async function requestViaProxyHttps(target: URL, proxy: ProxyConfig, config: DownloadConfig): Promise<HttpResult> {
	const socket = await connectTunnel(target, proxy, config);
	return new Promise((resolve, reject) => {
		const req = https.request({
			host: target.hostname,
			port: target.port || 443,
			path: `${target.pathname}${target.search}`,
			method: 'GET',
			agent: false,
			createConnection: () => socket,
			headers: requestOptions(config).headers,
		}, res => {
			resolve({
				statusCode: res.statusCode ?? 0,
				statusMessage: res.statusMessage ?? '',
				headers: res.headers,
				stream: res,
				socket: res.socket ?? undefined,
				request: req,
			});
		});
		attachTimeouts(req, config);
		req.on('error', reject);
		req.end();
	});
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

async function streamToFile(
	stream: NodeJS.ReadableStream,
	path: string,
	maxSize: number,
	contentEncoding: string | undefined,
): Promise<void> {
	let total = 0;
	const limiter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			total += chunk.length;
			if (total > maxSize) {
				callback(new StatusError('maxSize exceeded', 413, 'Payload Too Large'));
				return;
			}
			callback(null, chunk);
		},
	});

	const stages: Array<NodeJS.ReadableStream | NodeJS.WritableStream> = [stream];
	switch ((contentEncoding ?? 'identity').toLowerCase()) {
		case 'gzip':
			stages.push(zlib.createGunzip());
			break;
		case 'deflate':
			stages.push(zlib.createInflate());
			break;
		case 'br':
			stages.push(zlib.createBrotliDecompress());
			break;
		default:
			break;
	}
	stages.push(limiter, createWriteStream(path));

	await (pipeline as (...streams: any[]) => Promise<void>)(...stages);
}

export async function downloadUrl(url: string, path: string, settings: DownloadConfig = defaultDownloadConfig): Promise<{ filename: string }> {
	const proxy = settings.proxy ? parseProxy(settings.proxy) : null;
	const operationTimeout = settings.operationTimeout ?? 60_000;

	let current = new URL(url);
	let activeRequest: http.ClientRequest | null = null;
	const overallTimer = setTimeout(() => {
		activeRequest?.destroy(new StatusError('Download timed out', 504, 'Gateway Timeout'));
	}, operationTimeout);

	try {
		for (let redirect = 0; ; redirect++) {
			if (redirect > 10) throw new StatusError('Too many redirects', 508, 'Loop Detected');

			if (proxy) await assertPublicHost(current.hostname, settings.allowedPrivateNetworks);

			const result = proxy
				? (current.protocol === 'https:'
					? await requestViaProxyHttps(current, proxy, settings)
					: await requestViaProxyHttp(current, proxy, settings))
				: await requestDirect(current, settings);
			activeRequest = result.request;

			const remoteIp = result.socket?.remoteAddress;
			if (!proxy && remoteIp && isBlockedAddress(remoteIp, settings.allowedPrivateNetworks)) {
				result.stream.destroy();
				throw new StatusError(`Blocked address: ${remoteIp}`, 403, 'Blocked address');
			}

			const status = result.statusCode;

			if (status >= 300 && status < 400 && result.headers.location) {
				result.stream.resume();
				current = new URL(result.headers.location, current);
				continue;
			}

			if (status >= 400) {
				result.stream.resume();
				throw new StatusError(`${status} ${result.statusMessage}`, status, result.statusMessage);
			}

			const contentLength = result.headers['content-length'];
			if (contentLength != null && Number(contentLength) > settings.maxSize) {
				result.stream.destroy();
				throw new StatusError('maxSize exceeded', 413, 'Payload Too Large');
			}

			const fromHeader = parseContentDispositionFilename(result.headers['content-disposition'] ?? null);
			const filename = fromHeader ?? (current.pathname.split('/').pop() || 'unknown');

			await streamToFile(result.stream, path, settings.maxSize, result.headers['content-encoding']);
			return { filename };
		}
	} finally {
		clearTimeout(overallTimer);
	}
}
