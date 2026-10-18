import type { AppModel } from './core/model';
import type { Language } from '../shared/types';
import './voice-diagnostics.css';

const copy = {
  zh: {
    starting: '正在检查麦克风输入…', ready: '麦克风已接通，说完后稍停片刻即可', hearing: '听到你的声音了', quiet: '暂时没有收到明显声音；说话时看看下方音量条是否移动',
    interrupted: '麦克风输入暂时中断', error: '麦克风未接通，请重新连接', unclear: '刚才没听清，可以再说一次', idle: '现在是文字交流，随时可以接通麦克风', muted: '麦克风已关闭',
    processing: '已收到声音，正在理解你的话', meter: '麦克风输入音量', help: '麦克风没有反应？', retry: '重新连接麦克风', connect: '接通麦克风',
    device: '当前麦克风', helpText: '说话时音量条应当移动。如果不移动，请打开电脑的声音输入设置，确认默认麦克风能收到声音；再检查 Chrome / Edge 地址栏的网站麦克风权限和系统的浏览器麦克风权限。修改后点击重新连接。使用耳机可以减少回声。',
  },
  en: {
    starting: 'Checking microphone input…', ready: 'Microphone connected. Pause briefly when you finish speaking.', hearing: 'Your voice is coming through', quiet: 'No clear input yet. Check whether the level moves when you speak.',
    interrupted: 'Microphone input was interrupted', error: 'Microphone is disconnected. Please reconnect.', unclear: 'That was not clear. You can say it again.', idle: 'You are using text. You can connect your microphone anytime.', muted: 'Microphone muted',
    processing: 'Audio received. Taking in your words.', meter: 'Microphone input level', help: 'Microphone not responding?', retry: 'Reconnect microphone', connect: 'Connect microphone',
    device: 'Current microphone', helpText: 'The level should move as you speak. If it does not, check the default microphone in your computer’s sound input settings. Then check microphone permissions in the Chrome / Edge address bar and your system’s browser permissions. Reconnect after changing settings. Headphones can reduce echo.',
  },
  ko: {
    starting: '마이크 입력을 확인하고 있어요…', ready: '마이크가 연결됐어요. 말을 마친 뒤 잠시 기다려 주세요.', hearing: '목소리가 들려요', quiet: '아직 뚜렷한 소리가 들어오지 않아요. 말할 때 음량 막대가 움직이는지 확인해 주세요.',
    interrupted: '마이크 입력이 잠시 끊겼어요', error: '마이크가 연결되지 않았어요. 다시 연결해 주세요.', unclear: '방금 말씀을 잘 듣지 못했어요. 다시 말해 주세요.', idle: '지금은 글로 대화 중이에요. 언제든 마이크를 연결할 수 있어요.', muted: '마이크가 꺼져 있어요',
    processing: '음성을 받았어요. 말씀을 이해하고 있어요.', meter: '마이크 입력 음량', help: '마이크가 반응하지 않나요?', retry: '마이크 다시 연결', connect: '마이크 연결',
    device: '현재 마이크', helpText: '말할 때 음량 막대가 움직여야 해요. 움직이지 않으면 컴퓨터의 소리 입력 설정에서 기본 마이크가 소리를 받는지 확인해 주세요. Chrome / Edge 주소창의 사이트 마이크 권한과 운영체제의 브라우저 마이크 권한도 확인한 후 다시 연결해 주세요. 이어폰을 사용하면 울림을 줄일 수 있어요.',
  },
} satisfies Record<Language, Record<string, string>>;

/** Reports actual local capture health. It never records or uploads diagnostic audio. */
export default function VoiceDiagnostics({ model, active }: { model: AppModel; active: boolean }) {
  if (!active) return null;
  const t = copy[model.settings.language];
  const state = model.microphone.status;
  const starting = state === 'starting' || model.status === 'connecting';
  const needsConnection = state === 'idle' || state === 'error';
  const warning = ['quiet', 'interrupted', 'error', 'unclear'].includes(state);
  const label = state === 'idle' ? t.idle : model.muted ? t.muted : ['transcribing', 'thinking'].includes(model.status) ? t.processing : t[state];
  const level = model.muted || needsConnection || state === 'interrupted' ? 0 : Math.min(1, Math.max(0, model.level || 0));
  return <div className={`voice-diagnostics${warning ? ' has-warning' : ''}`}>
    <p className="voice-input-status" role="status">{label}</p>
    {!needsConnection && <meter className="voice-input-meter" aria-label={t.meter} min={0} max={1} value={level} />}
    {needsConnection && <button className="text-button" disabled={starting} onClick={() => void model.restartMicrophone()}>{state === 'idle' ? t.connect : t.retry}</button>}
    <details className="voice-input-help">
      <summary>{t.help}</summary>
      {model.microphone.deviceLabel && <p className="voice-input-device">{t.device}: {model.microphone.deviceLabel}</p>}
      <p>{t.helpText}</p>
      {!needsConnection && <button className="text-button" disabled={starting} onClick={() => void model.restartMicrophone()}>{t.retry}</button>}
    </details>
  </div>;
}
