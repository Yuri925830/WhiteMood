# WhiteMood 混合多模态框架

WhiteMood 保留现有 Next/Cloudflare 主应用，并增加一个可选 FastAPI 分析服务。主链路仍由 Groq Whisper 转写；声学特征和面部表情分类在自托管 Python 服务中完成。任何本地模块失败都不会阻断转写、文字输入或 AI 回复。

## 1. 当前架构

```text
浏览器
  ├─ AudioWorklet：16 kHz 单声道 PCM WAV + 浏览器 VAD 兜底特征
  └─ 用户选择 2–5 张图片：去元数据并缩放为不超过 320×240 的 JPEG
          │
          ▼
WhiteMood /api/transcribe
  ├─ Groq Whisper：只接收 WAV，返回 transcript
  └─ FastAPI /v1/analyze/turn：接收 WAV + 可选帧
       ├─ librosa + Silero VAD：能量、发声比例、停顿、基频
       └─ OpenCV 人脸检测 + EmotiEffLib：AffectNet 表情概率
          │
          ▼
统一 TranscriptionResult（每模块 status / latency / confidence）
          │
          ▼
LLM 融合决策 → 浏览器 TTS
```

`src/integrations/image.ts` 负责一次性图片选择后的预处理和内存队列；`services/analysis/` 才负责模型推理。原始音频、所选图片和推理结果均不写入 WhiteMood 数据库。当前版本明确禁用网页摄像头权限，实时摄像头采集留待后续实现。

## 2. 启动

建议使用 Python 3.10+：

```bash
python3.10 -m venv .venv-analysis
source .venv-analysis/bin/activate
pip install -r services/analysis/requirements-gpu-cu118.txt

export WHITEMOOD_ANALYSIS_TOKEN="生成的随机长字符串"
python -m services.analysis
```

主应用使用相同令牌：

```bash
cp .env.example .env.local
# 编辑 .env.local：
# ANALYSIS_API_URL=http://127.0.0.1:8790
# ANALYSIS_API_TOKEN=与上面相同的值
pnpm dev
```

FastAPI 默认只绑定 `127.0.0.1:8790`，且关闭访问日志。未配置 `ANALYSIS_API_URL` 时，现有语音功能保持原样，页面不显示面部图片入口。生产环境如将分析服务放在另一台主机，必须使用 HTTPS、设置服务令牌并自行控制网络访问；这时不能再声称图像没有离开用户设备。

## 3. 接口

Python 服务提供：

| 接口 | 输入 | 用途 |
| --- | --- | --- |
| `GET /health` | 无 | 检查依赖包是否存在，不主动加载权重 |
| `POST /v1/analyze/audio` | 一个 PCM16 mono WAV | 单独验证声学模块 |
| `POST /v1/analyze/faces` | 2–5 张 JPEG | 单独验证表情模块 |
| `POST /v1/analyze/turn` | WAV + 可选 2–5 张 JPEG | 主应用实际使用的并行编排接口 |

设置 `WHITEMOOD_ANALYSIS_TOKEN` 后，所有接口都要求 `X-WhiteMood-Analysis-Token`。服务不会在错误响应中返回模型路径、原始输入或内部异常。

主应用返回值：

```ts
interface TranscriptionResult {
  text: string;
  voice?: VoiceSignals;
  cv?: CvObservation;
  analysis?: {
    modules: {
      stt: AnalysisModuleStatus;
      acoustics: AnalysisModuleStatus;
      face: AnalysisModuleStatus;
    };
  };
}
```

模块状态为 `ok | skipped | unavailable | error`。`skipped` 表示本轮没有相应输入或没有检测到可用结果；`unavailable` 表示服务或依赖不可用；两者都不是负面情绪证据。

## 4. 声学字段

FastAPI 使用 Silero VAD 获取发声区间，并用 librosa 提取 RMS 与 pYIN 基频：

| 字段 | 含义 |
| --- | --- |
| `durationMs` | 本轮 WAV 时长 |
| `voicedRatio` | Silero 判定的发声样本比例 |
| `meanEnergy` / `peakEnergy` | 归一化 PCM 的 RMS 能量 |
| `pauseCount` | 相邻发声段间至少 150 ms 的停顿数 |
| `pauseDurationMs` / `maxPauseMs` | 停顿总时长与最长停顿 |
| `pitchMeanHz` / `pitchRangeHz` / `pitchStdHz` | 有声 pYIN 帧的基频统计；无法可靠估计时省略 |
| `quality` | 输入覆盖度、发声比例和信号能量形成的可用性指标 |

这些字段不是 Angry/Sad/Happy 概率，也不是疾病或发作评分。浏览器原有能量/VAD 值仍作为分析服务失效时的回退。

## 5. 面部字段

浏览器只有在通话中由用户主动选择图片后才准备面部输入，不申请摄像头权限。一次必须选择 2–5 张 JPG、PNG 或 WebP，单张源文件不超过 10 MiB；浏览器解码后去除元数据并缩放为不超过 320×240、256 KiB 的 JPEG。图片只在内存等待下一次语音话轮，提交后立即从前端队列清空；若结束通话、替换或主动清除，也会直接丢弃。

服务先用 OpenCV Haar 检测最大正脸，再把裁剪后的人脸送给 EmotiEffLib `enet_b0_8_best_afew` PyTorch 模型，并默认在本机 CUDA GPU 上推理。各帧概率取均值，名称为：

```text
expression_anger, expression_contempt, expression_disgust, expression_fear,
expression_happiness, expression_neutral, expression_sadness, expression_surprise
```

`quality` 只反映检测成功帧比例与人脸在画面中的相对大小，不代表分类准确率。少于 50% 质量的结果在进入 LLM 前被丢弃。无人脸、遮挡或模型失败时不生成全零值、固定值或随机替代值。

## 6. 失败隔离与安全边界

- Groq 只收到 WAV；JPEG 只发给配置的分析服务。
- FastAPI 的声学与表情任务并行执行并分别捕获失败。
- 分析服务离线时，`/api/transcribe` 仍返回成功 transcript；控制器使用浏览器声学兜底并省略 CV。
- 请求只接受最多 8 MiB 的合规 WAV、最多 5 张且每张不超过 256 KiB 的 JPEG；提交时间必须贴近当前话轮。
- 通话结束、清除、替换、页面卸载或图片处理中止，都会清空当前图片队列；迟到的异步解码结果不会重新写回。
- 表情与声学数据只作为非诊断弱线索。系统提示明确要求优先相信用户自述，禁止据此诊断躁狂、抑郁或双相发作。

## 7. 验证

```bash
pnpm test
pnpm typecheck
pnpm build
python3 -m unittest discover -s services/analysis/tests -v
```

官方模型权重已放在 `services/analysis/models/` 并链接到 EmotiEffLib 缓存；部署时应核对校验和、许可证、CUDA 可用性和 GPU 延迟。默认配置不会在 CUDA 不可用时静默回退到 CPU。当前上传图片仅与下一次完整语音话轮关联，不是严格逐帧音画对齐，也不能证明对真实人物图片或临床场景具有官方数据集报告的准确率。
