# Misskey Media Proxy Specification

## Types and purpose of media proxies

The Misskey media proxy is an application that proxies remote files for delivery
under a domain managed by the instance administrator, and that serves
downscaled/processed images.

There are two kinds:

- the "local media proxy" provided by the Misskey server itself at `/proxy/`;
- the "external media proxy" distributed at
  [github.com/misskey-dev/media-proxy](https://github.com/misskey-dev/media-proxy).

Configuring and using an external media proxy reduces the load on the main
server. Sharing an external proxy across multiple instances is expected to
reduce it further.

## Configuring and using the external media proxy

To configure an external media proxy, install it as described in
[`../README.md`](../README.md).

When an external media proxy is configured, the local media proxy responds with
a 301 redirect to the external media proxy (except when the `origin` query is
present).

The Misskey server's `api/meta` response has a `mediaProxy` property that
indicates the media proxy URL to use. If an external media proxy is configured,
its URL is used; otherwise the URL of the local media proxy (`/proxy/`). Although
the local media proxy issues a redirect, Misskey clients should request the
appropriate media proxy directly according to the value of `mediaProxy`.

Commands are given to the media proxy through the query string.

Because some CDNs change their caching behavior based on the file extension, an
appropriate filename such as `image.webp`, `avatar.webp` or `static.webp` should
be appended.

Example:
`https://example.com/proxy/image.webp?url=https%3A%2F%2F......`

- The `Accept` header is ignored.
- `Cache-Control` is `max-age=31536000, immutable` for successful responses and
  `max-age=300` for error responses.
- `Content-Type` is set to whatever is appropriate for the file contents.
- `Content-Security-Policy` is
  `default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'`.
- `Content-Disposition`: the filename is based on the source image's
  `Content-Disposition` filename, or on the file name. The extension is adjusted
  as appropriate; for `octet-stream`, `.unknown` is appended as the extension.
  `inline` is specified.

### Query list

#### url (required)

Specifies the URL of the source image to convert or proxy.
If it is not specified, HTTP 400 is returned.

To proxy `https://www.google.com/images/errors/robot.png`:
`https://example.com/proxy/image.webp?url=https%3A%2F%2Fwww.google.com%2Fimages%2Ferrors%2Frobot.png`

#### origin (local proxy only)

If present, no redirect to the external media proxy is performed.

`https://example.com/proxy/image.webp?url=https%3A%2F%2F...&origin=1`

"If present" means the case where `'origin' in request.query` is true in
Fastify. The same applies below.

#### fallback

If present, when the source image cannot be reached or an error occurs during
conversion, a fallback image (color bars) is returned as a normal response
(with `Cache-Control: max-age=300`).

#### Behavior when no conversion query is present

The following items are queries that specify a conversion format.

When no conversion format is specified, proxying (redelivery of the file) is
performed only when the file is an image, or an allowed file
(`FILE_TYPE_BROWSERSAFE`). However, SVG is converted to WebP (maximum size
2048x2048).

#### Behavior when a conversion query is added

Conversely, if one of the conversion queries below is specified but the source
file is in a format that sharp.js cannot convert, 404 is returned.

#### emoji

If present, a WebP with a height of 128px or less is returned.
However, due to limitations of sharp.js, if the source image is APNG it is
returned without conversion.

`https://example.com/proxy/emoji.webp?url=https%3A%2F%2F...&emoji=1`

"Or less" means that when the source image is smaller, it is not enlarged. The
same applies below.

#### avatar

If present, a WebP with a height of 320px or less is returned.
However, due to limitations of sharp.js, if the source image is APNG it is
returned without conversion.

`https://example.com/proxy/avatar.webp?url=https%3A%2F%2F...&avatar=1`

#### static

If present, for animated images a still WebP containing only the first frame is
returned.

If `emoji` or `avatar` and `static` are specified together, the corresponding
height applies; if neither is specified, the image is scaled down to fit within
a width of 498px and a height of 422px.

#### preview

If present, a WebP that fits within 200px wide and 200px high is returned.

#### badge

A PNG suitable as a Web Push badge is returned.

https://developer.mozilla.org/en-US/docs/Web/API/Notification/badge

The size is 96x96, and the source image is represented by the alpha channel
only.
