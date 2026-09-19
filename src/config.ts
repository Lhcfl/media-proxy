import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DownloadConfig } from './download.ts';

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
	/** Forward proxy URL (also read from HTTP_PROXY / HTTPS_PROXY). */
	proxy?: string;
	/** Cap on simultaneous image conversions. Defaults to 4. */
	maxConcurrentConversions?: number;
	/** Whole-download timeout in milliseconds. Defaults to 60000. */
	downloadTimeoutMs?: number;
};

export type ResolvedConfig = {
	corsOrigin: string;
	corsHeaders: string;
	csp: string;
	maxConcurrentConversions: number;
	download: DownloadConfig;
};

const DEFAULT_CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'";

export function resolveConfig(input?: Config | null): ResolvedConfig {
	const config = input ?? {};

	const proxy = config.proxy
		?? process.env.HTTP_PROXY ?? process.env.http_proxy
		?? process.env.HTTPS_PROXY ?? process.env.https_proxy;

	return {
		corsOrigin: config['Access-Control-Allow-Origin'] ?? '*',
		corsHeaders: config['Access-Control-Allow-Headers'] ?? '*',
		csp: config['Content-Security-Policy'] ?? DEFAULT_CSP,
		maxConcurrentConversions: config.maxConcurrentConversions ?? 4,
		download: {
			userAgent: config.userAgent ?? 'MisskeyMediaProxy/0.0.0',
			allowedPrivateNetworks: config.allowedPrivateNetworks ?? [],
			maxSize: config.maxSize ?? 262144000,
			proxy: proxy ?? false,
			operationTimeout: config.downloadTimeoutMs ?? 60_000,
		},
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
 * MISSKEY_MEDIA_PROXY_CONFIG) the file must exist; otherwise the first config.*
 * in the working directory is used and a missing file is not an error.
 *
 * Data formats are parsed with Bun's built-in parsers, so a NixOS module can
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
