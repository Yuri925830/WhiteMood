# WhiteMood：CV 模块交接说明

本文面向张博士，说明怎样把真实的本地面部观测接入现有语音 MVP。接口依据 `src/integrations/cv.ts`、`shared/types.ts`、`src/core/controller.ts` 与 `src/App.tsx` 的当前实现。

**当前 MVP 只实现语音、文本、回应、语音播放与会话记忆，没有附带 CV 模型、摄像头采集或模拟的面部数据。** `src/integrations/cv.ts` 是接入边界；没有注册适配器时，“记忆与隐私”弹窗完全不显示“面部线索”开关。语音与文字功能可以独立运行。

## 1. 分工与接入位置

- 语音负责人：录音、语音活动检测、转写、话轮与打断、LLM 回应、TTS、会话存储。
- CV 负责人：摄像头的独立授权、真实视频采集、本地模型、检测质量、特征定义及归一化、性能与资源释放。
- 共享契约：`CvObservation` 和 `CvAdapter`。无需修改语音采集代码，也不要为“接通流程”生成假的表情或情绪分数。

注册一个真实 `CvAdapter` 后，页面通过 `subscribeCvAdapter()` 感知它，`cvAvailable` 才变为 `true`。通话过程中，用户在“记忆与隐私”弹窗明确开启“面部线索”，控制器才调用 `adapter.start()`。注册本身不能申请摄像头权限或启动采集。

## 2. 对外接口

```ts
// shared/types.ts
export interface CvObservation {
  source: 'face';
  capturedAt: number;
  quality: number;
  features: Record<string, number>;
}

// src/integrations/cv.ts
export interface CvAdapter {
  start(context: {
    signal: AbortSignal;
    onObservation: (value: CvObservation) => void;
  }): Promise<void>;
  stop(): void | Promise<void>;
}

export function registerCvAdapter(adapter: CvAdapter): () => void;
export function getCvAdapter(): CvAdapter | null;
export function subscribeCvAdapter(fn: () => void): () => void;
export function recentCvObservation(
  value: CvObservation | null,
  now?: number,
): CvObservation | undefined;
```

`registerCvAdapter()` 同时只允许一个适配器；重复注册会抛错。返回值是注销函数：注销时调用 `stop()`、移除适配器并通知订阅者。页面卸载、模块热更新或替换实现时应注销。

`start()` 的 Promise 应在摄像头和推理循环准备好后完成，不能等到整次通话结束才完成。持续观测通过 `onObservation()` 提交。

## 3. 字段约束和过滤行为

控制器调用 `recentCvObservation()` 后才把观测作为 `RespondRequest.cv` 传入回应接口。当前过滤规则如下：

| 字段 | 当前要求 |
| --- | --- |
| `source` | 必须严格等于 `'face'`。 |
| `capturedAt` | 有限数值；使用采样时刻的 `Date.now()`，单位为毫秒。超过 10,000 ms 的观测丢弃；比当前时间超前 1,000 ms 以上也丢弃。不要使用 `performance.now()`。 |
| `quality` | 有限数值，范围为 `0.5 ≤ quality ≤ 1`，低于 0.5 或超过 1 的整条观测丢弃。 |
| 特征名称 | 正则为 `/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/`：以英文字母开头，最多 48 个字符，仅可含英文字母、数字、下划线。 |
| 特征值 | 有限数值，范围为 `[0, 1]`。NaN、Infinity、负值、超过 1 的值均被移除。 |
| 特征数量 | 过滤后最多保留前 32 项；没有有效特征时，整条观测丢弃。 |

`quality` 表示视觉观测的可用程度，例如人脸可见性、遮挡、姿态或模型检测质量。它不是“情绪正确率”，也不是心理健康得分。具体计算方法由 CV 模块定义，并在模块文档中解释。

`features` 应是有明确含义的面部动作或局部变化，例如模型实际输出并经过定义的 blendshape 系数。不要把没有验证的 `bipolar_score`、`mania_probability` 等诊断结论放进此接口。映射后的名称、范围、方向和归一化方法需要写进 CV 模块说明。

未检测到人脸、质量不足或无法确定时，可以不发送观测。不得用全零、固定值、随机数或样例值冒充本轮真实输入。控制器会在观测超过 10 秒后停止引用它。

## 4. 当前融合方式与限制

当前控制器只保存最新一条 `CvObservation`。发起一次 AI 回应时，若 `cvEnabled` 为 `true`，则读取最新观测、执行上述过滤，并把合格结果放入 `RespondRequest.cv`。没有合格观测时省略 `cv` 字段，语音与文字照常工作。

因此，当前接口是“最近有效视觉线索”，不是逐帧音画同步，也没有自动计算整段用户发言的表情统计。接入后不能宣称已经完成严格的时序对齐或临床情绪识别。若后续需要按用户话轮汇总，双方应再明确起止时间与聚合字段，不能把采集时间改成发送时间来规避过期限制。

现有请求只包含数值化观测，不接收视频帧或人脸截图。现有会话记录也没有用于存储原始视频的字段。保持原始画面在本地；如将来引入远程 CV，需要另行实现清楚的数据说明与独立同意。

## 5. 摄像头同意、启动与释放

实际行为：

1. 没有适配器：不显示 CV 开关，也不打开摄像头。
2. 已注册适配器：显示 CV 开关；未开始通话时开关禁用。
3. 用户在通话中主动开启：`setCvEnabled(true)` 创建 `AbortController`，调用 `adapter.start({ signal, onObservation })`。
4. 启动成功且该通话仍有效：`cvEnabled` 变为 `true`。
5. 用户关闭、通话结束或控制器释放：中止相应 `signal`、清除旧观测，并调用 `stop()`。
6. 启动失败：显示本地化 `cv_error`，不影响语音对话。

CV 模块必须遵守：

- 只有 `start()` 才调用 `getUserMedia({ video: ..., audio: false })`；麦克风由语音模块管理。
- 摄像头权限与麦克风权限分别处理。已有麦克风同意不能代替摄像头同意。
- 收到 `signal.abort`、执行 `stop()` 或发生错误时，停止推理循环并调用所有摄像头 track 的 `stop()`；清空所用 `<video>` 的 `srcObject`。
- `stop()` 可重复调用，不能因重复释放而报错。不要依赖浏览器关闭页面才清理设备。
- `getUserMedia()` 权限弹窗尚未结束时，也可能收到 abort。权限最终返回后仍要检查 signal，立即释放刚获得的 stream，不能让摄像头遗留运行。
- 不得在 abort 后继续 `onObservation()`。异步推理返回时应再次核对该次运行是否仍然有效。
- 如提供视频预览，使用真实 `<video>` 与正常布局；不要使用截图、遮罩或透明热区模拟功能。新增开关、预览及错误说明需补齐中英韩文与无障碍名称。

目前 `CvAdapter` 没有持续运行错误的回调字段。启动后的推理失败，应由 CV 模块清理资源；可由集成层注销该适配器，使页面撤下入口并停止引用旧观测。不能只在控制台报错而继续展示正常采集。若要增加可重试的运行错误状态，先与语音负责人扩展共享契约。

## 6. 接入示例

下列代码是接入结构示例，**不是当前 MVP 已实现的 CV 功能**。`detect()` 必须由张博士提供真实本地检测实现；传入页面中真实的 `<video>` 元素，不生成占位观测。

```ts
import type { CvAdapter } from './integrations/cv';
import { registerCvAdapter } from './integrations/cv';

type Detection = {
  quality: number;
  features: Record<string, number>;
};

export function createCameraAdapter(
  video: HTMLVideoElement,
  detect: (video: HTMLVideoElement) => Promise<Detection | null>,
  onRuntimeError: (error: unknown) => void,
): CvAdapter {
  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let removeAbortListener: (() => void) | undefined;

  function stop() {
    generation++;
    clearTimeout(timer);
    timer = undefined;
    removeAbortListener?.();
    removeAbortListener = undefined;
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    video.pause();
    video.srcObject = null;
  }

  return {
    stop,
    async start({ signal, onObservation }) {
      stop();
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const run = generation;
      signal.addEventListener('abort', stop, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', stop);

      try {
        const acquired = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user' },
          audio: false,
        });
        if (signal.aborted || run !== generation) {
          acquired.getTracks().forEach(track => track.stop());
          throw new DOMException('Aborted', 'AbortError');
        }
        stream = acquired;
        video.srcObject = acquired;
        video.muted = true;
        video.playsInline = true;
        await video.play();
        if (signal.aborted || run !== generation) return;

        async function sample() {
          if (signal.aborted || run !== generation) return;
          try {
            const capturedAt = Date.now();
            const result = await detect(video);
            if (signal.aborted || run !== generation) return;
            if (result) {
              onObservation({
                source: 'face',
                capturedAt,
                quality: result.quality,
                features: result.features,
              });
            }
            // 示例采用低频串行采样；实际频率应按设备性能验证。
            timer = setTimeout(() => { void sample(); }, 250);
          } catch (error) {
            if (signal.aborted || run !== generation) return;
            stop();
            onRuntimeError(error);
          }
        }

        void sample(); // start() 在准备完成后返回，不等待整个采集循环。
      } catch (error) {
        if (run === generation) stop();
        throw error;
      }
    },
  };
}

// 在 CV 模块的真实 UI 挂载时注册；realVideo 与 realDetector 由该模块提供。
// onRuntimeError 是示例工厂的集成回调，不是 CvAdapter 的新增 API。
let unregister = () => {};
const adapter = createCameraAdapter(realVideo, realDetector, error => {
  console.error('CV pipeline stopped', error);
  unregister(); // 清理并通知现有页面：该适配器已不可用。
});
unregister = registerCvAdapter(adapter);

// CV UI 卸载或热更新时调用：
// unregister();
```

调用 `registerCvAdapter()` 不等于调用 `start()`。保留现有隐私开关作为开始采集的明确入口；不要在注册函数后直接启动设备。CV 模块本身还应负责关闭模型实例、worker、图像缓存等资源，上例只展示摄像头生命周期。

## 7. 合流前验收

- 未注册 CV、拒绝摄像头权限、拔出摄像头时，语音与文字仍可使用。
- 注册后不自动亮起摄像头指示灯；主动开启后才亮起，关闭或结束通话后立即熄灭。
- 权限申请中结束通话，最终批准权限后设备也不能遗留运行。
- 无人脸、遮挡、低质量、过期观测时，请求中没有伪造的 `cv`。
- 确认 10 秒有效期、quality 阈值、特征范围、最多 32 项等真实过滤行为。
- 连续开启与关闭、重复 `stop()`、模块卸载、异步推理中断均无资源泄漏或迟到回调。
- 检查网络请求：只发送预期数值特征，不发送视频帧、截图或人脸图像。
- 在实际演示电脑上联合测试摄像头、麦克风、回声处理与 CPU 占用，报告真实限制。

当前接口提供真实融合入口，但未验证其对双相情感障碍的识别效能。面部动作只作为辅助线索；回应仍应优先尊重用户自述与纠正。
