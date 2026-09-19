import type { Config, ResolvedConfig } from './config.ts';
import { resolveConfig } from './config.ts';
import { StatusError } from './status-error.ts';
import { createTemp } from './create-temp.ts';
import { downloadUrl } from './download.ts';
import { detectType, isMimeImage } from './file-info.ts';
import { baseHeaders, contentDisposition, correctFilename, Semaphore } from './http.ts';
import { convertToBadge, convertToWebp, convertToWebpByHeight } from './image-processor.ts';
import { FILE_TYPE_BROWSERSAFE } from './const.ts';

const DUMMY_IMAGE = new URL('../../assets/dummy.png', import.meta.url);

type Prepared =
	| { kind: 'buffer'; bytes: Uint8Array; ext: string; type: string }
	| { kind: 'file'; path: string; ext: string | null; type: string };

export function createHandler(config: Config | null | undefined): (request: Request) => Promise<Response> {
	const resolved = resolveConfig(config);
	const conversions = new Semaphore(resolved.maxConcurrentConversions);
	return (request: Request) => handleRequest(request, resolved, conversions);
}

async function handleRequest(request: Request, config: ResolvedConfig, conversions: Semaphore): Promise<Response> {
	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: baseHeaders(config) });
	}
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return new Response(null, { status: 405, headers: baseHeaders(config) });
	}

	const url = new URL(request.url);
	try {
		return await proxyHandler(request, url, config, conversions);
	} catch (error) {
		return errorHandler(url, config, error);
	}
}

function resolveTarget(url: URL): string | null {
	const queryUrl = url.searchParams.get('url');
	if (queryUrl) return queryUrl;
	if (url.pathname && url.pathname !== '/' && url.pathname !== '/proxy') {
		return 'https://' + url.pathname.slice(1);
	}
	return null;
}

async function proxyHandler(request: Request, url: URL, config: ResolvedConfig, conversions: Semaphore): Promise<Response> {
	const params = url.searchParams;
	const target = resolveTarget(url);
	if (!target) {
		return new Response(null, { status: 400, headers: baseHeaders(config) });
	}

	const wantsImage = params.has('emoji') || params.has('avatar') || params.has('static')
		|| params.has('preview') || params.has('badge');

	const temp = await createTemp();
	try {
		const { filename } = await downloadUrl(target, temp.path, config);
		const detected = await detectType(temp.path);

		if (wantsImage && !isMimeImage(detected.mime, 'sharp-convertible-image')) {
			throw new StatusError('Unexpected mime', 404);
		}

		let prepared: Prepared | null = null;

		if (params.has('emoji') || params.has('avatar')) {
			if (detected.animated && !params.has('static')) {
				// APNG / animated WebP cannot be re-encoded by Bun.Image, so hand
				// the original bytes through instead of dropping the animation.
				prepared = { kind: 'file', path: temp.path, ext: detected.ext, type: detected.mime };
			} else {
				const maxHeight = params.has('emoji') ? 128 : 320;
				prepared = { kind: 'buffer', ...(await convert(conversions, () => convertToWebpByHeight(temp.path, maxHeight))) };
			}
		} else if (params.has('static')) {
			prepared = { kind: 'buffer', ...(await convert(conversions, () => convertToWebp(temp.path, 498, 422))) };
		} else if (params.has('preview')) {
			prepared = { kind: 'buffer', ...(await convert(conversions, () => convertToWebp(temp.path, 200, 200))) };
		} else if (params.has('badge')) {
			prepared = { kind: 'buffer', ...(await convert(conversions, () => convertToBadge(temp.path))) };
		} else if (detected.mime === 'image/svg+xml') {
			// The original rasterised SVG with librsvg; Bun.Image cannot decode it.
			// Refuse rather than serve active SVG content.
			throw new StatusError('SVG conversion is not supported', 415, 'Unsupported Media Type');
		} else if (!(detected.mime.startsWith('image/') || FILE_TYPE_BROWSERSAFE.includes(detected.mime))) {
			throw new StatusError('Rejected type', 403, 'Rejected type');
		}

		// No conversion parameter (or an animated passthrough): replay the file as-is.
		prepared ??= { kind: 'file', path: temp.path, ext: detected.ext, type: detected.mime };

		const headers = baseHeaders(config);
		headers.set('Content-Type', prepared.type);
		headers.set('Cache-Control', 'max-age=31536000, immutable');
		headers.set('Content-Disposition', contentDisposition(correctFilename(filename, prepared.ext)));

		if (prepared.kind === 'buffer') {
			await temp.cleanup();
			return new Response(prepared.bytes, { headers });
		}

		return fileResponse(request, prepared.path, temp.cleanup, headers);
	} catch (error) {
		await temp.cleanup();
		throw error;
	}
}

async function convert<T>(semaphore: Semaphore, fn: () => Promise<T>): Promise<T> {
	const release = await semaphore.acquire();
	try {
		return await fn();
	} finally {
		release();
	}
}

function fileResponse(request: Request, path: string, cleanup: () => Promise<void>, headers: Headers): Response {
	let finished = false;
	const finish = () => {
		if (finished) return;
		finished = true;
		void cleanup();
	};
	request.signal.addEventListener('abort', finish, { once: true });

	const reader = Bun.file(path).stream().getReader();
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					finish();
					controller.close();
					return;
				}
				controller.enqueue(value);
			} catch (error) {
				finish();
				controller.error(error);
			}
		},
		async cancel() {
			finish();
			await reader.cancel().catch(() => {});
		},
	});

	return new Response(body, { headers });
}

function errorHandler(url: URL, config: ResolvedConfig, error: unknown): Response {
	console.log(error instanceof Error ? error.stack ?? error.message : String(error));

	const headers = baseHeaders(config);
	headers.set('Cache-Control', 'max-age=300');

	if (url.searchParams.has('fallback')) {
		return new Response(Bun.file(DUMMY_IMAGE), { headers, status: 200 });
	}

	if (error instanceof StatusError && error.isClientError) {
		return new Response(null, { status: error.statusCode, headers });
	}

	return new Response(null, { status: 500, headers });
}
