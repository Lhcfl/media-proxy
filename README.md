# misskey-media-proxy（维护分支）

本仓库是 [`misskey-dev/media-proxy`](https://github.com/misskey-dev/media-proxy)
的维护分支。上游自 2024 年初起不再更新，因此本分支负责跟进代码与依赖，并提供
Nix flake 用于构建和运行。

该代理实现了 Misskey 的媒体代理 HTTP API：下载远端媒体、校验类型、可选地用
[sharp](https://sharp.pixelplumbing.com/) 转换图片，并缓存结果。API 细节见 [`spec/`](./spec/README.md)（日文原文 + 中/英翻译）。

它运行在 [Bun](https://bun.com) 上，HTTP 服务器使用 `Bun.serve`。保留 `sharp`
等原生依赖，是因为它们提供 Bun 内置能力无法完全替代的图像编解码覆盖、下载/SSRF
行为与类型探测。

## 相对上游的改动

- 运行时从 Node.js 换成 Bun。`Bun.serve` 取代 `fastify` + `@fastify/static`，
  且 Bun 直接运行 TypeScript 源码，因此没有构建步骤。
- 移除了 `fastify`、`@fastify/static`、`content-disposition`、`got`、
  `cacheable-lookup`、`hpagent`。
- 保留了与正确性、安全性、编解码覆盖相关的依赖：
  - `sharp` —— 图像转换（SVG 栅格化、动画 GIF/WebP、`badge` 流水线、TIFF）；
    重新编码同时也是剥离元数据/多形态（polyglot）载荷的安全边界。BMP 先用
    `Bun.Image` 解码；ICO 原样转发（Bun 没有 ICO 解码器，而 sharp 的构建可能
    不支持 BMP）。
  - `file-type` + `is-svg` —— 基于内容的类型探测（MIME 判断错误会造成类型混淆；
    SVG 出于 XSS 原因被排除）。
  - `ipaddr.js` —— 为 SSRF 判断私有/特殊地址。
  - `tmp` —— 以 `0600` 权限创建临时文件。
- 下载使用 Node 的 `node:http`/`node:https`（由 Bun 实现），并用一层薄回调适配
  `Bun.dns.lookup`，因此仍能拿到**连接到的 peer IP** 用于 SSRF 检查。正向代理
  （`HTTP_PROXY`/`HTTPS_PROXY`）由同一处代码处理：HTTP 用 absolute-form，HTTPS
  用 `CONNECT` + TLS。
- 配置支持 TOML、YAML、JSON 或 JavaScript，由 Bun 内置解析器解析。NixOS 模块现在
  生成 TOML。
- 修复了临时文件泄漏：清理是无条件的（上游只要 `NODE_ENV` 不是 `production` 就
  禁用清理，导致每次下载都泄漏进服务的 `PrivateTmp` tmpfs，也就是内存里）。
- 新增 `maxConcurrentConversions`，限制同时进行的 sharp 任务数。
- 私网检查现在始终执行。直连下载检查连接后的 peer IP（没有 DNS rebinding 窗口）；
  走代理时先本地解析目标地址再检查。
- 新增 Nix flake 和 NixOS 模块。

## Nix

```fish
nix build          # 构建 packages.<system>.default
nix run            # 运行代理（从当前目录读取 config.toml）
```

构建过程会用 nixpkgs 的 `libvips` 从源码编译 sharp，因此不依赖预编译二进制，并用
Bun 包装启动脚本。

### NixOS 模块

```nix
{
  inputs.misskey-media-proxy.url = "github:Lhcfl/media-proxy";

  # 在 NixOS 配置中
  imports = [ inputs.misskey-media-proxy.nixosModules.default ];

  services.misskey-media-proxy = {
    enable = true;
    port = 3000;
    # memoryMax = "1G";

    # 会被写成 TOML 文件（见 config.example.toml）
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

模块根据 `settings` 生成配置文件，通过 `MISSKEY_MEDIA_PROXY_CONFIG` 指向它，并以
加固过的 `DynamicUser` 运行服务。服务始终只绑定 `127.0.0.1`；如果需要从外部访问，
请在它前面放一个反向代理。

## 开发

需要 Bun 1.4+。服务器直接运行 TypeScript 源码。

```fish
bun install
bun run typecheck            # 仅做类型检查（tsc）
bun test                     # bun:test 测试（下载、SSRF、代理、大小限制）
bun start                    # 或：bun run start
bun --watch run ./start.ts   # 开发
```

因为 Bun 直接运行 TypeScript 源码，类型专用导入必须使用 `import type`
（由 `tsconfig.json` 里的 `verbatimModuleSyntax` 强制）。

如果你要从源码编译 sharp 而不是使用预编译二进制，需要 `node-addon-api`
（已是 devDependency）以及可用的 `libvips` + `pkg-config`，然后运行：

```fish
SHARP_FORCE_GLOBAL_LIBVIPS=1 node-gyp rebuild --directory=node_modules/sharp/src
```

### config.toml

在工作目录创建 `config.toml`（`start.ts` 会查找第一个 `config.*`；设置
`MISSKEY_MEDIA_PROXY_CONFIG` 可指定其他路径）。TOML、YAML、JSON、JavaScript 都
支持。

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

只有 `userAgent`、`allowedPrivateNetworks`、`maxSize` 是必需的，其余可选。
`config.example.toml` 列出了完整项（也接受 YAML/JSON/JS 文件）。

### API

请求形式为 `GET /proxy?url=<url>`（或 `GET /<host>/<path>`），支持 `emoji`、
`avatar`、`static`、`preview`、`badge`、`fallback` 查询参数，详见
[`spec/`](./spec/README.md)（日文原文；另有中文/英文翻译）。

## 更新依赖

```fish
bun update --latest
bun run typecheck
bun test
```

当 `bun.lock` 变化时，把 `nix/misskey-media-proxy.nix` 里 `bunDeps` 的
`outputHash` 置为 `lib.fakeHash`，运行 `nix build`，再从报错信息里复制正确的哈希。

## 许可证

AGPL-3.0-or-later，见 [`LICENSE`](./LICENSE)。原始工作由 syuilo 和 tamaina 完成。
