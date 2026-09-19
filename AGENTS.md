# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

A maintained fork of [`misskey-dev/media-proxy`](https://github.com/misskey-dev/media-proxy):
an HTTP media proxy for Misskey that downloads remote media, validates it,
optionally converts images with `sharp`, and streams the result back.

It runs on **Bun** (`Bun.serve`, TypeScript sources executed directly — no build
step). The HTTP API is specified in [`spec/`](./spec/README.md) (the Japanese
file is authoritative; English and Chinese translations are included); keep
behaviour in sync with it, except for the intentional deviations noted there
and in the README.

## Commands

```fish
bun install                  # dependencies (Bun is the package manager; use bun.lock)
bun run typecheck            # tsc, type-check only
bun test                     # bun:test suite
biome check .                # lint + format check (biome.json)
biome check --write .        # apply formatting / safe fixes
bun start                    # run the server (reads config.toml etc.)
bun --watch run ./start.ts   # dev
nix build                    # build the package (compiles sharp from source)
```

Run `biome check .`, `bun run typecheck` and `bun test` before committing.

## Layout

```
start.ts                 entry point: load config, Bun.serve on 127.0.0.1
src/index.ts             request pipeline (download -> detect -> convert -> respond)
src/config.ts            config types, defaults, multi-format loader
src/download.ts          downloads: node:http/https, Bun.dns, proxy, SSRF, size limits
src/file-info.ts         content-based MIME detection + mime dictionaries
src/image-processor.ts   sharp webp pipelines
src/create-temp.ts       private scratch files
src/web.ts               semaphore, headers, Content-Disposition, filenames
src/const.ts             browser-safe / convertible mime lists
src/status-error.ts      StatusError
test/download.test.ts    bun:test suite for the download layer
config.example.toml      example configuration
nix/                     flake package and NixOS module
```

## Runtime dependencies (keep this set small)

Only six runtime deps are intentional:

- `sharp` — image conversion (SVG rasterisation, animated GIF/WebP, `badge`,
  TIFF). Re-encoding is also the security boundary that strips
  metadata/polyglot payloads. BMP is decoded with `Bun.Image` first (see
  `openImage`); ICO is forwarded unchanged because Bun has no ICO decoder and
  sharp builds may lack BMP support.
- `file-type` + `is-svg` — content sniffing. A wrong MIME is a type-confusion
  bug; SVG is deliberately excluded (XSS).
- `ipaddr.js` — private/special IP classification for SSRF.
- `tmp` — scratch files with `0600` permissions.

Prefer Bun built-ins (or `node:*`) over new dependencies. If a new dependency is
genuinely needed, explain why in the commit and update `nix/misskey-media-proxy.nix`.

**Do not re-add** `fastify`/`@fastify/static` (use `Bun.serve`),
`content-disposition` (hand-written in `src/web.ts`), `got` /
`cacheable-lookup` / `hpagent` (replaced by `src/download.ts`), or
`@misskey-dev/sharp-read-bmp` (BMP uses `Bun.Image`; ICO is not converted).

## Invariants

- **Always clean up temp files.** Cleanup must not be gated on `NODE_ENV`.
  Upstream disabled it outside `production`, leaking every download into the
  service's `PrivateTmp` tmpfs (i.e. into RAM).
- **Always run the SSRF check.**
  - Direct downloads: check `res.socket.remoteAddress` after connecting (no DNS
    rebinding window).
  - Proxied downloads: resolve the target with `Bun.dns.lookup` and check every
    address first (`res.socket` would be the proxy).
  - Re-check on every redirect hop.
- **Reject SVG.** Never serve raw SVG: it can execute as a document. `sharp`
  rasterises it to webp; if conversion is requested but unsupported, fail rather
  than pass it through.
- **ICO is always forwarded unchanged**, including when a conversion flag is
  present (Bun has no ICO decoder). BMP is decoded with `Bun.Image` before the
  sharp pipeline.
- **Bound work.** Image conversions go through the `Semaphore`
  (`maxConcurrentConversions`). Enforce `maxSize` both from `content-length` and
  while streaming.
- `Bun.serve` always binds `127.0.0.1`; a reverse proxy is expected in front.

## Conventions

- Biome: tabs, double quotes, organized imports (`import type` for type-only
  imports — required by `verbatimModuleSyntax`). `biome.json` lints `./src` and
  `./test`.
- Local imports use explicit `.ts` extensions (Bun runs the sources directly).
- Config is TOML/YAML/JSON/JS, parsed with `Bun.TOML` / `Bun.YAML` /
  `Bun.JSONC` / `Bun.JSON5`; `MISSKEY_MEDIA_PROXY_CONFIG` or the first
  `config.*` in the working directory.

## Gotchas

- `Bun.dns.lookup` does **not** use Bun's internal DNS cache (that cache is for
  `fetch`/`Bun.connect`, populated by `Bun.dns.prefetch`). The `node:http` agent
  calls the `lookup` hook per new connection; `src/download.ts` adapts the
  Promise API to the callback signature and does not cache.
- `node:http` under Bun does honour `agent.lookup` and provides
  `res.socket.remoteAddress`; HTTPS via a forward proxy uses `CONNECT` + `tls`,
  HTTP uses absolute-form requests.
- `Accept-Encoding: identity` is sent; gzip/deflate/br are still decoded if a
  server ignores it.
- In tests, the HTTPS proxy case sets `NODE_TLS_REJECT_UNAUTHORIZED=0` because
  the test server uses a self-signed certificate generated with `openssl`.

## Nix

- `nix/misskey-media-proxy.nix` builds `node_modules` in a fixed-output
  derivation with `bun install --frozen-lockfile --backend=copyfile
  --omit=optional`, then compiles sharp with `node-gyp` against `pkgs.vips`.
- The addon is built with the **default `pkgs.nodejs`** (in the binary cache);
  `nodejs_26` had to be compiled from source on the pinned nixpkgs and pegged
  the CPU.
- When `bun.lock` or `package.json` changes, set the `bunDeps` `outputHash` to
  `lib.fakeHash`, run `nix build`, and copy the hash from the error.
- `nix/module.nix` generates a TOML config; `settings` is typed `lib.types.toml`.
