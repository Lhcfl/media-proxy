import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import app from './built/index.js';

// Match the upstream behaviour of reading config.js from the current working
// directory, but allow overriding the location (used by the NixOS module).
const configPath = process.env.MISSKEY_MEDIA_PROXY_CONFIG ?? './config.js';
const { default: config } = await import(pathToFileURL(resolve(process.cwd(), configPath)).href);

const port = Number(process.env.PORT ?? 3000);
// The proxy is meant to run behind a reverse proxy and must not be exposed
// directly, so it always binds to loopback.
const host = '127.0.0.1';

const fastify = Fastify({
    logger: process.env.NODE_ENV !== 'test',
});

try {
    await fastify.register(app, config);
    await fastify.listen({ port, host });
} catch (err) {
    fastify.log.error(err);
    process.exit(1);
}
