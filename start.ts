import { type Config, loadConfig } from "./src/config.ts";
import { createHandler } from "./src/index.ts";

// MISSKEY_MEDIA_PROXY_CONFIG may point at a .toml / .yaml / .json / .js file.
// Without it the first config.* in the working directory is used.
const configPath = process.env.MISSKEY_MEDIA_PROXY_CONFIG;

let config: Config | null;
try {
	config = await loadConfig(configPath);
} catch (error) {
	console.error(
		`Failed to load config${configPath ? ` from ${configPath}` : ""}:`,
		error,
	);
	process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);
// The proxy is meant to run behind a reverse proxy and must not be exposed
// directly, so it always binds to loopback.
const hostname = "127.0.0.1";

const server = Bun.serve({
	port,
	hostname,
	fetch: createHandler(config),
});

console.log(
	`Misskey media proxy listening on ${server.url}${configPath ? ` (config: ${configPath})` : ""}`,
);
