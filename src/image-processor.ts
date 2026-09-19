import sharp, { type Sharp, type WebpOptions } from "sharp";

export type IImage = {
	data: Buffer;
	ext: string;
	type: string;
};

// Matches the upstream encoder tuning: sharper and smaller than plain quality.
export const webpDefault: WebpOptions = {
	quality: 77,
	alphaQuality: 95,
	lossless: false,
	nearLossless: false,
	smartSubsample: true,
	mixed: true,
	effort: 2,
};

/** Encodes a sharp pipeline that already selected webp as the output. */
export async function finalize(image: Sharp): Promise<IImage> {
	return {
		data: await image.toBuffer(),
		ext: "webp",
		type: "image/webp",
	};
}

/** Fits the input inside `width`×`height` (aspect preserved, no upscaling). */
export async function convertToWebp(
	path: string,
	width: number,
	height: number,
	options: WebpOptions = webpDefault,
): Promise<IImage> {
	return finalize(
		sharp(path)
			.resize(width, height, { fit: "inside", withoutEnlargement: true })
			.rotate()
			.webp(options),
	);
}

/** Same as convertToWebp but for an already-constructed sharp pipeline. */
export async function convertSharpToWebp(
	image: Sharp,
	width: number,
	height: number,
	options: WebpOptions = webpDefault,
): Promise<IImage> {
	return finalize(
		image
			.resize(width, height, { fit: "inside", withoutEnlargement: true })
			.rotate()
			.webp(options),
	);
}
