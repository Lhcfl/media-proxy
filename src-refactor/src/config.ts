import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

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

const DEFAULT_CONFIG_FILES = [
	'config.toml',
	'config.yaml',
	'config.yml',
	'config.json',
	'config.jsonc',
	'config.json5',
	'config.js',
	'config.mjs',
	'config.ts',
];

/**
 * Loads the proxy configuration. With an explicit path (usually
 * MISSKEY_MEDIA_PROXY_CONFIG) the file must exist; otherwise the first
 * config.* in the working directory is used and a missing file is not an
 * error.
 *
 * Data files are parsed with Bun's built-in parsers, so a NixOS module can
 * generate plain TOML/YAML/JSON instead of JavaScript.
 */
export async function loadConfig(explicitPath?: string): Promise<Config | null> {
	if (explicitPath) {
		return parseConfigFile(resolve(process.cwd(), explicitPath));
	}

	for (const candidate of DEFAULT_CONFIG_FILES) {
		const path = resolve(process.cwd(), candidate);
		if (await Bun.file(path).exists()) return parseConfigFile(path);
	}

	return null;
}

async function parseConfigFile(path: string): Promise<Config> {
	const ext = extname(path).toLowerCase();

	if (ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.ts') {
		const module = await import(pathToFileURL(path).href);
		return (module.default ?? module) as Config;
	}

	const text = await Bun.file(path).text();
	switch (ext) {
		case '.toml': return Bun.TOML.parse(text) as Config;
		case '.yaml':
		case '.yml': return Bun.YAML.parse(text) as Config;
		case '.json':
		case '.jsonc': return Bun.JSONC.parse(text) as Config;
		case '.json5': return Bun.JSON5.parse(text) as Config;
		default:
			throw new Error(`Unsupported config file extension: ${ext} (${path})`);
	}
}
