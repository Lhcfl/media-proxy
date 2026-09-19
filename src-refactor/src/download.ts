import { StatusError } from './status-error.ts';
import { assertHostAllowed } from './net.ts';
import type { ResolvedConfig } from './config.ts';

export type DownloadResult = {
	filename: string;
	finalUrl: string;
};

function parseContentDispositionFilename(header: string | null): string | null {
	if (!header) return null;
	// RFC 5987 form wins over the plain filename parameter.
	const extended = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
	if (extended) {
		try {
			return decodeURIComponent(extended[1].trim());
		} catch {
			// fall through to the plain form
		}
	}
	const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(header);
	const value = plain?.[1] ?? plain?.[2];
	return value ? value.trim() : null;
}

/**
 * Streams `url` into `path`, enforcing the size cap while downloading. Uses
 * Bun's fetch, so HTTP_PROXY/HTTPS_PROXY/ALL_PROXY and `config.proxy` are
 * honoured without hpagent.
 */
export async function downloadUrl(url: string, path: string, config: ResolvedConfig): Promise<DownloadResult> {
	const urlObj = new URL(url);
	let filename = urlObj.pathname.split('/').pop() || 'unknown';

	// Unlike the original we can check the target host even when a forward proxy
	// is configured, because the name is resolved locally rather than taken from
	// the connected socket. A name that only the proxy can resolve is left to
	// fetch (lookup failure -> no local verdict).
	await assertHostAllowed(urlObj.hostname, config.allowedPrivateNetworks);

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error('download timed out')), config.downloadTimeoutMs);

	let response: Response;
	try {
		response = await fetch(url, {
			headers: { 'User-Agent': config.userAgent },
			redirect: 'follow',
			signal: controller.signal,
			...(config.proxy ? { proxy: config.proxy } as object : {}),
		});
	} catch (error) {
		clearTimeout(timer);
		throw error;
	}

	if (!response.ok) {
		clearTimeout(timer);
		throw new StatusError(
			`${response.status} ${response.statusText}`,
			response.status,
			response.statusText,
		);
	}

	const fromHeader = parseContentDispositionFilename(response.headers.get('content-disposition'));
	if (fromHeader) filename = fromHeader;

	const contentLength = response.headers.get('content-length');
	if (contentLength !== null && Number(contentLength) > config.maxSize) {
		clearTimeout(timer);
		await response.body?.cancel().catch(() => {});
		throw new StatusError('maxSize exceeded on content-length', 413, 'Payload Too Large');
	}

	const writer = Bun.file(path).writer();
	let total = 0;
	try {
		if (!response.body) throw new StatusError('Empty response body', 502, 'Bad Gateway');
		const reader = response.body.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > config.maxSize) {
				await reader.cancel().catch(() => {});
				throw new StatusError('maxSize exceeded', 413, 'Payload Too Large');
			}
			writer.write(value);
		}
		await writer.end();
	} catch (error) {
		await writer.end().catch(() => {});
		throw error;
	} finally {
		clearTimeout(timer);
	}

	return { filename, finalUrl: response.url || url };
}
