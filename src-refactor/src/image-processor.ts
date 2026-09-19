import { StatusError } from './status-error.ts';

export type PreparedImage = {
	bytes: Uint8Array;
	ext: string;
	type: string;
};

// Bun.Image's webp options are a subset of sharp's. quality: 77 matches the
// original webpDefault.
const WEBP = { quality: 77 } as const;

function asImageError(error: unknown): StatusError {
	const code = (error as { code?: string } | null)?.code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === 'ERR_IMAGE_FORMAT_UNSUPPORTED' || code === 'ERR_IMAGE_DECODE_FAILED' || code === 'ERR_IMAGE_UNKNOWN_FORMAT') {
		return new StatusError(message, 404, 'Unsupported image');
	}
	return new StatusError(message, 500, 'Image conversion failed');
}

async function toWebp(path: string, width: number, height: number, withoutEnlargement: boolean): Promise<PreparedImage> {
	try {
		const bytes = await new Bun.Image(path)
			.resize(width, height, { fit: 'inside', withoutEnlargement })
			.webp(WEBP)
			.bytes();
		return { bytes, ext: 'webp', type: 'image/webp' };
	} catch (error) {
		throw asImageError(error);
	}
}

/** Fits the image within `width`×`height`, preserving aspect ratio. */
export function convertToWebp(path: string, width: number, height: number): Promise<PreparedImage> {
	return toWebp(path, width, height, true);
}

/** emoji / avatar: limit height only, never upscale. */
export async function convertToWebpByHeight(path: string, maxHeight: number): Promise<PreparedImage> {
	let meta: { width: number; height: number };
	try {
		meta = await new Bun.Image(path).metadata();
	} catch (error) {
		throw asImageError(error);
	}
	const scale = Math.min(1, maxHeight / meta.height);
	const width = Math.max(1, Math.round(meta.width * scale));
	const height = Math.max(1, Math.round(meta.height * scale));
	return toWebp(path, width, height, false);
}

/**
 * Web Push badge. `sharp`'s normalise/flatten/boolean/entropy pipeline has no
 * Bun.Image equivalent, so this is a plain 96×96 greyscale PNG (kept opaque
 * instead of an alpha mask).
 */
export async function convertToBadge(path: string): Promise<PreparedImage> {
	try {
		const bytes = await new Bun.Image(path)
			.resize(96, 96, { fit: 'inside', withoutEnlargement: false })
			.modulate({ saturation: 0 })
			.png()
			.bytes();
		return { bytes, ext: 'png', type: 'image/png' };
	} catch (error) {
		throw asImageError(error);
	}
}
