# WhiteMood 独立 Cloudflare 部署

此部署使用团队自己的 Cloudflare 账户、Pages、Workers 和 D1，不依赖 `chatgpt.site` 访问入口。用户仍使用 WhiteMood 自己的 ID 与密码；不会出现 ChatGPT 登录。现有 Sites 部署和 `.openai/hosting.json` 保留，两个部署有各自独立的数据库和密钥。

公开入口：[https://whitemood-yuri.pages.dev](https://whitemood-yuri.pages.dev)，对应已创建的独立 Pages 项目 `whitemood-yuri`。Pages 通过私有 `WHITEMOOD_APP` service binding 调用 `whitemood` Worker，浏览器始终留在 WhiteMood 域名，无须跳转后端 Worker 的账户子域名。

2026-10-19 已完成首次 Pages 发布，Cloudflare 返回的部署地址为 [53d3072a.whitemood-yuri.pages.dev](https://53d3072a.whitemood-yuri.pages.dev)，公开入口仍统一使用上面的正式域名。Worker 的 `SITE_ORIGIN` 已更新为正式 Pages origin；接口及浏览器验收结果单独记录在 [验收记录](docs/ACCEPTANCE.md)，发布成功本身不等于完成全部实机验收。

2026-10-19 已将原站的 2 个账号记录迁入独立 D1，保留账号 ID 和原有密码哈希，用户继续使用原密码。会话 Cookie 和浏览器里的心理状态记录受域名隔离，需要在新域名重新登录；旧域名的本地记录不会自动出现在新域名。

## 1. 准备账户与数据库

使用 Node.js 24 和项目锁定的 pnpm。Wrangler 必须已登录拥有 Workers 和 D1 权限的账户。`wrangler.cloudflare.jsonc` 的 `account_id` 是团队账户的公开标识，不是密钥；换账户时需同时修改。

```sh
pnpm install --frozen-lockfile
pnpm exec wrangler whoami
```

当前配置已指向数据库 `whitemood`，ID 为 `83e99adf-87da-4bc5-a090-b52a94cea673`，后续发布复用它，不再创建同名数据库。仅在另建隔离环境时运行 `pnpm exec wrangler d1 create 新数据库名称`，并保存返回的真实 ID。准备脚本会拒绝缺失、格式错误和 Sites 占位数据库 ID；数据库 ID 本身不是密钥。

## 2. 构建与生成独立配置

```sh
pnpm typecheck
pnpm test
pnpm build
node scripts/prepare-cloudflare.mjs
```

脚本默认使用源配置中的现有数据库。隔离环境可通过 `WM_CLOUDFLARE_DATABASE_ID` 或 `--database-id 实际数据库UUID` 覆盖；数据库另取名称时加上 `--database-name 实际名称`。

脚本从 Vinext 生成的 `dist/server/wrangler.json` 提取必要构建设置，输出 `dist/cloudflare/wrangler.json`，将入口及静态资源路径正确指向 `../server/index.js` 和 `../client`，并将资源绑定为 `ASSETS`，供经 service binding 到达 Worker 的静态资源请求使用。输出目录不复制源代码、不写密钥，也不修改 Sites 部署标识。每次重新构建后必须重新运行准备脚本；后续 Worker Wrangler 命令均明确指定生成的独立配置。

独立配置绑定私有 `PASSWORD_HASHER` → `PasswordHasher` Durable Object，并保留 `v1-password-hasher` 的 `new_sqlite_classes` 迁移。SQLite 后端可用于 Workers Free；该迁移随 Worker 发布自动创建类命名空间，与下面 D1 的 SQL 迁移分开。脚本只接受这一已知的 DO 绑定和迁移，拒绝额外服务或冲突迁移。`REQUIRE_PASSWORD_HASHER="true"` 是非密钥的安全策略：绑定缺失时账号哈希操作应失败关闭，不回退到受 10 ms CPU 限制的普通 Worker。

## 3. 初始化真实 D1 表

以下命令仅供全新数据库首次初始化；当前正式数据库已建表并迁入账号，先检查其迁移历史，不能直接重复初始化：

```sh
pnpm exec wrangler d1 migrations apply DB --remote --config dist/cloudflare/wrangler.json
```

`migrations_dir` 指向仓库的 `drizzle` 目录。迁移包含共享限流表 `wm_request_limits`、账号表 `wm_accounts` 和登录会话表 `wm_account_sessions`。正式数据库已有表时，应先检查迁移历史和备份，不能重复手动执行建表 SQL。心理状态记录和对话记忆目前按账号隔离保存在用户当前浏览器的 IndexedDB，不会因此迁移到 D1，也不会自动同步旧域名的浏览器记录。

## 4. 配置服务端密钥并部署

API 密钥只能在 Cloudflare 的加密 secrets 中保存。使用以下交互式命令，在隐藏输入提示中粘贴值，不把密钥放进参数、Git 文件或命令历史：

```sh
pnpm exec wrangler secret put GROQ_API_KEY --config dist/cloudflare/wrangler.json
pnpm exec wrangler secret put SESSION_SECRET --config dist/cloudflare/wrangler.json
pnpm exec wrangler secret put SITE_ORIGIN --config dist/cloudflare/wrangler.json
pnpm exec wrangler deploy --config dist/cloudflare/wrangler.json
```

`SESSION_SECRET` 使用密码学随机生成的至少 32 字节值。`SITE_ORIGIN` 设置为 `https://whitemood-yuri.pages.dev`，不加末尾 `/`。正式域名变更后同步更新该项。Groq 默认模型为 `openai/gpt-oss-120b` 和 `whisper-large-v3-turbo`；如需更换，可在服务端配置 `GROQ_CHAT_MODEL`、`GROQ_STT_MODEL`。没有付费 AI 自动回退。现有 Worker 的密钥已经设置时，常规代码发布无需重新输入或轮换它们。Pages 只持有内部服务绑定，不复制 Groq 密钥或会话签名密钥。

首次 Worker 尚未存在时，`secret put` 可能提示创建 Worker；按真实目标名称完成初始化后再发布。可先执行 `wrangler deploy --dry-run --config dist/cloudflare/wrangler.json` 验证构建和资源打包，该命令不会发布站点。

## 5. 域名、访问与验收

`cloudflare-pages/wrangler.jsonc` 单独声明品牌项目和私有 `WHITEMOOD_APP` → `whitemood` 绑定。`public/_worker.js` 原样传递请求及响应，保留请求体、公开 origin、Cookie 和流式响应；绑定缺失或调用失败时返回 503，不以假页面遮盖服务问题。`_routes.json` 让全部路径经过真实应用。此目录没有假的静态首页，也没有前端写死的后端域名。

当前 Pages 项目已创建且 OAuth 权限已补齐。后续发布直接复用它：

```sh
pnpm run deploy:pages
```

应用或 API 代码变更时先重新构建并发布 Worker；只有 Pages 代理或其服务绑定配置变更时，才需要重新发布 Pages。两者分开发布，不会将旧 Sites 环境同步覆盖。

`scripts/deploy-pages.mjs` 将 Pages 配置和 `public/` 原样复制到仓库外的临时目录，从该目录运行项目已安装的 Wrangler，并在完成或失败后清理临时副本。这避开 Vinext 生成的祖先 `.wrangler/deploy/config.json` 被误用于 Pages 的发现问题；仅用 `--cwd cloudflare-pages` 仍会遇到此冲突。脚本继承真实账号登录环境、原样显示发布结果，不创建项目，也不读取或写入密钥。

Pages 配置不接受 `account_id` 字段，因此该值不写入 Pages 的 Wrangler 文件。脚本在 `CLOUDFLARE_ACCOUNT_ID` 未设置时，默认使用团队账户 `0e8e7f0429306f575ea08b61a74dfc87`；已有环境值优先。此账户标识不是密钥，实际访问权限仍由真实 Wrangler 登录凭据决定。

不能拿 Worker 的 `dist/cloudflare/wrangler.json` 部署 Pages。另建环境时，需要先创建独立的 Pages 项目，更新 Pages 配置和 `SITE_ORIGIN`，并使用创建结果提供的真实域名。若已有团队自己的托管域名，也可以在 Pages 的 Custom domains 添加后更新 `SITE_ORIGIN`；不要改动其他现有项目的 DNS 或账户级 Worker 子域名。

独立部署可去除 `chatgpt.site` 域名依赖，但无法据此保证中国大陆所有运营商和网络都能稳定访问 Cloudflare 或 Groq。需要用目标地区的真实网络测试首页、注册登录、语音识别和回复。不要把韩国网络上的成功测试写成中国大陆可用的证明。

发布后至少验证：注册、重复 ID、错误密码、刷新恢复登录、退出后 API 拒绝访问、账号修改、麦克风输入、停顿后转写和语音回复；同时查看 Cloudflare 实际调用日志中的错误与 CPU 时间。测试账号应使用专用测试 ID，不能把测试对话混入真实用户记录。

## 运行额度与密码哈希

截至 2026-10-19，Workers Free 普通 HTTP 请求 CPU 上限为 10 ms；实际注册及登录测试已重复触发 Error 1102。`node:crypto` 支持原生 `scrypt`，但异步调用并没有解决此部署的 CPU 限制。WhiteMood 将耗时哈希移到私有 SQLite Durable Object，保留原 `N=32768, r=8, p=3` 参数；普通 Worker 等待内部调用结果，不在自身调用中计算 scrypt。原密码哈希格式不变，迁入账号无需重置密码。

Cloudflare 官方列出 SQLite Durable Object 默认每次调用有 30 秒 CPU 时间，Free 支持此后端。Free 额度仍有限制，超过额度会失败，不能据此承诺无限免费。准备脚本不切换付费计划，不设置付费 CPU 参数。发布后继续用实际注册、登录和密码修改验证，并在日志中检查普通 Worker 与 DO 的异常和 CPU 时间。

官方依据：

- [Workers 运行限制](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers 的 node:crypto 支持](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)
- [Durable Objects CPU 与后端限制](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Durable Objects 免费额度](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [D1 迁移](https://developers.cloudflare.com/d1/reference/migrations/)
- [Pages Advanced mode](https://developers.cloudflare.com/pages/functions/advanced-mode/)
- [Pages Wrangler 配置](https://developers.cloudflare.com/pages/functions/wrangler-configuration/)

## 构建依赖说明

当前构建保留 Sites 插件以维持原部署。生产构建中该插件仅将部署元数据和迁移复制到 `dist/.openai`，本配置不会上传该目录。预览连接器服务只在开发模式注入；生产 Worker 不需要 OpenAI connector 绑定。所有 `/api` 请求由 WhiteMood 自有账号和 Groq API 处理，页面经 Vinext 渲染。仓库中未被页面导入的 `app/chatgpt-auth.ts` 是旧脚手架辅助模块，不构成线上认证入口。
