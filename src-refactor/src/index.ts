import type { Config, ResolvedConfig } from './config.ts';
import { resolveConfig } from './config.ts';
import { StatusError } from './status-error.ts';
import { createTemp } from './create-temp.ts';
import { downloadUrl } from './download.ts';
import { detectType } from './file-info.ts';
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
		const passthrough: Prepared = { kind: 'file', path: temp.path, ext: detected.ext, type: detected.mime };

		// Serving the original SVG would reintroduce the XSS the format is
		// excluded for, and there is no librsvg to rasterise it.
		if (detected.mime === 'image/svg+xml') {
			throw new StatusError('SVG conversion is not supported', 415, 'Unsupported Media Type');
		}

		if (wantsImage && !detected.mime.startsWith('image/')) {
			throw new StatusError('Unexpected mime', 404);
		}

		let prepared: Prepared | null = null;

		if (params.has('emoji') || params.has('avatar')) {
			if (detected.animated && !params.has('static')) {
				// Bun.Image only decodes the first frame, so converting would silently
				// drop the animation. Hand the original bytes through instead.
				prepared = passthrough;
			} else {
				const maxHeight = params.has('emoji') ? 128 : 320;
				prepared = await convertOrPassthrough(conversions, passthrough, () => convertToWebpByHeight(temp.path, maxHeight));
			}
		} else if (params.has('static')) {
			prepared = await convertOrPassthrough(conversions, passthrough, () => convertToWebp(temp.path, 498, 422));
		} else if (params.has('preview')) {
			prepared = detected.animated
				? passthrough
				: await convertOrPassthrough(conversions, passthrough, () => convertToWebp(temp.path, 200, 200));
		} else if (params.has('badge')) {
			prepared = await convertOrPassthrough(conversions, passthrough, () => convertToBadge(temp.path));
		} else if (!(detected.mime.startsWith('image/') || FILE_TYPE_BROWSERSAFE.includes(detected.mime))) {
			throw new StatusError('Rejected type', 403, 'Rejected type');
		}

		// No conversion parameter: replay the file as-is.
		prepared ??= passthrough;

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

async function convertOrPassthrough(
	semaphore: Semaphore,
	passthrough: Prepared,
	fn: () => Promise<{ bytes: Uint8Array; ext: string; type: string }>,
): Promise<Prepared> {
	const release = await semaphore.acquire();
	try {
		return { kind: 'buffer', ...(await fn()) };
	} catch (error) {
		// A 404 from image-processor means Bun.Image cannot decode or encode this
		// format. Fall back to the original bytes so TIFF/ICO/AVIF (and any
		// animation) still reach the client instead of failing the request.
		if (error instanceof StatusError && error.statusCode === 404) return passthrough;
		throw error;
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
