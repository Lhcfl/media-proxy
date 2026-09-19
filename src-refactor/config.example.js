// Copy to config.js next to the working directory, or point
// MISSKEY_MEDIA_PROXY_CONFIG at this file.
export default {
	// User-Agent used for downloads.
	userAgent: 'MisskeyMediaProxy/0.0.0',

	// Private network ranges that may be reached (empty = block all).
	allowedPrivateNetworks: [],

	// Maximum download size in bytes.
	maxSize: 262144000,

	// CORS
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': '*',

	// CSP
	'Content-Security-Policy': `default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'`,

	// Forward proxy (Bun also honours HTTP_PROXY / HTTPS_PROXY / ALL_PROXY).
	// proxy: 'http://127.0.0.1:3128',

	// Bun-specific tuning:
	// Cap on simultaneous image conversions (default 4). Keeps libjpeg/webp
	// spikes from adding up under Misskey's request bursts.
	// maxConcurrentConversions: 4,
	// Whole-download timeout in milliseconds (default 60000).
	// downloadTimeoutMs: 60000,
};
