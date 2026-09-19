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
| `got` + `cacheable-lookup` + `hpagent` | `fetch` (env proxies, `proxy`, `AbortSignal`) |
| `file-type`                     | ~180 lines of magic-number sniffing (`file-info.ts`) |
| `is-svg`                        | inline heuristic                                    |
| `ipaddr.js`                     | inline IPv4/IPv6 + CIDR parser (`net.ts`)           |
| `content-disposition`           | inline RFC 6266/5987 formatter (`http.ts`)          |
| `tmp`                           | `node:fs/promises` + `os.tmpdir()` + `randomUUID`   |
| `typescript` (build step)       | none — Bun runs the `.ts` sources directly          |

`node:fs`, `node:os`, `node:crypto`, `node:net`, `node:dns` and `node:path` are
used, but all ship with the Bun runtime.

## Layout

```
start.ts                 entry point: load config.js, Bun.serve on 127.0.0.1
src/index.ts             request routing, proxy pipeline, response/error handling
src/config.ts            config defaults and normalisation
src/download.ts          fetch + streaming download with size cap and SSRF guard
src/file-info.ts         magic-number type detection + mime dictionaries
src/image-processor.ts   Bun.Image pipelines (webp / badge png)
src/net.ts               private-IP and CIDR checks
src/create-temp.ts       private scratch files, always cleaned up
src/http.ts              semaphore, headers, Content-Disposition
src/const.ts             browser-safe / convertible mime lists
config.example.js        copy to config.js
```

## Run

```fish
cd src-refactor
cp config.example.js config.js
bun start.ts          # or: bun run start
bun --watch start.ts  # dev
```

`PORT` (default 3000) and `MISSKEY_MEDIA_PROXY_CONFIG` (default `./config.js`)
are honoured. The server always binds to `127.0.0.1`, like the original.

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

- **SVG is rejected with `415`.** Bun.Image cannot rasterise SVG and there is no
  librsvg. The original converted SVG to WebP, so this is a real regression;
  serving raw SVG would reintroduce the XSS the format is excluded for.
- **Animated emoji/avatar are not preserved.** APNG and animated WebP are passed
  through untouched (`static` still needs a decodable frame). Animated GIF is
  decoded to its first frame, so `emoji`/`avatar` return a static WebP instead of
  an animated one.
- **`badge` is approximate**: a 96×96 greyscale PNG, without sharp's
  normalise/contrast/alpha-mask pipeline or the entropy-based 404.
- **TIFF, ICO and AVIF cannot be converted on Linux** (missing OS codecs), so
  conversion flags return `404`. Pass-through of those types still works.

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
