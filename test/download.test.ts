import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadUrl, type DownloadConfig } from '../src/download.ts';
import { StatusError } from '../src/status-error.ts';

// The test HTTPS server uses a self-signed certificate.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const workDir = mkdtempSync(join(tmpdir(), 'misskey-media-proxy-test-'));
const certDir = join(workDir, 'certs');
let httpServer: ReturnType<typeof Bun.serve>;
let httpsServer: ReturnType<typeof Bun.serve>;
let proxy: http.Server;

function config(overrides: Partial<DownloadConfig> = {}): DownloadConfig {
	return {
		userAgent: 'media-proxy-test',
		allowedPrivateNetworks: [ '127.0.0.1/32', '::1/128' ],
		maxSize: 1_000_000,
		timeout: 5000,
		operationTimeout: 10_000,
		...overrides,
	};
}

async function downloadToFile(url: string, cfg: DownloadConfig): Promise<{ filename: string; body: string }> {
	const path = join(workDir, crypto.randomUUID());
	const { filename } = await downloadUrl(url, path, cfg);
	return { filename, body: readFileSync(path, 'utf8') };
}

beforeAll(async () => {
	mkdirSync(certDir, { recursive: true });
	execFileSync('openssl', [
		'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
		'-keyout', join(certDir, 'key.pem'),
		'-out', join(certDir, 'cert.pem'),
		'-days', '1',
		'-subj', '/CN=localhost',
		'-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
	]);

	const handler = (req: Request): Response => {
		const path = new URL(req.url).pathname;
		switch (path) {
			case '/hello':
				return new Response('hello world');
			case '/redirect':
				return new Response(null, { status: 302, headers: { location: '/hello' } });
			case '/disposition':
				return new Response('x', { headers: { 'content-disposition': 'attachment; filename="orig name.png"' } });
			case '/error':
				return new Response('nope', { status: 500, statusText: 'Server Error' });
			case '/big':
				return new Response('x'.repeat(100_000));
			case '/stream':
				return new Response(new ReadableStream({
					start(controller) {
						for (let i = 0; i < 100; i++) controller.enqueue(new Uint8Array(1024));
						controller.close();
					},
				}));
			default:
				return new Response('not found', { status: 404 });
		}
	};

	httpServer = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handler });
	httpsServer = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		tls: {
			cert: Bun.file(join(certDir, 'cert.pem')),
			key: Bun.file(join(certDir, 'key.pem')),
		},
		fetch: handler,
	});

	// A minimal forward proxy: absolute-form for HTTP, CONNECT for HTTPS.
	proxy = http.createServer((req, res) => {
		const target = new URL(req.url!);
		const mod = target.protocol === 'https:' ? https : http;
		const upstream = mod.request(target, {
			method: req.method,
			headers: { ...req.headers, host: target.host },
		}, response => {
			res.writeHead(response.statusCode ?? 502, response.headers);
			response.pipe(res);
		});
		upstream.on('error', error => {
			res.writeHead(502);
			res.end(String(error));
		});
		req.pipe(upstream);
	});
	proxy.on('connect', (req, clientSocket, head) => {
		const [host, port] = req.url!.split(':');
		const upstream = net.connect(Number(port), host, () => {
			clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
			upstream.write(head);
			upstream.pipe(clientSocket);
			clientSocket.pipe(upstream);
		});
		upstream.on('error', () => clientSocket.destroy());
	});
	await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
	httpServer?.stop(true);
	httpsServer?.stop(true);
	proxy?.close();
	rmSync(workDir, { recursive: true, force: true });
});

describe('downloadUrl', () => {
	test('downloads a file directly and derives the filename from the URL', async () => {
		const { filename, body } = await downloadToFile(`http://127.0.0.1:${httpServer.port}/hello`, config());
		expect(body).toBe('hello world');
		expect(filename).toBe('hello');
	});

	test('resolves hostnames through Bun.dns', async () => {
		const { body } = await downloadToFile(`http://localhost:${httpServer.port}/hello`, config());
		expect(body).toBe('hello world');
	});

	test('follows redirects and uses the final URL for the filename', async () => {
		const { filename, body } = await downloadToFile(`http://127.0.0.1:${httpServer.port}/redirect`, config());
		expect(body).toBe('hello world');
		expect(filename).toBe('hello');
	});

	test('prefers the upstream Content-Disposition filename', async () => {
		const { filename } = await downloadToFile(`http://127.0.0.1:${httpServer.port}/disposition`, config());
		expect(filename).toBe('orig name.png');
	});

	test('rejects responses larger than maxSize (content-length)', async () => {
		const path = join(workDir, crypto.randomUUID());
		const promise = downloadUrl(`http://127.0.0.1:${httpServer.port}/big`, path, config({ maxSize: 1000 }));
		await expect(promise).rejects.toMatchObject({ statusCode: 413 });
	});

	test('rejects responses larger than maxSize while streaming', async () => {
		const path = join(workDir, crypto.randomUUID());
		const promise = downloadUrl(`http://127.0.0.1:${httpServer.port}/stream`, path, config({ maxSize: 1000 }));
		await expect(promise).rejects.toMatchObject({ statusCode: 413 });
	});

	test('surfaces non-2xx responses as StatusError', async () => {
		const path = join(workDir, crypto.randomUUID());
		const promise = downloadUrl(`http://127.0.0.1:${httpServer.port}/error`, path, config());
		await expect(promise).rejects.toBeInstanceOf(StatusError);
		await expect(promise).rejects.toMatchObject({ statusCode: 500 });
	});

	test('blocks private addresses that are not allow-listed', async () => {
		const path = join(workDir, crypto.randomUUID());
		const promise = downloadUrl(`http://127.0.0.1:${httpServer.port}/hello`, path, config({ allowedPrivateNetworks: [] }));
		await expect(promise).rejects.toMatchObject({ statusCode: 403 });
	});

	test('allows private addresses via allowedPrivateNetworks', async () => {
		const { body } = await downloadToFile(`http://127.0.0.1:${httpServer.port}/hello`, config({ allowedPrivateNetworks: [ '127.0.0.1/32' ] }));
		expect(body).toBe('hello world');
	});

	test('downloads an HTTPS target through a CONNECT proxy', async () => {
		const proxyUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
		const { filename, body } = await downloadToFile(
			`https://127.0.0.1:${httpsServer.port}/hello`,
			config({ proxy: proxyUrl }),
		);
		expect(body).toBe('hello world');
		expect(filename).toBe('hello');
	});

	test('downloads an HTTP target through an absolute-form proxy', async () => {
		const proxyUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
		const { body } = await downloadToFile(
			`http://127.0.0.1:${httpServer.port}/hello`,
			config({ proxy: proxyUrl }),
		);
		expect(body).toBe('hello world');
	});
});
