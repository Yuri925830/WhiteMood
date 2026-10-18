'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import type { Language } from '../shared/types';
import { isValidAccountId, normalizeAccountId, validateCredentials } from './auth-validation';
import Cloud from './Cloud';
import './auth.css';

export interface AccountUser { userId: string; id: string }
type Mode = 'login' | 'register';
type IdStatus = 'idle' | 'checking' | 'available' | 'taken' | 'invalid' | 'error';
const languageStorageKey = 'whitemood-auth-language-v1';
const copy = {
  zh: {
    language: '语言', note: '让心情，有处安放', welcome: '欢迎回来。', registerTitle: '从这里，慢慢开始。',
    intro: '登录你的 WhiteMood，继续属于你的对话。', registerIntro: '只需要一个 ID 和密码，就能拥有自己的空间。',
    id: 'ID', password: '密码', login: '登录', register: '创建账号', signingIn: '正在登录…', signingUp: '正在创建…',
    noAccount: '还没有账号？', haveAccount: '已经有账号？', toRegister: '注册', toLogin: '去登录',
    idRule: '3–24 位英文字母、数字或下划线，不区分大小写。', passwordRule: '8–128 个字符，保留空格。',
    checkingId: '正在检查 ID…', available: '这个 ID 可以使用。', taken: '这个 ID 已有人使用，换一个试试。', checkFailed: '暂时无法检查，提交时会再次验证。',
    invalidId: 'ID 需要 3–24 位英文字母、数字或下划线。', invalidPassword: '密码需要 8–128 个字符。', invalidCredentials: 'ID 或密码不正确，请再试一次。',
    network: '连接暂时中断，请稍后重试。', rateLimited: '尝试次数较多，请稍后再试。', unavailable: '账号服务暂时不可用，请稍后重试。',
    loading: '正在打开你的空间…', checkingSession: '正在确认登录状态', retry: '重新连接', logout: '退出登录', loggingOut: '正在退出…',
    account: '当前账号', footer: 'AI 语音陪伴 · 不是医疗服务', sessionExpired: '登录已过期，请重新登录。',
  },
  en: {
    language: 'Language', note: 'A little room for how you feel', welcome: 'Welcome back.', registerTitle: 'A gentle place to begin.',
    intro: 'Sign in to WhiteMood and return to your conversations.', registerIntro: 'An ID and password are all you need for a space of your own.',
    id: 'ID', password: 'Password', login: 'Sign in', register: 'Create account', signingIn: 'Signing in…', signingUp: 'Creating account…',
    noAccount: 'New here?', haveAccount: 'Already have an account?', toRegister: 'Register', toLogin: 'Sign in',
    idRule: '3–24 letters, numbers, or underscores. Case does not matter.', passwordRule: '8–128 characters. Spaces are preserved.',
    checkingId: 'Checking this ID…', available: 'This ID is available.', taken: 'This ID is taken. Try another one.', checkFailed: 'Cannot check right now. We will verify it when you submit.',
    invalidId: 'Use 3–24 letters, numbers, or underscores for your ID.', invalidPassword: 'Your password must have 8–128 characters.', invalidCredentials: 'That ID or password is incorrect. Please try again.',
    network: 'The connection was interrupted. Please try again.', rateLimited: 'Too many attempts. Please try again later.', unavailable: 'Account services are temporarily unavailable. Please try again later.',
    loading: 'Opening your space…', checkingSession: 'Checking your sign-in', retry: 'Reconnect', logout: 'Sign out', loggingOut: 'Signing out…',
    account: 'Your account', footer: 'AI voice companionship · Not medical care', sessionExpired: 'Your session has expired. Please sign in again.',
  },
  ko: {
    language: '언어', note: '마음이 잠시 머무는 곳', welcome: '다시 만나 반가워요.', registerTitle: '여기서, 천천히 시작해요.',
    intro: 'WhiteMood에 로그인하고 나만의 대화를 이어 가세요.', registerIntro: '아이디와 비밀번호만으로 나만의 공간을 만들 수 있어요.',
    id: '아이디', password: '비밀번호', login: '로그인', register: '계정 만들기', signingIn: '로그인 중…', signingUp: '계정 생성 중…',
    noAccount: '처음 오셨나요?', haveAccount: '이미 계정이 있나요?', toRegister: '회원가입', toLogin: '로그인',
    idRule: '영문, 숫자, 밑줄로 3–24자. 대소문자를 구분하지 않아요.', passwordRule: '8–128자. 공백도 비밀번호의 일부예요.',
    checkingId: '아이디를 확인하고 있어요…', available: '사용할 수 있는 아이디예요.', taken: '이미 사용 중인 아이디예요. 다른 아이디를 입력해 주세요.', checkFailed: '지금은 확인할 수 없어요. 가입할 때 다시 확인할게요.',
    invalidId: '아이디는 영문, 숫자, 밑줄로 3–24자여야 해요.', invalidPassword: '비밀번호는 8–128자여야 해요.', invalidCredentials: '아이디 또는 비밀번호가 맞지 않아요. 다시 확인해 주세요.',
    network: '연결이 잠시 끊겼어요. 다시 시도해 주세요.', rateLimited: '시도 횟수가 많아요. 잠시 후 다시 시도해 주세요.', unavailable: '계정 서비스를 잠시 이용할 수 없어요. 나중에 다시 시도해 주세요.',
    loading: '나만의 공간을 열고 있어요…', checkingSession: '로그인 상태 확인 중', retry: '다시 연결', logout: '로그아웃', loggingOut: '로그아웃 중…',
    account: '현재 계정', footer: 'AI 음성 대화 친구 · 의료 서비스가 아닙니다', sessionExpired: '로그인이 만료되었어요. 다시 로그인해 주세요.',
  },
} satisfies Record<Language, Record<string, string>>;

function initialLanguage(): Language {
  try {
    const stored = localStorage.getItem(languageStorageKey);
    if (stored === 'zh' || stored === 'en' || stored === 'ko') return stored;
  } catch { /* Language selection remains usable without browser storage. */ }
  const preferred = navigator.languages?.[0] ?? navigator.language;
  return preferred?.toLowerCase().startsWith('zh') ? 'zh' : preferred?.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

function subscribeLanguageChange(changed: () => void): () => void {
  const storageChanged = (event: StorageEvent) => { if (event.key === languageStorageKey) changed(); };
  window.addEventListener('languagechange', changed);
  window.addEventListener('storage', storageChanged);
  return () => { window.removeEventListener('languagechange', changed); window.removeEventListener('storage', storageChanged); };
}

const serverLanguage = (): Language => 'zh';

class AuthError extends Error {
  constructor(public code: string) { super(code); }
}

async function authRequest(path: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try { response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store' }); }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new AuthError('NETWORK');
  }
  const body = await response.json().catch(() => null);
  const errorBody = body as { error?: { code?: unknown } } | null;
  if (!response.ok) throw new AuthError(typeof errorBody?.error?.code === 'string' ? errorBody.error.code : response.status === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE');
  return body;
}

function readUser(body: unknown): AccountUser | null {
  const user = (body as { user?: unknown } | null)?.user;
  if (user === null) return null;
  if (typeof user !== 'object' || !user || !('userId' in user) || !('id' in user) || typeof user.userId !== 'string' || typeof user.id !== 'string' || !user.userId || !user.id) throw new AuthError('UNAVAILABLE');
  return { userId: user.userId, id: user.id };
}

function errorMessage(code: string, language: Language): string {
  const t = copy[language];
  if (code === 'INVALID_ID') return t.invalidId;
  if (code === 'INVALID_PASSWORD') return t.invalidPassword;
  if (code === 'INVALID_CREDENTIALS') return t.invalidCredentials;
  if (code === 'ID_TAKEN') return t.taken;
  if (/RATE|LIMIT|QUOTA/.test(code)) return t.rateLimited;
  if (code === 'NETWORK') return t.network;
  if (code === 'AUTH_REQUIRED') return t.sessionExpired;
  return t.unavailable;
}

export default function AuthGate({ children }: { children: (user: AccountUser) => ReactNode }) {
  const preferredLanguage = useSyncExternalStore(subscribeLanguageChange, initialLanguage, serverLanguage);
  const [languageChoice, setLanguage] = useState<Language | null>(null);
  const language = languageChoice ?? preferredLanguage;
  const [user, setUser] = useState<AccountUser | null>(null);
  const [boot, setBoot] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [mode, setMode] = useState<Mode>('login');
  const [id, setId] = useState('');
  const [password, setPassword] = useState('');
  const [idStatus, setIdStatus] = useState<IdStatus>('idle');
  const [pending, setPending] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState('');
  const sessionRequest = useRef<AbortController | null>(null);
  const actionRequest = useRef<AbortController | null>(null);
  const idRequest = useRef<AbortController | null>(null);
  const idTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(false);
  const t = copy[language];

  const loadSession = useCallback(() => {
    sessionRequest.current?.abort();
    const request = new AbortController(); sessionRequest.current = request;
    return authRequest('/api/auth/session', { signal: request.signal }).then(body => {
      const nextUser = readUser(body);
      if (!request.signal.aborted && alive.current) { setUser(nextUser); setBoot('ready'); }
    }).catch(failure => {
      if (!request.signal.aborted && alive.current) { setError(failure instanceof AuthError ? failure.code : 'UNAVAILABLE'); setBoot('failed'); }
    });
  }, []);

  useEffect(() => {
    alive.current = true; void loadSession();
    const requireLogin = () => {
      actionRequest.current?.abort(); sessionRequest.current?.abort();
      setUser(null); setPassword(''); setMode('login'); setPending(false); setLeaving(false); setBoot('ready'); setError('AUTH_REQUIRED');
    };
    window.addEventListener('whitemood:auth-required', requireLogin);
    return () => {
      alive.current = false;
      window.removeEventListener('whitemood:auth-required', requireLogin);
      sessionRequest.current?.abort(); actionRequest.current?.abort(); idRequest.current?.abort();
      if (idTimer.current) clearTimeout(idTimer.current);
    };
  }, [loadSession]);

  useEffect(() => {
    if (!user) document.documentElement.lang = language;
  }, [language, user]);

  const checkId = useCallback(async (value: string) => {
    if (idTimer.current) { clearTimeout(idTimer.current); idTimer.current = null; }
    idRequest.current?.abort();
    if (!value) { setIdStatus('idle'); return; }
    if (!isValidAccountId(value)) { setIdStatus('invalid'); return; }
    const request = new AbortController(); idRequest.current = request;
    setIdStatus('checking');
    try {
      const body = await authRequest(`/api/auth/check-id?id=${encodeURIComponent(normalizeAccountId(value))}`, { signal: request.signal }) as { available?: unknown };
      if (typeof body?.available !== 'boolean') throw new AuthError('UNAVAILABLE');
      if (!request.signal.aborted && alive.current) setIdStatus(body.available ? 'available' : 'taken');
    } catch {
      if (!request.signal.aborted && alive.current) setIdStatus('error');
    }
  }, []);

  useEffect(() => {
    idRequest.current?.abort();
    if (idTimer.current) clearTimeout(idTimer.current);
    if (mode !== 'register' || user || !id) return;
    idTimer.current = setTimeout(() => { void checkId(id); }, 450);
    return () => { if (idTimer.current) clearTimeout(idTimer.current); idRequest.current?.abort(); };
  }, [mode, id, user, checkId]);

  function selectLanguage(value: Language) {
    setLanguage(value);
    try { localStorage.setItem(languageStorageKey, value); } catch { /* Storage is optional. */ }
  }

  function updateId(value: string) {
    idRequest.current?.abort();
    if (idTimer.current) clearTimeout(idTimer.current);
    setIdStatus('idle'); setId(value); setError('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const validation = validateCredentials(id, password);
    if (validation) { setError(validation); return; }
    if (mode === 'register' && idStatus === 'taken') { setError('ID_TAKEN'); return; }
    actionRequest.current?.abort();
    const request = new AbortController(); actionRequest.current = request;
    setPending(true); setError('');
    try {
      const nextUser = readUser(await authRequest(`/api/auth/${mode}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, password }), signal: request.signal,
      }));
      if (!nextUser) throw new AuthError('UNAVAILABLE');
      if (!request.signal.aborted && alive.current) {
        idRequest.current?.abort(); if (idTimer.current) clearTimeout(idTimer.current);
        setPassword(''); setUser(nextUser);
      }
    } catch (failure) {
      if (!request.signal.aborted && alive.current) {
        const code = failure instanceof AuthError ? failure.code : 'UNAVAILABLE';
        setError(code); if (code === 'ID_TAKEN') setIdStatus('taken');
      }
    } finally { if (!request.signal.aborted && alive.current) setPending(false); }
  }

  async function logout() {
    if (pending) return;
    actionRequest.current?.abort();
    const request = new AbortController(); actionRequest.current = request;
    setPending(true); setLeaving(true); setError('');
    try {
      await authRequest('/api/auth/logout', { method: 'POST', signal: request.signal });
      if (!request.signal.aborted && alive.current) { setUser(null); setPassword(''); setMode('login'); }
    } catch (failure) {
      if (!request.signal.aborted && alive.current) setError(failure instanceof AuthError ? failure.code : 'UNAVAILABLE');
    } finally { if (!request.signal.aborted && alive.current) { setPending(false); setLeaving(false); } }
  }

  if (boot === 'ready' && user) return <>
    <div className="account-strip" aria-label={t.account}><span className="account-name">{user.id}</span><button type="button" disabled={pending} onClick={() => void logout()}>{pending ? t.loggingOut : t.logout}</button>{error && <span role="alert">{errorMessage(error, language)}</span>}</div>
    {leaving ? <div className="auth-logout-wait" role="status">{t.loggingOut}</div> : children(user)}
  </>;

  const idNote = idStatus === 'checking' ? t.checkingId : idStatus === 'available' ? t.available : idStatus === 'taken' ? t.taken : idStatus === 'invalid' ? t.invalidId : idStatus === 'error' ? t.checkFailed : t.idRule;
  return <div className="auth-shell">
    <header className="auth-header"><Link className="auth-brand" href="/" aria-label="WhiteMood"><Cloud className="auth-brand-cloud" /><span>WhiteMood<small>{t.note}</small></span></Link><label className="auth-language"><span className="sr-only">{t.language}</span><select value={language} onChange={event => selectLanguage(event.target.value as Language)}><option value="zh">简体中文</option><option value="en">English</option><option value="ko">한국어</option></select></label></header>
    <main className="auth-main">
      {boot !== 'ready' ? <section className="auth-loading" aria-label={t.checkingSession} aria-live="polite"><Cloud className="auth-loading-cloud" /><p>{boot === 'loading' ? t.loading : errorMessage(error, language)}</p>{boot === 'failed' && <button className="auth-submit" type="button" onClick={() => { setBoot('loading'); setError(''); void loadSession(); }}>{t.retry}</button>}</section> : <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-cloud-welcome"><Cloud className="auth-welcome-cloud" /></div>
        <span className="eyebrow">WHITE MOOD</span><h1 id="auth-title">{mode === 'login' ? t.welcome : t.registerTitle}</h1><p className="auth-intro">{mode === 'login' ? t.intro : t.registerIntro}</p>
        <form onSubmit={event => void submit(event)} noValidate aria-busy={pending}>
          <div className="auth-field"><label htmlFor="account-id">{t.id}</label><input id="account-id" name="username" type="text" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required maxLength={24} value={id} disabled={pending} aria-invalid={error === 'INVALID_ID' || mode === 'register' && (idStatus === 'taken' || idStatus === 'invalid')} aria-describedby={mode === 'register' ? 'account-id-note' : undefined} onChange={event => updateId(event.target.value)} onBlur={() => { if (mode === 'register') void checkId(id); }} />{mode === 'register' && <p id="account-id-note" className={`auth-field-note auth-id-${idStatus}`} role="status">{idNote}</p>}</div>
          <div className="auth-field"><label htmlFor="account-password">{t.password}</label><input id="account-password" name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={8} maxLength={128} value={password} disabled={pending} aria-invalid={error === 'INVALID_PASSWORD'} aria-describedby={mode === 'register' ? 'account-password-note' : undefined} onChange={event => { setPassword(event.target.value); setError(''); }} />{mode === 'register' && <p id="account-password-note" className="auth-field-note">{t.passwordRule}</p>}</div>
          {error && <p className="auth-error" role="alert">{errorMessage(error, language)}</p>}
          <button className="auth-submit" type="submit" disabled={pending || !id || !password}>{pending ? mode === 'login' ? t.signingIn : t.signingUp : mode === 'login' ? t.login : t.register}<span aria-hidden="true">→</span></button>
        </form>
        <p className="auth-switch">{mode === 'login' ? t.noAccount : t.haveAccount}<button type="button" disabled={pending} onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setIdStatus('idle'); setPassword(''); setError(''); }}>{mode === 'login' ? t.toRegister : t.toLogin}</button></p>
      </section>}
    </main>
    <footer className="auth-footer">{t.footer}</footer>
  </div>;
}
