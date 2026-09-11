import config from './config.js';
import app from './src/index.ts';

export default function (fastify, opts, next) {
    return app(fastify, { ...config, ...opts }, next);
}
