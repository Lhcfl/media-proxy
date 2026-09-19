import type { ResolvedConfig } from './config.ts';

/** Minimal async semaphore used to bound concurrent image conversions. */
export class Semaphore {
	private permits: number;
	private readonly waiting: Array<() => void> = [];

	constructor(permits: number) {
		this.permits = Math.max(1, permits);
	}

	async acquire(): Promise<() => void> {
		if (this.permits > 0) {
			this.permits--;
			return this.release;
		}
		await new Promise<void>(resolve => this.waiting.push(resolve));
		return this.release;
	}

	private readonly release = (): void => {
		const next = this.waiting.shift();
		if (next) next();
		else this.permits++;
	};
}

export function baseHeaders(config: ResolvedConfig): Headers {
	return new Headers({
		'Access-Control-Allow-Origin': config.corsOrigin,
		'Access-Control-Allow-Headers': config.corsHeaders,
		'Access-Control-Allow-Methods': 'GET, OPTIONS',
		'Content-Security-Policy': config.csp,
	});
}

/** Builds an RFC 6266 / 5987 Content-Disposition value. */
export function contentDisposition(filename: string): string {
	const fallback = filename.replace(/[^\w.-]/g, '_');
	const encoded = encodeURIComponent(filename).replace(/['()*]/g, c =>
		'%' + c.charCodeAt(0).toString(16).toUpperCase());
	return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function correctFilename(filename: string, ext: string | null): string {
	const dotExt = ext ? `.${ext}` : '.unknown';
	if (filename.endsWith(dotExt)) return filename;
	if (ext === 'jpg' && filename.endsWith('.jpeg')) return filename;
	if (ext === 'tif' && filename.endsWith('.tiff')) return filename;
	return `${filename}${dotExt}`;
}
