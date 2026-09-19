# Misskey 媒体代理规范

## 媒体代理的种类与目的

Misskey 媒体代理是一个应用程序：它把远端文件在**由实例管理员管理的域名**下代理分发，并提供缩小/加工后的图片。

它有两种：

- Misskey 服务器本体在 `/proxy/` 提供的「本体媒体代理（local media proxy）」；
- 由 [github.com/misskey-dev/media-proxy](https://github.com/misskey-dev/media-proxy)
  分发的「外部媒体代理（external media proxy）」。

配置并使用外部媒体代理可以减轻本体的服务器负载。若多个实例共用同一个外部代理，还能进一步减轻负载。

## 外部媒体代理的配置与使用

要配置外部媒体代理，请按 [`../README.md`](../README.md) 所述进行安装。

当配置了外部媒体代理时，本体媒体代理会返回指向外部媒体代理的 **301 重定向**（指定了 `origin` 查询参数时除外）。

Misskey 服务器的 `api/meta` 响应中存在 `mediaProxy` 属性，用于指示应当使用的媒体代理 URL：

- 若指定了外部媒体代理，则为其 URL；
- 若未指定，则为本体媒体代理（`/proxy/`）的 URL。

虽然本体媒体代理会做重定向，但 Misskey 客户端应当根据 `mediaProxy` 的值，**直接**向合适的媒体代理发起请求。

对媒体代理的指令通过查询字符串给出。

由于有些 CDN 会根据扩展名改变缓存行为，应当附加一个合适的文件名，例如 `image.webp`、`avatar.webp`、`static.webp`。

示例：
`https://example.com/proxy/image.webp?url=https%3A%2F%2F......`

- `Accept` 头会被忽略。
- `Cache-Control`：正常响应为 `max-age=31536000, immutable`，错误响应为 `max-age=300`。
- `Content-Type`：根据文件内容插入合适的类型。
- `Content-Security-Policy` 为
  `default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'`。
- `Content-Disposition`：`filename` 基于原图的 `Content-Disposition` 的 filename，或基于文件名插入。扩展名会按需修正；若为 `octet-stream`，则附加扩展名 `.unknown`。类型为 `inline`。

### 查询参数一览

#### url（必需）

指定要转换或代理的原图 URL。
未指定时返回 HTTP 400。

代理 `https://www.google.com/images/errors/robot.png` 时：
`https://example.com/proxy/image.webp?url=https%3A%2F%2Fwww.google.com%2Fimages%2Ferrors%2Frobot.png`

#### origin（仅本体）

存在时，不向外部媒体代理做重定向。

`https://example.com/proxy/image.webp?url=https%3A%2F%2F...&origin=1`

「存在时」指的是 Fastify 中 `'origin' in request.query` 为 true 的情况。下同。

#### fallback

存在时，如果无法访问到原图，或图片转换过程中发生错误，则以正常响应（`Cache-Control` 为 `max-age=300`）返回一张回退图片（彩条）。

#### 未指定转换查询时的行为

以下各项都是用于指定转换格式的查询参数。

未指定转换格式时，只有当文件是图片，或是被允许的文件（`FILE_TYPE_BROWSERSAFE`）时，才会进行代理（文件的原样再分发）。
不过，**SVG 会被转换为 webp**（最大尺寸 2048×2048）。

#### 附加了转换查询时的行为

反之，如果指定了下面的转换查询，但源文件的格式 sharp.js 无法转换，则返回 **404**。

#### emoji

存在时，返回高度不超过 128px 的 webp。
不过，受 sharp.js 的限制，若原图为 APNG，则不做转换、原样返回。

`https://example.com/proxy/emoji.webp?url=https%3A%2F%2F...&emoji=1`

「不超过」意味着原图小于该尺寸时不会放大。下同。

#### avatar

存在时，返回高度不超过 320px 的 webp。
不过，受 sharp.js 的限制，若原图为 APNG，则不做转换、原样返回。

`https://example.com/proxy/avatar.webp?url=https%3A%2F%2F...&avatar=1`

#### static

存在时，对于动画图片，返回只包含第一帧的静止 webp。

当 `emoji` 或 `avatar` 与 `static` 同时指定时，按各自对应的高度；若都未指定，则缩小到不超过宽 498px、高 422px。

#### preview

存在时，返回能容纳在宽 200px、高 200px 以内的 webp。

#### badge

返回适合作为 Web 推送通知徽章的 png。

https://developer.mozilla.org/zh-CN/docs/Web/API/Notification/badge

尺寸为 96×96，且原图仅以 alpha 通道表示。
