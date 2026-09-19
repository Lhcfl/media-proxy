import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHandler } from './src/index.ts';
import type { Config } from './src/config.ts';

// Same convention as the original server: read config.js from the working
// directory, overridable through MISSKEY_MEDIA_PROXY_CONFIG.
const configPath = process.env.MISSKEY_MEDIA_PROXY_CONFIG ?? './config.js';

let config: Config | null = null;
try {
	const module = await import(pathToFileURL(resolve(process.cwd(), configPath)).href);
	config = (module.default ?? null) as Config | null;
} catch (error) {
	console.error(`Failed to load config from ${configPath}:`, error);
	process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);
// Like the original, the proxy is meant to sit behind a reverse proxy and only
// listens on loopback.
const hostname = '127.0.0.1';

const server = Bun.serve({
	port,
	hostname,
	fetch: createHandler(config),
});

console.log(`Misskey media proxy (Bun) listening on ${server.url}`);
