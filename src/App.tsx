import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { AppModel } from './core/model';
import type { ChatMessage, Language, SessionRecord } from '../shared/types';
import { errorText, languageNames, localeNames, translations } from './i18n';
import Cloud from './Cloud';
import WorkspaceSidebar, { type WorkspaceView } from './WorkspaceSidebar';
import { workspaceCopy } from './workspace-copy';
import type { AccountControls, AccountUser } from './AuthGate';
import AccountSettings from './AccountSettings';
import VoiceDiagnostics from './VoiceDiagnostics';
import './styles.css';

type IconName = 'mic' | 'mic-off' | 'phone' | 'phone-end' | 'memory' | 'close' | 'arrow' | 'text' | 'check' | 'pause' | 'cloud' | 'refresh' | 'chevron' | 'trash' | 'edit';

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
    cloud: <path d="M6 18a4.5 4.5 0 0 1-.7-8.9 5.5 5.5 0 0 1 10.6-2A5.5 5.5 0 0 1 18 18H6Z" />,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5M19.5 11A7.5 7.5 0 0 0 6 6.5L4 9M4.5 13A7.5 7.5 0 0 0 18 17.5l2-2.5" /></>,
    chevron: <path d="m8 10 4 4 4-4" />,
    trash: <><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" /></>,
    edit: <><path d="m15 4 5 5M4 20l5-1L21 7l-4-4L5 15l-1 5Z" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
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
  const date = new Intl.DateTimeFormat(localeNames[model.settings.language], { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(session.startedAt);
  return <article className="session-card">
    <div className="session-card-heading"><div><time dateTime={new Date(session.startedAt).toISOString()}>{date}</time><span className="session-meta">{languageNames[session.language]} · {session.messages.length} {t.sessionMessages}</span></div><button className="icon-button subtle-danger" aria-label={`${t.delete} ${date}`} disabled={model.memoryBusy} onClick={() => { if (window.confirm(t.deleteSessionConfirm)) void model.deleteSession(session.id); }}><Icon name="trash" size={17} /></button></div>
    {session.summaryStatus === 'ready' && session.summary ? <>
      <p className="session-summary">{session.summary.text}</p>
      {([[t.summarySelf, session.summary.selfReported], [t.summaryPreferences, session.summary.preferences], [t.summaryFollowUp, session.summary.followUp]] as Array<[string, string[]]>).map(([title, items]) => items.length > 0 && <div className="summary-section" key={title}><h4>{title}</h4><ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul></div>)}
    </> : <div className="summary-status"><span>{!session.endedAt ? workspaceCopy[model.settings.language].activeRecord : session.summaryStatus === 'pending' ? t.summaryPending : session.summaryStatus === 'failed' ? t.summaryFailed : t.summaryNone}</span>{session.summaryStatus === 'failed' && <button className="text-button" disabled={model.memoryBusy || !model.settings.memoryEnabled || !model.service?.configured} onClick={() => void model.retrySummary(session.id)}><Icon name="refresh" size={14} />{t.retrySummary}</button>}</div>}
    <details className="session-transcript"><summary>{t.transcript}<Icon name="chevron" size={15} /></summary><MessageList messages={session.messages} language={model.settings.language} compact /></details>
  </article>;
}

function Memory({ model, active }: { model: AppModel; active: boolean }) {
  const t = translations[model.settings.language];
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [cvBusy, setCvBusy] = useState(false);
  async function setCvImages(files: File[]) {
    setCvBusy(true);
    try { await model.setCvImages(files); }
    finally { setCvBusy(false); }
  }
  return <div className="memory-content">
    <p className="modal-intro">{t.memoryIntro}</p>
    <div className="privacy-controls">
      <label className="switch-field"><span><span className="field-title">{t.memory}</span><span className="field-help">{t.memoryHint}</span></span><input type="checkbox" role="switch" checked={model.settings.memoryEnabled} disabled={active && !model.settings.memoryEnabled} onChange={event => model.updateSettings({ memoryEnabled: event.target.checked })} /></label>
      {active && <p className="privacy-hint">{t.memoryLocked}</p>}
      {model.cvAvailable && <div className="image-input-field"><div><span className="field-title">{t.cv}</span><span className="field-help">{t.cvHint}</span></div><div className="image-input-actions"><div className="inline-actions"><label className={`small-button file-button ${!active || cvBusy ? 'is-disabled' : ''}`}>{t.cvChoose}<input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={!active || cvBusy} onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; void setCvImages(files); }} /></label>{model.cvInputCount > 0 && <button className="text-button" type="button" disabled={cvBusy} onClick={() => void setCvImages([])}>{t.cvClear}</button>}</div><span className="image-input-status" role="status">{cvBusy ? t.cvPreparing : model.cvInputCount > 0 ? t.cvReady.replace('{count}', String(model.cvInputCount)) : active ? t.cvEmpty : t.cvCallOnly}</span></div></div>}
      <div className="privacy-details"><p>{t.processingNotice}</p><p>{t.voicePrivacy}</p></div>
    </div>
    {model.memoryBusy && <p className="memory-status-note" role="status">{t.memoryBusy}</p>}
    <div className="memory-section-heading"><h3>{t.memoryItems}</h3><span className="count-tag">{model.memories.length}</span></div>
    {model.memories.length === 0 ? <div className="empty-card"><Cloud className="empty-cloud" /><h4>{t.memoryEmpty}</h4><p>{t.memoryEmptyHint}</p></div> : <div className="memory-items">{model.memories.map(memory => <article className="memory-item" key={memory.id}>
      <span className="kind-tag">{t[memory.kind === 'self_report' ? 'selfReport' : memory.kind]}</span>
      {editing === memory.id ? <form onSubmit={async event => { event.preventDefault(); if (draft.trim()) { await model.editMemory(memory.id, draft.trim()); setEditing(null); } }} className="edit-memory-form"><textarea autoFocus aria-label={t.editLabel} maxLength={2000} value={draft} onChange={event => setDraft(event.target.value)} /><div className="inline-actions"><button className="small-button" type="submit" disabled={!draft.trim() || model.memoryBusy}>{t.save}</button><button className="text-button" type="button" onClick={() => setEditing(null)}>{t.cancel}</button></div></form> : <p>{memory.text}</p>}
      <div className="memory-item-footer"><span>{t.source} · {memory.sourceSessionIds.length} {t.conversation}</span><div className="inline-actions"><button className="icon-button" disabled={model.memoryBusy || editing === memory.id} aria-label={`${t.edit}: ${memory.text}`} onClick={() => { setEditing(memory.id); setDraft(memory.text); }}><Icon name="edit" size={16} /></button><button className="icon-button subtle-danger" disabled={model.memoryBusy} aria-label={`${t.delete}: ${memory.text}`} onClick={() => { if (window.confirm(t.deleteMemoryConfirm)) void model.deleteMemory(memory.id); }}><Icon name="trash" size={16} /></button></div></div>
    </article>)}</div>}
    {(model.sessions.length > 0 || model.memories.length > 0) && <div className="memory-delete-footer"><button className="text-button danger-text" disabled={model.memoryBusy} onClick={() => { if (window.confirm(t.clearConfirm)) void model.clearAllMemory(); }}><Icon name="trash" size={15} />{t.clearAll}</button></div>}
  </div>;
}

function StatusRecords({ model, onManage }: { model: AppModel; onManage: () => void }) {
  const t = workspaceCopy[model.settings.language];
  const sessions = [...model.sessions].sort((a, b) => b.startedAt - a.startedAt);
  return <>
    <p className="workspace-page-intro">{t.recordsIntro}</p><p className="workspace-page-note">{t.recordsNote}<br />{t.storage}</p>
    {!model.settings.memoryEnabled && <p className="memory-status-note">{t.memoryOff} <button className="text-button" onClick={onManage}>{t.manageMemory}</button></p>}
    {sessions.length === 0 ? <div className="empty-card records-empty"><Cloud className="empty-cloud" /><h2>{t.emptyTitle}</h2><p>{t.emptyText}</p><button className="text-button" onClick={onManage}>{t.manageMemory}<Icon name="arrow" size={16} /></button></div> : <>
      <dl className="records-stats"><div><dt>{t.saved}</dt><dd>{sessions.length}</dd></div><div><dt>{t.summarized}</dt><dd>{sessions.filter(item => item.summaryStatus === 'ready' && item.summary).length}</dd></div></dl>
      <div className="saved-session-list">{sessions.map(session => <SessionCard key={session.id} session={session} model={model} />)}</div>
    </>}
  </>;
}

export default function App({ model, user, account }: { model: AppModel; user: AccountUser; account: AccountControls }) {
  const t = translations[model.settings.language];
  const [view, setView] = useState<WorkspaceView>('call');
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const w = workspaceCopy[model.settings.language];
  const [text, setText] = useState('');
  const [textExpanded, setTextExpanded] = useState(false);
  const [sending, setSending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const active = !['idle', 'ended', 'error'].includes(model.status);
  const busy = ['connecting', 'transcribing', 'thinking'].includes(model.status);
  const configured = model.service?.configured === true;
  const duration = `${Math.floor(model.elapsedSeconds / 60).toString().padStart(2, '0')}:${Math.floor(model.elapsedSeconds % 60).toString().padStart(2, '0')}`;
  const level = Number.isFinite(model.level) ? Math.max(0, Math.min(1, model.level)) : 0;
  const status = model.status === 'listening' && model.microphone.status === 'starting' ? t.connecting : model.muted && model.status === 'listening' ? t.muted : t[model.status];
  const canSend = !account.busy && configured && text.trim().length > 0 && !busy && !sending;

  useEffect(() => { document.documentElement.lang = model.settings.language; document.title = `WhiteMood · ${t.brandNote}`; }, [model.settings.language, t.brandNote]);

  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); }, [view]);

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

  return <div className="workspace"><WorkspaceSidebar model={model} user={user} account={account} view={view} onNavigate={setView} open={menuOpen} onClose={closeMenu} /><div className="workspace-content"><div className="app-shell">
    <header className="header">
      <div className="workspace-heading"><button className="sidebar-menu-button" aria-label={w.menu} aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg></button><span>{w[view]}</span></div>
      <nav className="header-actions" aria-label={t.language}>
        <label className="language-select"><span className="sr-only">{t.language}</span><select value={model.settings.language} disabled={active} onChange={event => model.setLanguage(event.target.value as Language)}>{Object.entries(languageNames).map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select><Icon name="chevron" size={14} /></label>
      </nav>
    </header>

    {active && view !== 'call' && <div className="active-call-banner" role="status"><span>{w.ongoing}</span><button onClick={() => setView('call')}>{w.returnCall}</button><button onClick={() => void model.endCall()}>{t.end}</button></div>}
    {view === 'call' ? <main id="main" className={`main ${model.settings.captions ? 'with-transcript' : ''}`}>
      <section className="conversation-stage" aria-label={t.voiceLabel}>
        <div className="stage-heading"><span className="eyebrow companion-label"><Icon name="cloud" size={17} />{t.companion}</span><h1>{active ? t.activeTitle : t.heroTitle}</h1><p>{active ? t.activeSubtitle : t.heroSubtitle}</p></div>

        <div className={`voice-visual visual-${model.status} ${model.muted ? 'visual-muted' : ''}`} style={{ '--level': level } as CSSProperties} aria-hidden="true">
          <div className="cloud-sky" />
          <Cloud className="hero-cloud" />
          <div className="cloud-listening-lines"><span /><span /><span /></div>
        </div>

        <div className="call-status"><div className="status-line" role="status" aria-live="polite"><span className={`status-dot ${active ? 'is-active' : ''}`} />{status}</div><div className="status-meta">{active || model.elapsedSeconds > 0 ? <time aria-label={`${t.elapsed} ${duration}`}>{duration}</time> : <span>{t.aiLabel}</span>}</div></div>

        <div className="call-controls">
          {active ? <><button className={`round-button ${model.muted ? 'is-muted' : ''}`} onClick={model.toggleMute} aria-label={model.muted ? t.unmute : t.mute} aria-pressed={model.muted} disabled={model.status === 'connecting'}><Icon name={model.muted ? 'mic-off' : 'mic'} size={22} /></button><button className="end-button" onClick={() => void model.endCall()}><Icon name="phone-end" size={22} /><span>{t.end}</span></button><button className="round-button" disabled={model.status !== 'speaking'} onClick={model.stopSpeaking} aria-label={t.interrupt}><Icon name="pause" size={22} /></button></> : <button className="start-button" disabled={!configured || account.busy} onClick={() => void model.startCall()}><Icon name="phone" size={21} /><span>{t.start}</span><Icon name="arrow" size={19} /></button>}
        </div>

        <VoiceDiagnostics model={model} active={active} />

        {!configured && !active && <div className="service-notice" role="status"><span>{model.service === null && !model.error ? t.serviceChecking : t.serviceOffline}</span>{(model.service !== null || model.error) && <><p>{t.serviceDetail}</p><button className="text-button" disabled={refreshing} onClick={() => void reconnect()}><Icon name="refresh" size={14} />{t.retry}</button></>}</div>}

        <div className="call-options"><button className={`caption-button ${textExpanded ? 'selected' : ''}`} aria-expanded={textExpanded} aria-controls="text-fallback" onClick={() => setTextExpanded(value => !value)}><Icon name="text" size={16} />{textExpanded ? t.hideText : t.useText}</button>{(active || model.messages.length > 0) && <><span className="option-divider" /><button className={`caption-button ${model.settings.captions ? 'selected' : ''}`} aria-pressed={model.settings.captions} aria-label={model.settings.captions ? t.hideCaptions : t.showCaptions} onClick={() => model.updateSettings({ captions: !model.settings.captions })}>{t.captions}</button></>}</div>

        {model.error && <div className="error-notice" role="alert"><div><strong>{t.errorTitle}</strong><p>{errorText(model.error, model.settings.language)}</p></div><button className="icon-button" aria-label={t.dismiss} onClick={model.clearError}><Icon name="close" size={16} /></button></div>}

        {textExpanded && <div id="text-fallback" className="text-fallback"><form onSubmit={event => { event.preventDefault(); void send(); }}><label htmlFor="message-text" className="text-fallback-label">{t.typeTitle}</label><div className="text-input-wrap"><textarea id="message-text" rows={1} maxLength={6000} placeholder={t.typePlaceholder} value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} /><button className="send-button" type="submit" disabled={!canSend} aria-label={t.send}><Icon name="arrow" size={20} /></button></div><div className="input-hint">{sending ? t.sending : t.typeHint}</div></form></div>}

        {!active && <div className="consent-copy"><p>{t.consent}</p></div>}
      </section>

      {model.settings.captions && <aside className="transcript-panel" aria-label={t.captions}><div className="transcript-heading"><div><span className="eyebrow">WHITE MOOD</span><h2>{t.captions}</h2></div><button className="icon-button" aria-label={t.hideCaptions} onClick={() => model.updateSettings({ captions: false })}><Icon name="close" size={18} /></button></div><MessageList messages={model.messages} language={model.settings.language} /></aside>}
    </main> : <main id="main" className="workspace-page" key={view}><span className="eyebrow">WHITE MOOD</span><h1>{view === 'records' ? w.recordsTitle : view === 'privacy' ? w.privacyTitle : w.accountTitle}</h1>
      {view === 'records' ? <StatusRecords model={model} onManage={() => setView('privacy')} /> : view === 'privacy' ? <Memory model={model} active={active} /> : <AccountSettings user={user} language={model.settings.language} active={active} onUpdate={account.update} />}
      {model.error && <div className="error-notice" role="alert"><div><strong>{t.errorTitle}</strong><p>{errorText(model.error, model.settings.language)}</p></div><button className="icon-button" aria-label={t.dismiss} onClick={model.clearError}><Icon name="close" size={16} /></button></div>}
    </main>}

    <footer className="footer"><div className="footer-values"><span><Icon name="cloud" size={15} />{t.paceShort}</span><span><Icon name="memory" size={15} />{t.memoryShort}</span><span><Icon name="pause" size={15} />{t.privacyShort}</span></div><p>{t.footer}</p><span className="footer-wordmark">WhiteMood</span></footer>
  </div></div></div>;
}
