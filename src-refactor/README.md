# src-refactor — Bun 重写版（实验）

用 [Bun](https://bun.com) 从零重写的媒体代理，**零运行时依赖**。目标是尽量保持
[`SPECIFICATION.md`](../SPECIFICATION.md) 的 API 和语义，同时把整棵 npm 依赖树换成
Bun 内置能力。

这是一个实验：可以正常跑通同样的端点，但替换掉 Node 版之前请先读
[与旧版的差异](#与旧版的差异)。

## 替换掉的依赖

| 原来 | 现在 |
| ------------------------------- | -------------------------------------------------- |
| `fastify` + `@fastify/static`   | `Bun.serve` + `Bun.file`                            |
| `sharp` + `@misskey-dev/sharp-read-bmp` | `Bun.Image`（libjpeg-turbo / spng / libwebp） |
| `got` + `cacheable-lookup` + `hpagent` | `fetch`（环境代理、`proxy`、`AbortSignal`）+ `Bun.dns.lookup` |
| `file-type`                     | 约 180 行 magic-number 嗅探（`file-info.ts`） |
| `is-svg`                        | 内联启发式判断 |
| `ipaddr.js`                     | 内联 IPv4/IPv6 + CIDR 解析（`net.ts`） |
| `content-disposition`           | 内联 RFC 6266/5987 格式化（`http.ts`） |
| `tmp`                           | `node:fs/promises` + `os.tmpdir()` + `randomUUID` |
| `typescript`（构建步骤）        | 无 —— Bun 直接运行 `.ts` 源码 |
| `import` `config.js` 的配置方式 | `Bun.TOML` / `Bun.YAML` / `Bun.JSONC` / `Bun.JSON5` |

用到了 `node:fs`、`node:os`、`node:crypto`、`node:net`、`node:path`，但它们都随 Bun
运行时自带。`node:fs` 只用来在 `0700` 目录里创建 `0600` 权限的临时文件
（`Bun.write` 无法设置权限）。

有些手写代码确实没有 Bun 等价物 —— 已对照完整的
[`Bun` 参考文档](https://bun.com/reference/bun) 逐项确认：

- 没有基于内容的 MIME 嗅探（`Bun.file().type` 只认扩展名，无扩展名文件返回
  `application/octet-stream`），所以 `file-info.ts` 必须保留；
- 没有 IP/CIDR 分类，所以 `net.ts` 必须保留（只有 DNS 查询用了 `Bun.dns.lookup`）；
- 没有 `Content-Disposition` 构造器，所以 `http.ts` 必须保留；
- 没有临时文件原语，所以 `create-temp.ts` 必须保留。

同样地，`Bun.Image` 只有 `resize`/`rotate`/`flip`/`flop`/`modulate`、只有
`fit: "fill" | "inside"`，没有原始像素、合成、动画或 `normalise` —— 这正是下面
badge 和动画相关差异存在的原因。

## 目录结构

```
start.ts                 入口：加载配置，Bun.serve 监听 127.0.0.1
src/index.ts             路由、代理主流程、响应/错误处理
src/config.ts            配置类型、默认值、多格式加载器
src/download.ts          fetch + 流式下载，含大小上限和 SSRF 防护
src/file-info.ts         magic-number 类型探测 + mime 字典
src/image-processor.ts   Bun.Image 流水线（webp / badge png）
src/net.ts               私网 IP 与 CIDR 判断（Bun.dns + 内联解析）
src/create-temp.ts       私有临时文件，始终会被清理
src/http.ts              信号量、响应头、Content-Disposition
src/const.ts             浏览器安全 / 可转换的 mime 列表
config.example.toml      复制成 config.toml
config.example.js        同上，JavaScript 形式
```

## 运行

```fish
cd src-refactor
cp config.example.toml config.toml
bun start.ts          # 或：bun run start
bun --watch start.ts  # 开发
```

支持 `PORT`（默认 3000）。和原版一样，服务始终只绑定 `127.0.0.1`。

### 配置

`MISSKEY_MEDIA_PROXY_CONFIG` 可以指向 `.toml`、`.yaml`、`.yml`、`.json`、
`.jsonc`、`.json5`、`.js` 或 `.ts` 文件。没有设置时，会加载工作目录下第一个
`config.*`（顺序：toml、yaml、yml、json、jsonc、json5、js、mjs、ts）；一个都没有
就用内置默认值。

配置项和原版一致（`userAgent`、`allowedPrivateNetworks`、`maxSize`、CORS/CSP 键、
`proxy`），另外多了 `maxConcurrentConversions` 和 `downloadTimeoutMs`。

因为 Bun 原生解析 TOML/YAML/JSON，NixOS 模块可以直接生成配置文件，而不必再生成
JavaScript：

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

`Bun.serve` 默认空闲超时为 10 秒；如果上游下载很慢，需要同时调大
`downloadTimeoutMs` 和 `Bun.serve({ idleTimeout })`。

## API

没有变化：`GET /proxy?url=<url>` 或 `GET /<host>/<path>`，支持 `emoji`、`avatar`、
`static`、`preview`、`badge`、`fallback` 参数。响应头（`Cache-Control`、
`Content-Type`、`Content-Disposition`、CORS、CSP）遵循规范。

## 与旧版的差异

结构性改进：

- **临时文件始终会被删除。** 原版只要 `NODE_ENV !== "production"` 就禁用清理，
  导致每次下载的文件都泄漏进服务的 `PrivateTmp` tmpfs（也就是内存）。这里清理是
  无条件的。
- **并发上限。** `maxConcurrentConversions`（默认 4）限制同时进行的 `Bun.Image`
  任务，避免 Misskey 的请求突发让解码缓冲区叠加。原版没有任何限制。
- **正向代理下也会做 SSRF 检查。** 因为域名是在本地解析的，即使配置了代理，私网
  目标也会被拒绝；只有代理才能解析的域名会交给 `fetch` 处理。
- 大小超限和 SSRF 失败返回 `413`/`403`，而不是 `500`。

能力差异（`Bun.Image` 带来的限制）：

- **动画通过原样透传来保留。** `Bun.Image` 只解码第一帧，所以任何动画 GIF、APNG、
  动画 WebP 在请求 `emoji`、`avatar` 或 `preview` 时会原样返回（原始字节、原始
  `Content-Type`）。`static` 在解码器支持时仍会转成静态 WebP。
- **Bun 无法转换的格式回退为原始文件。** Linux 上的 TIFF、ICO、AVIF/HEIC 等会返回
  源文件及其真实 `Content-Type`，而不是 `404`，客户端仍能拿到可用的图片。只有
  非图片 mime 带转换参数时才会 `404`。
  这是有意违反 `SPECIFICATION.md` 的：规范说对不可转换文件带转换查询应返回 `404`，
  但对代理来说保留动画/原图更有用。
- **SVG 仍然返回 `415`。** `Bun.Image` 无法栅格化 SVG，也没有 librsvg。和其他格式
  不同，直接返回原始 SVG 不是一个选项：那会重新引入该格式被排除在外的 XSS 风险。
- **`badge` 是近似实现**：96×96 灰度 PNG，没有 sharp 的 normalise/对比度/alpha mask
  流水线，也没有基于熵的 404。

其他：

- 私网检查是先用 DNS 解析、再交给 `fetch` 连接，因此存在一个很小的 DNS rebinding
  时间窗口。原版是检查已连接的 socket，但只在没走代理时有效。
- `Cache-Control`、`Content-Disposition` 和文件名修正是重新实现的，边界情况可能与
  原来的 npm 包不同。

## 快速验证

```fish
bun start.ts &
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' \
  'http://127.0.0.1:3000/proxy/img.webp?url=https%3A%2F%2Fwww.google.com%2Fimages%2Ferrors%2Frobot.png&preview=1'
```

本地测试中，对一张 6000×6000 的 JPEG 发 400 次请求（24 并发），RSS 维持在约
45–95 MB，且没有残留临时文件 —— 相比 Node 版多 GB 的高水位。具体数值取决于机器。
