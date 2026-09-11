# misskey-media-proxy (maintained fork)

This repository is a maintained fork of
[`misskey-dev/media-proxy`](https://github.com/misskey-dev/media-proxy). Upstream
has not been updated since early 2024, so this fork keeps the code base and its
dependencies current and ships a Nix flake for building and running it.

The proxy implements the Misskey media proxy HTTP API: it downloads remote
media, validates it, optionally converts images with
[sharp](https://sharp.pixelplumbing.com/), and caches the result. See
[`SPECIFICATION.md`](./SPECIFICATION.md) for the API details.

## Changes from upstream

- Updated all dependencies, notably:
  - `fastify` 4 → 5, `@fastify/static` 6 → 10
  - `sharp` 0.32 → 0.35 (and `@misskey-dev/sharp-read-bmp` 1.1 → 1.3)
  - `file-type` 19 → 22, `got` 13 → 16, `content-disposition` 0.5 → 3
  - `is-svg` 5 → 6, `ipaddr.js` 2.1 → 2.5, `tmp` 0.2.1 → 0.2.7
  - TypeScript 5.3 → 7.0, Node.js 20 → 26
- Replaced `fastify-cli` with a small `start.js` entry point.
  `fastify-cli@8.0.1` currently crashes with `pkgUp is not a function` because it
  requires the ESM-only `pkg-up@5`.
- Removed the build step: Node.js runs the TypeScript sources directly using
  type stripping, so local imports use `.ts` extensions, the sources are shipped
  as-is, and `tsc` is only used for type-checking.
- Turned HTTP/2 off for downloads (taken from upstream PR #13) and dropped the
  unused `ip-cidr` / `private-ip` dependencies.
- Added a Nix flake and a NixOS module.

## Nix

```fish
nix build          # build packages.<system>.default
nix run            # run the proxy (reads config.js from $PWD)
```

The derivation builds sharp against the `libvips` from nixpkgs, so no prebuilt
binaries are shipped.

### NixOS module

```nix
{
  inputs.misskey-media-proxy.url = "github:Lhcfl/media-proxy";

  # in a NixOS configuration
  imports = [ inputs.misskey-media-proxy.nixosModules.default ];

  services.misskey-media-proxy = {
    enable = true;
    port = 3000;

    # Written to config.js (see below for the available options)
    settings = {
      userAgent = "MisskeyMediaProxy";
      allowedPrivateNetworks = [ ];
      maxSize = 262144000;
      "Access-Control-Allow-Origin" = "*";
      "Access-Control-Allow-Headers" = "*";
      "Content-Security-Policy" =
        "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'";
      # proxy = "http://127.0.0.1:3128";
    };
  };
}
```

The module generates `config.js` from `settings`, points the service at it via
`MISSKEY_MEDIA_PROXY_CONFIG`, and runs the server as a hardened `DynamicUser`.
The server always binds to `127.0.0.1`; put a reverse proxy in front of it if it
needs to be reachable from elsewhere.

## Development

Requires Node.js 26 and pnpm 10. Node.js executes the TypeScript sources
natively (type stripping), so there is no build step.

```fish
pnpm install
pnpm run typecheck   # tsc, type-check only
pnpm start           # node ./start.js
```

`pnpm dev` runs `node --watch ./start.js`.

Type stripping only supports erasable syntax, so type-only imports must use
`import type` (enforced by `verbatimModuleSyntax` in `tsconfig.json`).

If you build sharp from source instead of using the prebuilt binaries, add
`node-addon-api` (already a devDependency) and have `libvips` + `pkg-config`
available, then run `SHARP_FORCE_GLOBAL_LIBVIPS=1 node-gyp rebuild --directory=node_modules/sharp/src`.

### config.js

Create `config.js` in the working directory (`start.js` imports it by default;
set `MISSKEY_MEDIA_PROXY_CONFIG` to use another path):

```js
import { readFileSync } from 'node:fs';

const repo = JSON.parse(readFileSync('./package.json', 'utf8'));

export default {
    // User-Agent used for downloads
    userAgent: `MisskeyMediaProxy/${repo.version}`,

    // Private network ranges to allow (same as default.yml)
    allowedPrivateNetworks: [],

    // Maximum download size in bytes
    maxSize: 262144000,

    // CORS
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',

    // CSP
    'Content-Security-Policy': `default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'`,

    // Forward proxy
    // proxy: 'http://127.0.0.1:3128'
};
```

The only required options are `userAgent`, `allowedPrivateNetworks` and
`maxSize`; everything else is optional.

### API

Requests are served as `GET /proxy?url=<url>` (or `GET /<host>/<path>`), with
`emoji`, `avatar`, `static`, `preview`, `badge` and `fallback` query flags as
described in [`SPECIFICATION.md`](./SPECIFICATION.md).

## Updating dependencies

```fish
pnpm update --latest
pnpm install
pnpm run typecheck
```

When `pnpm-lock.yaml` changes, reset `pnpmDeps.hash` in
`nix/misskey-media-proxy.nix` to `lib.fakeHash`, run `nix build`, and copy the
correct hash from the error message.

## License

AGPL-3.0-or-later, see [`LICENSE`](./LICENSE). Original work by syuilo and
tamaina.
