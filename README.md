# misskey-media-proxy (maintained fork)

This repository is a maintained fork of
[`misskey-dev/media-proxy`](https://github.com/misskey-dev/media-proxy).
Upstream has not been updated since early 2024, so this fork keeps the code base
and its dependencies current and ships a Nix flake for building and running it.

The proxy implements the Misskey media proxy HTTP API: it downloads remote
media, validates it, optionally converts images with
[sharp](https://sharp.pixelplumbing.com/), and caches the result. See
[`SPECIFICATION.md`](./SPECIFICATION.md) for the API details.

It runs on [Bun](https://bun.com) and uses `Bun.serve` for the HTTP server;
`sharp` and the other native dependencies are kept because they carry the
image-codec coverage, the download/SSRF behaviour and the type detection that
Bun's built-ins cannot fully replace.

## Changes from upstream

- Runs on Bun instead of Node.js. `Bun.serve` replaces
  `fastify` + `@fastify/static`, and Bun runs the TypeScript sources directly,
  so there is no build step.
- Dropped `fastify`, `@fastify/static` and `content-disposition`.
- Kept the dependencies that matter for correctness, security and codec
  coverage:
  - `sharp` + `@misskey-dev/sharp-read-bmp` — image conversion (including SVG
    rasterisation, animated GIF/WebP, the `badge` pipeline, TIFF/BMP/ICO);
    re-encoding is also the boundary that strips metadata/polyglot payloads.
  - `got` + `cacheable-lookup` + `hpagent` — downloads with timeouts and size
    limits, DNS caching, forward-proxy support, and access to the connected
    peer IP used for SSRF checks.
  - `file-type` + `is-svg` — content-based type detection (a wrong MIME is a
    type-confusion bug; SVG is excluded for XSS reasons).
  - `ipaddr.js` — private/special IP classification for SSRF.
  - `tmp` — scratch files with `0600` permissions.
- Configuration can be TOML, YAML, JSON or JavaScript, parsed with Bun's
  built-in parsers. The NixOS module now generates TOML.
- Fixed a temporary-file leak: cleanup is unconditional (upstream disabled it
  whenever `NODE_ENV` was not `production`, leaking every download into the
  service's `PrivateTmp` tmpfs, i.e. into RAM).
- Added `maxConcurrentConversions` to bound simultaneous sharp work.
- The private-network check now always runs. Direct downloads inspect the
  connected peer IP (no DNS-rebinding window); proxied downloads resolve the
  target locally first.
- Added a Nix flake and a NixOS module.

## Nix

```fish
nix build          # build packages.<system>.default
nix run            # run the proxy (reads config.toml from $PWD)
```

The derivation builds sharp against the `libvips` from nixpkgs, so no prebuilt
binaries are shipped, and wraps the server with Bun.
### NixOS module

```nix
{
  inputs.misskey-media-proxy.url = "github:Lhcfl/media-proxy";

  # in a NixOS configuration
  imports = [ inputs.misskey-media-proxy.nixosModules.default ];

  services.misskey-media-proxy = {
    enable = true;
    port = 3000;
    # memoryMax = "1G";

    # Written to a TOML file (see config.example.toml)
    settings = {
      userAgent = "MisskeyMediaProxy";
      allowedPrivateNetworks = [ ];
      maxSize = 262144000;
      "Access-Control-Allow-Origin" = "*";
      "Access-Control-Allow-Headers" = "*";
      "Content-Security-Policy" =
        "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'";
      maxConcurrentConversions = 4;
      # proxy = "http://127.0.0.1:3128";
    };
  };
}
```

The module generates the config file from `settings`, points the service at it
via `MISSKEY_MEDIA_PROXY_CONFIG`, and runs the server as a hardened
`DynamicUser`. The server always binds to `127.0.0.1`; put a reverse proxy in
front of it if it needs to be reachable from elsewhere.

## Development

Requires Bun 1.4+. The server runs the TypeScript sources directly.

```fish
bun install
bun run typecheck   # tsc, type-check only
bun start           # or: bun run start
bun --watch run ./start.ts   # dev
```

Bun runs the TypeScript sources directly, so type-only imports must use
`import type` (enforced by `verbatimModuleSyntax` in `tsconfig.json`).

If you build sharp from source instead of using the prebuilt binaries, add
`node-addon-api` (already a devDependency) and have `libvips` + `pkg-config`
available, then run `SHARP_FORCE_GLOBAL_LIBVIPS=1 node-gyp rebuild --directory=node_modules/sharp/src`.

### config.toml

Create `config.toml` in the working directory (`start.ts` looks for the first
`config.*`; set `MISSKEY_MEDIA_PROXY_CONFIG` to use another path). TOML, YAML,
JSON and JavaScript are all accepted.

```toml
userAgent = "MisskeyMediaProxy"
allowedPrivateNetworks = []
maxSize = 262144000

"Access-Control-Allow-Origin" = "*"
"Access-Control-Allow-Headers" = "*"
"Content-Security-Policy" = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'"

# proxy = "http://127.0.0.1:3128"
maxConcurrentConversions = 4
```

The only required options are `userAgent`, `allowedPrivateNetworks` and
`maxSize`; everything else is optional. `config.example.toml` lists the full
set (YAML/JSON/JS files are also accepted).

### API

Requests are served as `GET /proxy?url=<url>` (or `GET /<host>/<path>`), with
`emoji`, `avatar`, `static`, `preview`, `badge` and `fallback` query flags as
described in [`SPECIFICATION.md`](./SPECIFICATION.md).

## Updating dependencies

```fish
bun update --latest
bun run typecheck
```

When `bun.lock` changes, reset `bunCache`'s `outputHash` in
`nix/misskey-media-proxy.nix` to `lib.fakeHash`, run `nix build`, and copy the
correct hash from the error message.

## License

AGPL-3.0-or-later, see [`LICENSE`](./LICENSE). Original work by syuilo and
tamaina.
