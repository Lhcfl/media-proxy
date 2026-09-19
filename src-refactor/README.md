# src-refactor — Bun rewrite (experiment)

A from-scratch reimplementation of the media proxy on [Bun](https://bun.com),
with **zero runtime dependencies**. It tries to keep the API and semantics of
[`SPECIFICATION.md`](../SPECIFICATION.md) while replacing the whole npm tree
with Bun built-ins.

This is an experiment: it is runnable and exercises the same endpoints, but see
[Deviations](#deviations) before swapping it in for the Node implementation.

## Dependencies removed

| Original                        | Replacement                                        |
| ------------------------------- | -------------------------------------------------- |
| `fastify` + `@fastify/static`   | `Bun.serve` + `Bun.file`                            |
| `sharp` + `@misskey-dev/sharp-read-bmp` | `Bun.Image` (libjpeg-turbo / spng / libwebp) |
| `got` + `cacheable-lookup` + `hpagent` | `fetch` (env proxies, `proxy`, `AbortSignal`) + `Bun.dns.lookup` |
| `file-type`                     | ~180 lines of magic-number sniffing (`file-info.ts`) |
| `is-svg`                        | inline heuristic                                    |
| `ipaddr.js`                     | inline IPv4/IPv6 + CIDR parser (`net.ts`)           |
| `content-disposition`           | inline RFC 6266/5987 formatter (`http.ts`)          |
| `tmp`                           | `node:fs/promises` + `os.tmpdir()` + `randomUUID`   |
| `typescript` (build step)       | none — Bun runs the `.ts` sources directly          |
| config `import`ing `config.js`  | `Bun.TOML` / `Bun.YAML` / `Bun.JSONC` / `Bun.JSON5` |

`node:fs`, `node:os`, `node:crypto`, `node:net` and `node:path` are used, but
all ship with the Bun runtime. `node:fs` is only used to create the scratch file
with `0600` permissions inside a `0700` directory (`Bun.write` cannot set modes).

There is no Bun equivalent for some of the hand-written helpers — checked
against the full [`Bun` reference](https://bun.com/reference/bun):

- no content-based MIME sniffing (`Bun.file().type` is extension-only and returns
  `application/octet-stream` for an extensionless file), so `file-info.ts` stays;
- no IP/CIDR classification, so `net.ts` stays (only the DNS lookup uses
  `Bun.dns.lookup`);
- no `Content-Disposition` builder, so `http.ts` stays;
- no temp-file primitive, so `create-temp.ts` stays.

Likewise `Bun.Image` only exposes `resize`/`rotate`/`flip`/`flop`/`modulate`,
`fit: "fill" | "inside"` and no raw pixels, compositing, animation or
`normalise` — which is exactly why the badge and animation deviations below
exist.

## Layout

```
start.ts                 entry point: load config, Bun.serve on 127.0.0.1
src/index.ts             request routing, proxy pipeline, response/error handling
src/config.ts            config types, defaults, and multi-format loader
src/download.ts          fetch + streaming download with size cap and SSRF guard
src/file-info.ts         magic-number type detection + mime dictionaries
src/image-processor.ts   Bun.Image pipelines (webp / badge png)
src/net.ts               private-IP and CIDR checks (Bun.dns + inline parser)
src/create-temp.ts       private scratch files, always cleaned up
src/http.ts              semaphore, headers, Content-Disposition
src/const.ts             browser-safe / convertible mime lists
config.example.toml      copy to config.toml
config.example.js        same, as JavaScript
```

## Run

```fish
cd src-refactor
cp config.example.toml config.toml
bun start.ts          # or: bun run start
bun --watch start.ts  # dev
```

`PORT` (default 3000) is honoured. The server always binds to `127.0.0.1`,
like the original.

### Configuration

`MISSKEY_MEDIA_PROXY_CONFIG` may point at a `.toml`, `.yaml`, `.yml`, `.json`,
`.jsonc`, `.json5`, `.js` or `.ts` file. Without it, the first `config.*` in the
working directory is loaded (order: toml, yaml, yml, json, jsonc, json5, js,
mjs, ts). If nothing is found, built-in defaults are used.

The options are the same as the original (`userAgent`, `allowedPrivateNetworks`,
`maxSize`, CORS/CSP keys, `proxy`), plus `maxConcurrentConversions` and
`downloadTimeoutMs`.

Because Bun parses TOML/YAML/JSON natively, a NixOS module can generate the file
instead of shipping JavaScript:

```nix
{ pkgs, ... }:
let
  configFile = (pkgs.formats.toml { }).generate "config.toml" {
    userAgent = "MisskeyMediaProxy";
    allowedPrivateNetworks = [ ];
    maxSize = 262144000;
    "Access-Control-Allow-Origin" = "*";
    "Access-Control-Allow-Headers" = "*";
    "Content-Security-Policy" =
      "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'";
    maxConcurrentConversions = 4;
  };
in {
  systemd.services.misskey-media-proxy-bun = {
    environment.MISSKEY_MEDIA_PROXY_CONFIG = "${configFile}";
    # ...
  };
}
```

`Bun.serve` defaults to a 10 s idle timeout; for very slow upstream downloads
raise `downloadTimeoutMs` and `Bun.serve({ idleTimeout })` accordingly.

## API

Unchanged: `GET /proxy?url=<url>` or `GET /<host>/<path>`, with `emoji`,
`avatar`, `static`, `preview`, `badge` and `fallback` flags. Headers
(`Cache-Control`, `Content-Type`, `Content-Disposition`, CORS, CSP) follow the
specification.

## Deviations

Structural improvements:

- **Temporary files are always deleted.** The original disables cleanup whenever
  `NODE_ENV !== "production"`, which leaks every download into the service's
  `PrivateTmp` tmpfs (i.e. into RAM). Cleanup here is unconditional.
- **Concurrency cap.** `maxConcurrentConversions` (default 4) bounds simultaneous
  `Bun.Image` work, which keeps decode buffers from adding up under Misskey's
  request bursts. The original had no limit.
- **SSRF check also runs behind a forward proxy.** Because the host is resolved
  locally, private targets are rejected even when a proxy is configured; a
  hostname only the proxy can resolve falls back to `fetch`.
- Error status codes for size and SSRF failures are `413`/`403` instead of `500`.

Capability differences (consequences of `Bun.Image`):

- **Animation is preserved by passing the original through.** `Bun.Image` only
  decodes the first frame, so any animated GIF, APNG or animated WebP requested
  as `emoji`, `avatar` or `preview` is returned untouched (original bytes,
  original `Content-Type`). `static` still converts to a still WebP when the
  codec can decode it.
- **Formats Bun cannot convert fall back to the original bytes.** TIFF, ICO,
  AVIF/HEIC on Linux etc. return the source file with its real `Content-Type`
  instead of a `404`, so the client still gets a usable image. Only a
  non-image mime with a conversion flag is a `404`.
  This intentionally contradicts `SPECIFICATION.md`, which says `404` for a
  conversion query on a non-convertible file — keeping the animation/asset is
  more useful for the proxy.
- **SVG is still rejected with `415`.** Bun.Image cannot rasterise SVG and there
  is no librsvg. Unlike the other formats, serving the raw SVG is not an option:
  it would reintroduce the XSS the format is excluded for.
- **`badge` is approximate**: a 96×96 greyscale PNG, without sharp's
  normalise/contrast/alpha-mask pipeline or the entropy-based 404.

Other:

- Private-IP checking resolves DNS up front and then lets `fetch` connect, which
  leaves a small DNS-rebinding window. The original inspected the connected
  socket, but only when not using a proxy.
- `Cache-Control`, `Content-Disposition` and filename correction are reimplemented
  and may differ in edge cases from the npm packages.

## Quick check

```fish
bun start.ts &
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' \
  'http://127.0.0.1:3000/proxy/img.webp?url=https%3A%2F%2Fwww.google.com%2Fimages%2Ferrors%2Frobot.png&preview=1'
```

In local testing, 400 requests of a 6000×6000 JPEG (24-at-a-time) kept RSS
between ~45 MB and ~95 MB with no leftover temp files — versus the multi-GB
watermark of the Node build. Numbers are machine-dependent.
