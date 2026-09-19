// ブラウザで直接表示することを許可するファイルの種類のリスト
// ここに含まれないものは application/octet-stream としてレスポンスされる
// SVGはXSSを生むので許可しない
export const FILE_TYPE_BROWSERSAFE = [
	// Images
	'image/png',
	'image/gif',
	'image/jpeg',
	'image/webp',
	'image/avif',
	'image/apng',
	'image/bmp',
	'image/tiff',
	'image/x-icon',

	// OggS
	'audio/opus',
	'video/ogg',
	'audio/ogg',
	'application/ogg',

	// ISO/IEC base media file format
	'video/quicktime',
	'video/mp4',
	'audio/mp4',
	'video/x-m4v',
	'audio/x-m4a',
	'video/3gpp',
	'video/3gpp2',

	'video/mpeg',
	'audio/mpeg',

	'video/webm',
	'audio/webm',

	'audio/aac',

	'audio/flac',
	'audio/wav',
	// backward compatibility
	'audio/x-flac',
	'audio/vnd.wave',
];

// Types the media proxy is allowed to hand to the image pipeline. Bun.Image
// covers fewer codecs than sharp+libvips did, so a few entries here are
// best-effort: the conversion is attempted and a failure becomes a 404.
export const SHARP_CONVERTIBLE_IMAGE = [
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/apng',
	'image/vnd.mozilla.apng',
	'image/webp',
	'image/avif',
	'image/svg+xml',
	'image/x-icon',
	'image/bmp',
];

// Formats whose animation can be re-encoded (in the original: webp/gif).
// APNG is deliberately absent: it is passed through untouched.
export const SHARP_ANIMATION_CONVERTIBLE_IMAGE = [
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/webp',
	'image/avif',
	'image/svg+xml',
	'image/x-icon',
	'image/bmp',
];
