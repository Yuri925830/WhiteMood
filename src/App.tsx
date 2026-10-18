import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { AppModel } from './core/model';
import type { ChatMessage, Language, SessionRecord } from '../shared/types';
import { errorText, languageNames, localeNames, translations } from './i18n';
import './styles.css';

type IconName = 'mic' | 'mic-off' | 'phone' | 'phone-end' | 'memory' | 'close' | 'arrow' | 'text' | 'check' | 'pause' | 'leaf' | 'refresh' | 'chevron' | 'trash' | 'edit';

function Icon({ name, size = 20, ...props }: { name: IconName; size?: number; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    mic: <><rect x="9" y="2.5" width="6" height="12" rx="3" /><path d="M5.5 10.5v1a6.5 6.5 0 0 0 13 0v-1M12 18v3M8.5 21h7" /></>,
    'mic-off': <><path d="M3 3l18 18M9 9v2.5a3 3 0 0 0 5.1 2.1M9.1 5A3 3 0 0 1 15 5.5v5M5.5 10.5v1A6.5 6.5 0 0 0 17 15.65M18.5 10.5v1c0 .45-.05.89-.14 1.31M12 18v3M8.5 21h7" /></>,
    phone: <path d="M8.2 3.8 10 7.4c.3.6.2 1.3-.3 1.7l-1.5 1.4a14.2 14.2 0 0 0 5.3 5.3l1.4-1.5c.4-.5 1.1-.6 1.7-.3l3.6 1.8c.6.3.9.9.8 1.5l-.3 2.5c-.1.7-.7 1.2-1.4 1.2A17.3 17.3 0 0 1 3 4.7c0-.7.5-1.3 1.2-1.4L6.7 3c.6-.1 1.2.2 1.5.8Z" />,
    'phone-end': <path d="M3.5 9.5a17.5 17.5 0 0 1 17 0c.7.4 1 1 .8 1.7l-.7 2.7c-.2.7-.8 1.1-1.5 1l-3-.4a1.3 1.3 0 0 1-1.1-1.3v-2a13.2 13.2 0 0 0-6 0v2c0 .7-.5 1.2-1.1 1.3l-3 .4c-.7.1-1.3-.3-1.5-1l-.7-2.7c-.2-.7.1-1.3.8-1.7Z" />,
    memory: <><path d="M5 4.5h13.5A1.5 1.5 0 0 1 20 6v15l-4-2-4 2-4-2-4 2V6a1.5 1.5 0 0 1 1-1.5ZM8 2.5v4M15.5 2.5v4M8 10h8M8 14h5" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    arrow: <><path d="m5 12 14 0m-5-5 5 5-5 5" /></>,
    text: <><rect x="3" y="4" width="18" height="14" rx="3" /><path d="m7 18-2 3M7 9h10M7 13h6" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    pause: <><path d="M9 5v14M15 5v14" /></>,
    leaf: <><path d="M19.5 4.5C10 2 3.2 6.5 5.5 14c2 6.5 12.5 5.5 14-9.5ZM5 20l9-10" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5M19.5 11A7.5 7.5 0 0 0 6 6.5L4 9M4.5 13A7.5 7.5 0 0 0 18 17.5l2-2.5" /></>,
    chevron: <path d="m8 10 4 4 4-4" />,
    trash: <><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" /></>,
    edit: <><path d="m15 4 5 5M4 20l5-1L21 7l-4-4L5 15l-1 5Z" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}

function BrandMark() {
  return <svg className="brand-mark" viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M20 20C10 21 6 15 9 10c4-6 11-2 11 10Z" fill="currentColor" opacity=".8"/><path d="M20 20C19 10 25 6 30 9c6 4 2 11-10 11Z" fill="currentColor"/><path d="M20 20c10-1 14 5 11 10-4 6-11 2-11-10Z" fill="currentColor" opacity=".65"/><path d="M20 20c1 10-5 14-10 11-6-4-2-11 10-11Z" fill="currentColor" opacity=".9"/></svg>;
}

function Modal({ title, eyebrow, children, onClose, closeLabel, wide = false }: { title: string; eyebrow: string; children: ReactNode; onClose: () => void; closeLabel: string; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} onClose={onClose} aria-labelledby="modal-title">
    <div className="modal-heading"><div><span className="eyebrow">{eyebrow}</span><h2 id="modal-title">{title}</h2></div><button className="icon-button" onClick={onClose} aria-label={closeLabel}><Icon name="close" /></button></div>
    {children}
  </dialog>;
}

function MessageList({ messages, language, compact = false }: { messages: ChatMessage[]; language: Language; compact?: boolean }) {
  const t = translations[language];
  const last = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!compact) last.current?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }, [messages.length, compact]);
  return <div className={`messages ${compact ? 'messages-compact' : ''}`} role="log" aria-label={t.captions} aria-live={compact ? 'off' : 'polite'} aria-relevant="additions text">
    {messages.length === 0 ? <div className="transcript-empty"><Icon name="text" size={28} /><p>{compact ? t.noMessages : t.textEmpty}</p></div> : messages.map(message => <article className={`message message-${message.role}`} key={message.id}>
      <div className="message-meta"><span>{message.role === 'assistant' ? t.assistant : t.you}</span><time dateTime={new Date(message.timestamp).toISOString()}>{new Intl.DateTimeFormat(localeNames[language], { hour: '2-digit', minute: '2-digit' }).format(message.timestamp)}</time></div>
      <p>{message.text}</p>{message.interrupted && <span className="interrupted-note"><Icon name="pause" size={12} />{t.interrupted}</span>}
    </article>)}
    <div ref={last} />
  </div>;
}

function SessionCard({ session, model }: { session: SessionRecord; model: AppModel }) {
  const t = translations[model.settings.language];
  const date = new Intl.DateTimeFormat(localeNames[model.settings.language], { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(session.startedAt);
  return <article className="session-card">
    <div className="session-card-heading"><div><time dateTime={new Date(session.startedAt).toISOString()}>{date}</time><span className="session-meta">{languageNames[session.language]} · {session.messages.length} {t.sessionMessages}</span></div><button className="icon-button subtle-danger" aria-label={`${t.delete} ${date}`} disabled={model.memoryBusy} onClick={() => { if (window.confirm(t.deleteSessionConfirm)) void model.deleteSession(session.id); }}><Icon name="trash" size={17} /></button></div>
    {session.summaryStatus === 'ready' && session.summary ? <>
      <p className="session-summary">{session.summary.text}</p>
      {([[t.summarySelf, session.summary.selfReported], [t.summaryPreferences, session.summary.preferences], [t.summaryFollowUp, session.summary.followUp]] as Array<[string, string[]]>).map(([title, items]) => items.length > 0 && <div className="summary-section" key={title}><h4>{title}</h4><ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul></div>)}
    </> : <div className="summary-status"><span>{session.summaryStatus === 'pending' ? t.summaryPending : session.summaryStatus === 'failed' ? t.summaryFailed : t.summaryNone}</span>{session.summaryStatus === 'failed' && <button className="text-button" disabled={model.memoryBusy || !model.settings.memoryEnabled || !model.service?.configured} onClick={() => void model.retrySummary(session.id)}><Icon name="refresh" size={14} />{t.retrySummary}</button>}</div>}
    <details className="session-transcript"><summary>{t.transcript}<Icon name="chevron" size={15} /></summary><MessageList messages={session.messages} language={model.settings.language} compact /></details>
  </article>;
}

function Memory({ model, active, close }: { model: AppModel; active: boolean; close: () => void }) {
  const t = translations[model.settings.language];
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  return <Modal title={t.memoryPrivacy} eyebrow="WHITE MOOD" onClose={close} closeLabel={t.close} wide>
    <p className="modal-intro">{t.memoryIntro}</p>
    <div className="privacy-controls">
      <label className="switch-field"><span><span className="field-title">{t.memory}</span><span className="field-help">{t.memoryHint}</span></span><input type="checkbox" role="switch" checked={model.settings.memoryEnabled} disabled={active && !model.settings.memoryEnabled} onChange={event => model.updateSettings({ memoryEnabled: event.target.checked })} /></label>
      {active && <p className="privacy-hint">{t.memoryLocked}</p>}
      {model.cvAvailable && <label className="switch-field"><span><span className="field-title">{t.cv}</span><span className="field-help">{t.cvHint}</span></span><input type="checkbox" role="switch" checked={model.cvEnabled} disabled={!active} onChange={event => void model.setCvEnabled(event.target.checked)} /></label>}
      <div className="privacy-details"><p>{t.processingNotice}</p><p>{t.voicePrivacy}</p></div>
    </div>
    {model.memoryBusy && <p className="memory-status-note" role="status">{t.memoryBusy}</p>}
    <div className="memory-section-heading"><h3>{t.memoryItems}</h3><span className="count-tag">{model.memories.length}</span></div>
    {model.memories.length === 0 ? <div className="empty-card"><Icon name="leaf" size={27} /><h4>{t.memoryEmpty}</h4><p>{t.memoryEmptyHint}</p></div> : <div className="memory-items">{model.memories.map(memory => <article className="memory-item" key={memory.id}>
      <span className="kind-tag">{t[memory.kind === 'self_report' ? 'selfReport' : memory.kind]}</span>
      {editing === memory.id ? <form onSubmit={async event => { event.preventDefault(); if (draft.trim()) { await model.editMemory(memory.id, draft.trim()); setEditing(null); } }} className="edit-memory-form"><textarea autoFocus aria-label={t.editLabel} maxLength={2000} value={draft} onChange={event => setDraft(event.target.value)} /><div className="inline-actions"><button className="small-button" type="submit" disabled={!draft.trim() || model.memoryBusy}>{t.save}</button><button className="text-button" type="button" onClick={() => setEditing(null)}>{t.cancel}</button></div></form> : <p>{memory.text}</p>}
      <div className="memory-item-footer"><span>{t.source} · {memory.sourceSessionIds.length} {t.conversation}</span><div className="inline-actions"><button className="icon-button" disabled={model.memoryBusy || editing === memory.id} aria-label={`${t.edit}: ${memory.text}`} onClick={() => { setEditing(memory.id); setDraft(memory.text); }}><Icon name="edit" size={16} /></button><button className="icon-button subtle-danger" disabled={model.memoryBusy} aria-label={`${t.delete}: ${memory.text}`} onClick={() => { if (window.confirm(t.deleteMemoryConfirm)) void model.deleteMemory(memory.id); }}><Icon name="trash" size={16} /></button></div></div>
    </article>)}</div>}
    <div className="memory-section-heading"><h3>{t.sessions}</h3><span className="count-tag">{model.sessions.length}</span></div>
    {model.sessions.length === 0 ? <p className="empty-session">{t.sessionsEmpty}</p> : <div className="session-list">{[...model.sessions].sort((a, b) => b.startedAt - a.startedAt).map(session => <SessionCard key={session.id} session={session} model={model} />)}</div>}
    {(model.sessions.length > 0 || model.memories.length > 0) && <div className="memory-delete-footer"><button className="text-button danger-text" disabled={model.memoryBusy} onClick={() => { if (window.confirm(t.clearConfirm)) void model.clearAllMemory(); }}><Icon name="trash" size={15} />{t.clearAll}</button></div>}
  </Modal>;
}

export default function App({ model }: { model: AppModel }) {
  const t = translations[model.settings.language];
  const [modal, setModal] = useState<'memory' | null>(null);
  const [text, setText] = useState('');
  const [textExpanded, setTextExpanded] = useState(false);
  const [sending, setSending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const active = !['idle', 'ended', 'error'].includes(model.status);
  const busy = ['connecting', 'transcribing', 'thinking'].includes(model.status);
  const configured = model.service?.configured === true;
  const duration = `${Math.floor(model.elapsedSeconds / 60).toString().padStart(2, '0')}:${Math.floor(model.elapsedSeconds % 60).toString().padStart(2, '0')}`;
  const level = Number.isFinite(model.level) ? Math.max(0, Math.min(1, model.level)) : 0;
  const status = model.muted && model.status === 'listening' ? t.muted : t[model.status];
  const canSend = configured && text.trim().length > 0 && !busy && !sending;

  useEffect(() => { document.documentElement.lang = model.settings.language; document.title = `WhiteMood · ${t.brandNote}`; }, [model.settings.language, t.brandNote]);

  async function send() {
    if (!canSend) return;
    const value = text.trim();
    setSending(true);
    model.updateSettings({ captions: true });
    setText('');
    try { await model.sendText(value); }
    finally { setSending(false); }
  }

  async function reconnect() {
    setRefreshing(true);
    try { await model.refreshService(); }
    finally { setRefreshing(false); }
  }

  return <div className="app-shell">
    <header className="header">
      <a className="brand" href="#main" aria-label="WhiteMood"><BrandMark /><span className="brand-type">WhiteMood<span>{t.brandNote}</span></span></a>
      <nav className="header-actions" aria-label={t.memoryPrivacy}>
        <label className="language-select"><span className="sr-only">{t.language}</span><select value={model.settings.language} disabled={active} onChange={event => model.setLanguage(event.target.value as Language)}>{Object.entries(languageNames).map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select><Icon name="chevron" size={14} /></label>
        <span className="header-divider" />
        <button className="header-button" onClick={() => setModal('memory')} aria-label={t.memoryPrivacy}><Icon name="memory" size={18} /><span>{t.memoryPrivacy}</span></button>
      </nav>
    </header>

    <main id="main" className={`main ${model.settings.captions ? 'with-transcript' : ''}`}>
      <section className="conversation-stage" aria-label={t.voiceLabel}>
        <div className="stage-heading"><span className="eyebrow companion-label"><span className="tiny-flower">✳</span>{t.companion}</span><h1>{active ? t.activeTitle : t.heroTitle}</h1><p>{active ? t.activeSubtitle : t.heroSubtitle}</p></div>

        <div className={`voice-visual visual-${model.status} ${model.muted ? 'visual-muted' : ''}`} style={{ '--level': level } as CSSProperties} aria-hidden="true">
          <div className="visual-outer-ring" /><div className="visual-inner-ring" />
          <div className="voice-sphere"><div className="sphere-core" /><svg className="sphere-petal" viewBox="0 0 90 90" fill="none"><path d="M45 45C19 48 10 30 20 20 33 7 48 21 45 45Z" fill="currentColor" opacity=".8"/><path d="M45 45C42 19 60 10 70 20 83 33 69 48 45 45Z" fill="currentColor"/><path d="M45 45c26-3 35 15 25 25-13 13-28-1-25-25Z" fill="currentColor" opacity=".65"/><path d="M45 45c3 26-15 35-25 25C7 57 21 42 45 45Z" fill="currentColor" opacity=".9"/></svg></div>
          <span className="visual-dot dot-one" /><span className="visual-dot dot-two" />
        </div>

        <div className="call-status"><div className="status-line" role="status" aria-live="polite"><span className={`status-dot ${active ? 'is-active' : ''}`} />{status}</div><div className="status-meta">{active || model.elapsedSeconds > 0 ? <time aria-label={`${t.elapsed} ${duration}`}>{duration}</time> : <span>{t.aiLabel}</span>}</div></div>

        <div className="call-controls">
          {active ? <><button className={`round-button ${model.muted ? 'is-muted' : ''}`} onClick={model.toggleMute} aria-label={model.muted ? t.unmute : t.mute} aria-pressed={model.muted} disabled={model.status === 'connecting'}><Icon name={model.muted ? 'mic-off' : 'mic'} size={22} /></button><button className="end-button" onClick={() => void model.endCall()}><Icon name="phone-end" size={22} /><span>{t.end}</span></button><button className="round-button" disabled={model.status !== 'speaking'} onClick={model.stopSpeaking} aria-label={t.interrupt}><Icon name="pause" size={22} /></button></> : <button className="start-button" disabled={!configured} onClick={() => void model.startCall()}><Icon name="phone" size={21} /><span>{t.start}</span><Icon name="arrow" size={19} /></button>}
        </div>

        {!configured && !active && <div className="service-notice" role="status"><span>{model.service === null && !model.error ? t.serviceChecking : t.serviceOffline}</span>{(model.service !== null || model.error) && <><p>{t.serviceDetail}</p><button className="text-button" disabled={refreshing} onClick={() => void reconnect()}><Icon name="refresh" size={14} />{t.retry}</button></>}</div>}

        <div className="call-options"><button className={`caption-button ${textExpanded ? 'selected' : ''}`} aria-expanded={textExpanded} aria-controls="text-fallback" onClick={() => setTextExpanded(value => !value)}><Icon name="text" size={16} />{textExpanded ? t.hideText : t.useText}</button>{(active || model.messages.length > 0) && <><span className="option-divider" /><button className={`caption-button ${model.settings.captions ? 'selected' : ''}`} aria-pressed={model.settings.captions} aria-label={model.settings.captions ? t.hideCaptions : t.showCaptions} onClick={() => model.updateSettings({ captions: !model.settings.captions })}>{t.captions}</button></>}</div>

        {model.error && <div className="error-notice" role="alert"><div><strong>{t.errorTitle}</strong><p>{errorText(model.error, model.settings.language)}</p></div><button className="icon-button" aria-label={t.dismiss} onClick={model.clearError}><Icon name="close" size={16} /></button></div>}

        {textExpanded && <div id="text-fallback" className="text-fallback"><form onSubmit={event => { event.preventDefault(); void send(); }}><label htmlFor="message-text" className="text-fallback-label">{t.typeTitle}</label><div className="text-input-wrap"><textarea id="message-text" rows={1} maxLength={6000} placeholder={t.typePlaceholder} value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} /><button className="send-button" type="submit" disabled={!canSend} aria-label={t.send}><Icon name="arrow" size={20} /></button></div><div className="input-hint">{sending ? t.sending : t.typeHint}</div></form></div>}

        {!active && <div className="consent-copy"><p>{t.consent}</p></div>}
      </section>

      {model.settings.captions && <aside className="transcript-panel" aria-label={t.captions}><div className="transcript-heading"><div><span className="eyebrow">WHITE MOOD</span><h2>{t.captions}</h2></div><button className="icon-button" aria-label={t.hideCaptions} onClick={() => model.updateSettings({ captions: false })}><Icon name="close" size={18} /></button></div><MessageList messages={model.messages} language={model.settings.language} /></aside>}
    </main>

    <footer className="footer"><div className="footer-values"><span><Icon name="leaf" size={15} />{t.paceShort}</span><span><Icon name="memory" size={15} />{t.memoryShort}</span><span><Icon name="pause" size={15} />{t.privacyShort}</span></div><p>{t.footer}</p><span className="footer-wordmark">WhiteMood</span></footer>
    {modal === 'memory' && <Memory model={model} active={active} close={() => setModal(null)} />}
  </div>;
}
