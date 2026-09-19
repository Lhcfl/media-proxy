export type Config = {
	/** User-Agent used for downloads. */
	userAgent?: string;
	/** CIDR blocks that may be reached even though they are private. */
	allowedPrivateNetworks?: string[];
	/** Maximum download size in bytes. */
	maxSize?: number;
	'Access-Control-Allow-Origin'?: string;
	'Access-Control-Allow-Headers'?: string;
	'Content-Security-Policy'?: string;
	/** Forward proxy URL (Bun also honours HTTP_PROXY / HTTPS_PROXY / ALL_PROXY). */
	proxy?: string;
	/** Cap on simultaneous image conversions. Defaults to 4. */
	maxConcurrentConversions?: number;
	/** Whole-download timeout in milliseconds. Defaults to 60000. */
	downloadTimeoutMs?: number;
};

const DEFAULT_CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'";

export type ResolvedConfig = {
	userAgent: string;
	allowedPrivateNetworks: string[];
	maxSize: number;
	corsOrigin: string;
	corsHeaders: string;
	csp: string;
	proxy: string | undefined;
	maxConcurrentConversions: number;
	downloadTimeoutMs: number;
};

export function resolveConfig(input: Config | null | undefined): ResolvedConfig {
	const config = input ?? {};
	const envProxy = process.env.HTTP_PROXY ?? process.env.http_proxy
		?? process.env.HTTPS_PROXY ?? process.env.https_proxy
		?? process.env.ALL_PROXY ?? process.env.all_proxy;

	return {
		userAgent: config.userAgent ?? 'MisskeyMediaProxy/0.0.0',
		allowedPrivateNetworks: config.allowedPrivateNetworks ?? [],
		maxSize: config.maxSize ?? 262144000,
		corsOrigin: config['Access-Control-Allow-Origin'] ?? '*',
		corsHeaders: config['Access-Control-Allow-Headers'] ?? '*',
		csp: config['Content-Security-Policy'] ?? DEFAULT_CSP,
		proxy: config.proxy ?? envProxy,
		maxConcurrentConversions: config.maxConcurrentConversions ?? 4,
		downloadTimeoutMs: config.downloadTimeoutMs ?? 60_000,
	};
}
