# WhiteMood 语音陪伴

正式入口：[https://whitemood-yuri.pages.dev](https://whitemood-yuri.pages.dev)。

Cloudflare 部署说明：[DEPLOY_CLOUDFLARE.md](DEPLOY_CLOUDFLARE.md)。

本站使用 Cloudflare Workers、D1 与 WhiteMood 自有账号系统。Pages 提供独立免费入口，通过私有服务绑定接入应用。以云朵为 AI 形象，采用浅蓝与白色的原生 React 界面；CV 仍由张博士负责。

## 部署运行

- 独立生产环境的密钥保存在 Cloudflare `whitemood` Worker 的加密 secrets 中，不在源文件、本地构建、Pages 代理或网页中。旧 Sites 环境保留自己的独立配置。
- `GROQ_API_KEY`：Groq 服务端密钥。
- `SITE_ORIGIN`：本站唯一 HTTPS origin，无结尾斜杠。
- `SESSION_SECRET`：服务端匿名 cookie 签名密钥，随机生成后保存在 runtime secret。
- `GROQ_CHAT_MODEL` / `GROQ_STT_MODEL`：可选模型 ID。
- 无需 ChatGPT 账号。只用 ID 和密码注册；ID 不区分大小写，数据库唯一约束防止并发重名。
- 密码使用独立随机盐和 native scrypt（N=32768、r=8、p=3）哈希；数据库不保存明文密码。独立 Cloudflare 版本通过私有 Durable Object 执行计算，适配免费 Worker 的 CPU 限制，未降低哈希安全参数。
- 账户设置可验证当前密码后修改 ID 或密码；保持 UUID，并撤销旧会话、签发当前新会话。
- 登录使用 12 小时 HttpOnly、Secure、SameSite Cookie，数据库只保存令牌哈希。退出即时撤销当前会话。
- AI 接口逐次验证 WhiteMood 登录，D1 保存账号/全站的窗口调用次数；不保存音频、对话文字或 IP。
- 全站限额为每分钟 12 次、每日 200 次 AI 请求；单账号每分钟 10 次、每日 80 次。转写、回应与摘要分别计数；服务商自身限额仍有效。
- 记忆与记忆同意设置按稳定账号 UUID 在当前浏览器中隔离，不做跨设备同步。退出后通话卸载，停止麦克风。新域名有独立的浏览器存储，不自动迁移旧 Sites 域名或 localhost 的对话与状态记录。

本地构建与测试需要 Node 24 和 pnpm 11.25.0：

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
```

独立发布分两部分：应用构建后由 `scripts/prepare-cloudflare.mjs` 生成 Worker 配置，发布到 `whitemood` Worker；`pnpm run deploy:pages` 只发布 `cloudflare-pages/` 品牌入口代理，通过私有 `WHITEMOOD_APP` 绑定调用应用，保留请求 origin、Cookie 和请求体。真实静态资源由 Worker 的 `ASSETS` 绑定提供，密码哈希由私有 SQLite Durable Object 执行。完整步骤见 [Cloudflare 部署说明](DEPLOY_CLOUDFLARE.md)。

原 Sites 部署可继续使用其官方 source/build helper，保留 `build/sites-vite-plugin.ts` 与 `build/sites-worker.ts`。`server/hosted.ts` 复用标准 Fetch API；`server/index.ts` 仅为原本地 Node 适配器，不在独立生产环境运行。两个部署的发布配置、数据库和 secrets 独立，不能相互替换。

`pnpm dev` 提供本地框架预览，未启用模拟登录。网站直接公开展示自己的 ID/密码注册与登录页，不跳转 ChatGPT。Groq 调用仍受账号免费额度影响，无付费自动回退。

## 侧边栏与录音反馈

- 侧边栏包含语音陪伴、状态记录、记忆与隐私、账户设置。手机使用原生 dialog 抽屉，桌面固定展示。
- 状态记录显示真实保存的对话摘要、自述、偏好、后续话题及来源原文，不生成诊断分数或虚构趋势。默认不保存，开启记忆后才整理。
- 实际 PCM 驱动麦克风音量条和连接状态；静音、未收到输入、处理器停滞和系统中断分别提示，支持重新连接。
- 低音量与持续环境噪声均纳入 VAD 回归；先发文字后可真正接通麦克风并继续同一对话。

## 产品及模块说明

## 已实现的链路

1. AudioWorklet 持续采集，浏览器本地 VAD 自动分段，输出完整 16 kHz、单声道 PCM WAV。
2. Groq `whisper-large-v3-turbo` 转写中英韩；本地计算能量、有效发声比例与时长。
3. Groq `openai/gpt-oss-120b` 结合说话内容、近期上下文、授权记忆和可用辅助信号，返回回复及语音配置。
4. 浏览器 `speechSynthesis` 自动选择目标语言声音，优先本地；调节语速、音高与句间停顿，继续监听。
5. 用户插话时取消旧请求和播音。上下文只引用实际播完的句子；过期网络与麦克风回调不会污染新通话。

首版是按话轮处理的连续通话，不保证任何外放设备上的人类级全双工表现。声音线索是辅助观测，不是情绪概率、发作诊断或临床评分；当前未提取可靠基频、语速或训练情绪识别模型。

## 后台记忆

- 默认关闭。用户明确开启后，每轮写入当前浏览器 IndexedDB，挂断后自动摘要；下次通话检索少量相关记忆。
- 记录用户自述、明确偏好和事件，并保留来源。面部或声音推测不写成患者事实。
- 页面开启时检查待补摘要和每日整合；浏览器关闭期间不运行定时任务。离开后重新打开会恢复未完成记录。
- 长会话按真实话轮分块摘要。当前页面保留已成功分块，失败后重试从未完成块继续；刷新页面后会重新计算分块摘要。极长单话轮仍可能超过账号额度，保留完整原文并显示失败，不截断成假记录。
- 每日整合对请求的 UTF-8 字节数设预算；只替换本次实际提供的既有记忆，未送入的条目和范围外来源继续保留。
- 可编辑、删除记忆及来源会话。删除记录使用版本和来源约束，避免迟到任务、旧摘要或改写条目将其恢复。
- 关闭记忆后停止后续保存和历史引用；旧记录仍可在“记忆与隐私”中查看或删除。
- 可直接说“不要保存这次通话”“don't save this call”“이번 통화는 저장하지 마세요”，删除已保存的当前通话，并停止保存本次剩余内容。其他涉及具体事实的遗忘要求请通过记忆管理执行，避免误删。

记忆按登录账号在此浏览器、此网站来源中隔离，不跨设备同步；云端账号数据库不保存对话记录。清除浏览器站点数据会丢失本地记忆。浏览器本地存储并非加密保险箱，拥有该浏览器或设备管理权限的人仍可能读取站点数据。

## 数据与免费额度

应用自身不长期保存原始录音，不采集视频。音频发往 Groq 转写；文字、近期上下文及用户授权的相关记忆发往 Groq 生成。系统“联网”声音可能将 AI 回复文字发给操作系统语音服务商；优先本地声音并不代表所有设备都离线。

使用自己账号的免费额度，没有付费自动回退。免费额度、模型和账号可用性以服务商控制台为准，连续通话、长摘要和整合都可能触发限额。应用显示真实 429/网络错误并保留已授权的本地记录。部署前核实账号的数据保留控制；代码不能替用户启用或保证服务商零留存。

官方资料（2026-10-18 核对）：[限额](https://console.groq.com/docs/rate-limits)、[模型](https://console.groq.com/docs/models)、[结构化输出](https://console.groq.com/docs/structured-outputs)、[数据控制](https://console.groq.com/docs/your-data)。

## 分工与代码位置

| 位置 | 职责 |
| --- | --- |
| `src/audio/`、`public/audio/` | 麦克风、VAD、WAV、播音与打断 |
| `src/core/` | 通话生命周期、取消、上下文与后台任务 |
| `src/memory/` | 本地记录、摘要、检索及删除约束 |
| `server/` | 服务端密钥、Groq 调用、输入校验、限额和同源检查 |
| `src/App.tsx`、`src/i18n.ts` | 原生网页组件与三语界面 |
| `src/integrations/cv.ts` | 张博士的 CV 接入边界 |

张博士从 [CV 接入说明](docs/CV_HANDOFF.md) 开始；无需改录音与播音模块。当前只取最近有效观测，尚未实现严格音画时序对齐。

