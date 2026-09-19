import { FILE_TYPE_BROWSERSAFE } from './const.ts';

export type DetectedType = {
	mime: string;
	ext: string | null;
	/** True when the file is an animated container (APNG / animated WebP / GIF). */
	animated: boolean;
};

const OCTET_STREAM: DetectedType = { mime: 'application/octet-stream', ext: null, animated: false };
const SVG: DetectedType = { mime: 'image/svg+xml', ext: 'svg', animated: false };

const HEAD_BYTES = 64 * 1024;

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
	if (bytes.length < offset + signature.length) return false;
	return signature.every((byte, i) => bytes[offset + i] === byte);
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
	if (bytes.length < offset + text.length) return false;
	for (let i = 0; i < text.length; i++) {
		if (bytes[offset + i] !== text.charCodeAt(i)) return false;
	}
	return true;
}

function containsAscii(bytes: Uint8Array, text: string, limit = 1024): boolean {
	const end = Math.min(bytes.length, limit);
	const first = text.charCodeAt(0);
	outer: for (let i = 0; i + text.length <= end; i++) {
		if (bytes[i] !== first) continue;
		for (let j = 1; j < text.length; j++) {
			if (bytes[i + j] !== text.charCodeAt(j)) continue outer;
		}
		return true;
	}
	return false;
}

function sniffFtyp(bytes: Uint8Array): DetectedType | null {
	if (!asciiAt(bytes, 4, 'ftyp')) return null;
	const brand = String.fromCharCode(...bytes.subarray(8, 12));
	switch (brand) {
		case 'qt  ': return { mime: 'video/quicktime', ext: 'mov', animated: false };
		case 'M4A ': return { mime: 'audio/mp4', ext: 'm4a', animated: false };
		case 'M4V ': return { mime: 'video/x-m4v', ext: 'm4v', animated: false };
		case '3gp4':
		case '3gp5': return { mime: 'video/3gpp', ext: '3gp', animated: false };
		case '3g2a': return { mime: 'video/3gpp2', ext: '3g2', animated: false };
		case 'avif':
		case 'avis': return { mime: 'image/avif', ext: 'avif', animated: brand === 'avis' };
		default: return { mime: 'video/mp4', ext: 'mp4', animated: false };
	}
}

function gifIsAnimated(bytes: Uint8Array): boolean {
	// Nearly every encoder emits the Netscape looping extension early on.
	if (containsAscii(bytes, 'NETSCAPE2.0', bytes.length)) return true;

	// Otherwise walk the block structure and look for a second frame. The walk
	// simply gives up if the head buffer ends before the trailer.
	if (bytes.length < 13) return false;
	let p = 13;
	const packed = bytes[10];
	if (packed & 0x80) p += 3 * (1 << ((packed & 7) + 1));

	let frames = 0;
	while (p < bytes.length) {
		const block = bytes[p++];
		if (block === 0x3b) break;
		if (block === 0x21) {
			p++; // extension label
			p = skipGifSubBlocks(bytes, p);
			if (p < 0) return false;
		} else if (block === 0x2c) {
			frames++;
			if (frames > 1) return true;
			if (p + 9 > bytes.length) return false;
			const imagePacked = bytes[p + 8];
			p += 9;
			if (imagePacked & 0x80) p += 3 * (1 << ((imagePacked & 7) + 1));
			p++; // LZW minimum code size
			p = skipGifSubBlocks(bytes, p);
			if (p < 0) return false;
		} else {
			return false;
		}
	}
	return false;
}

/** Returns the offset just past a GIF sub-block chain, or -1 on truncation. */
function skipGifSubBlocks(bytes: Uint8Array, start: number): number {
	let p = start;
	while (p < bytes.length) {
		const size = bytes[p++];
		if (size === 0) return p;
		p += size;
		if (p > bytes.length) return -1;
	}
	return -1;
}

function sniff(bytes: Uint8Array): DetectedType | null {
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
		const apng = containsAscii(bytes, 'acTL');
		return { mime: apng ? 'image/apng' : 'image/png', ext: 'png', animated: apng };
	}
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', ext: 'jpg', animated: false };
	// Bun.Image only decodes the first frame, so "mutating" a GIF would silently
	// drop the animation. Detect it instead and pass the original through.
	if (asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a')) {
		return { mime: 'image/gif', ext: 'gif', animated: gifIsAnimated(bytes) };
	}
	if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) {
		const animated = containsAscii(bytes, 'ANIM');
		return { mime: 'image/webp', ext: 'webp', animated };
	}
	if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WAVE')) return { mime: 'audio/wav', ext: 'wav', animated: false };
	if (startsWith(bytes, [0x42, 0x4d])) return { mime: 'image/bmp', ext: 'bmp', animated: false };
	if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
		return { mime: 'image/tiff', ext: 'tiff', animated: false };
	}
	if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return { mime: 'image/x-icon', ext: 'ico', animated: false };
	if (asciiAt(bytes, 0, 'fLaC')) return { mime: 'audio/flac', ext: 'flac', animated: false };
	if (asciiAt(bytes, 0, 'OggS')) return { mime: 'audio/ogg', ext: 'ogg', animated: false };
	if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return { mime: 'video/webm', ext: 'webm', animated: false };
	if (startsWith(bytes, [0x00, 0x00, 0x01, 0xba]) || startsWith(bytes, [0x00, 0x00, 0x01, 0xb3])) {
		return { mime: 'video/mpeg', ext: 'mpeg', animated: false };
	}
	if (asciiAt(bytes, 0, 'ID3')) return { mime: 'audio/mpeg', ext: 'mp3', animated: false };
	if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
		// 0xFFF? with layer bits 00 is AAC ADTS, otherwise MPEG audio.
		const layer = (bytes[1] >> 1) & 0x03;
		if (layer === 0) return { mime: 'audio/aac', ext: 'aac', animated: false };
		return { mime: 'audio/mpeg', ext: 'mp3', animated: false };
	}
	return sniffFtyp(bytes);
}

async function looksLikeSvg(bytes: Uint8Array): Promise<boolean> {
	if (bytes.length > 1024 * 1024) return false;
	const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
	const trimmed = text.replace(/^\uFEFF/, '').trimStart();
	if (!trimmed.startsWith('<')) return false;
	return /<svg[\s>]/i.test(trimmed);
}

export async function detectType(path: string): Promise<DetectedType> {
	const file = Bun.file(path);
	if (file.size === 0) return OCTET_STREAM;

	const head = new Uint8Array(await file.slice(0, Math.min(file.size, HEAD_BYTES)).arrayBuffer());

	// SVG is text, so it never matches a magic signature.
	if (await looksLikeSvg(head)) return SVG;

	const type = sniff(head);
	if (!type) return OCTET_STREAM;
	if (!isMimeImage(type.mime, 'safe-file')) return OCTET_STREAM;

	return { ...type, mime: fixMime(type.mime) };
}

const dictionary = {
	'safe-file': FILE_TYPE_BROWSERSAFE,
	'sharp-convertible-image': [
		'image/jpeg', 'image/png', 'image/gif', 'image/apng', 'image/vnd.mozilla.apng',
		'image/webp', 'image/avif', 'image/svg+xml', 'image/x-icon', 'image/bmp',
	],
	'sharp-animation-convertible-image': [
		'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
		'image/svg+xml', 'image/x-icon', 'image/bmp',
	],
};

export const isMimeImage = (mime: string, type: keyof typeof dictionary): boolean => dictionary[type].includes(mime);

function fixMime(mime: string): string {
	if (mime === 'audio/x-flac') return 'audio/flac';
	if (mime === 'audio/vnd.wave') return 'audio/wav';
	return mime;
}
