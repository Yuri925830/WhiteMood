'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { Language } from '../shared/types';
import { isValidAccountId, normalizeAccountId } from './auth-validation';
import './account-settings.css';

export interface AccountUpdateInput {
  currentPassword: string;
  id?: string;
  newPassword?: string;
}

export interface AccountSettingsProps {
  user: { userId: string; id: string };
  language: Language;
  active: boolean;
  onUpdate: (input: AccountUpdateInput) => Promise<void>;
}

const copy = {
  zh: {
    title: '账户信息', intro: '在这里修改你的 ID 或密码。',
    id: 'ID', idRule: '3–24 位英文字母、数字或下划线，不区分大小写。',
    currentPassword: '当前密码', currentPasswordHint: '修改账户信息时，需要验证当前密码。',
    newPassword: '新密码（选填）', newPasswordHint: '留空则保留原密码。新密码需要 8–128 个字符，保留空格。',
    sessions: '保存后，其他设备会退出登录；当前设备可以继续使用。',
    save: '保存修改', saving: '正在保存…', saved: '账户信息已更新。',
    active: '请先结束通话，再修改账户信息。',
    invalidId: 'ID 需要 3–24 位英文字母、数字或下划线。',
    invalidPassword: '新密码需要 8–128 个字符。', currentRequired: '请输入当前密码以确认修改。',
    invalidCredentials: '当前密码不正确，请再试一次。', taken: '这个 ID 已有人使用，换一个试试。',
    changed: '账户信息已在其他设备更改，请重新登录。', noChanges: '请修改 ID，或填写新密码后再保存。',
    expired: '登录已过期，请重新登录。', rateLimited: '尝试次数较多，请稍后再试。',
    network: '连接暂时中断，请稍后重试。', unavailable: '暂时无法保存，请稍后再试。',
  },
  en: {
    title: 'Account details', intro: 'Update your ID or password here.',
    id: 'ID', idRule: '3–24 letters, numbers, or underscores. Case does not matter.',
    currentPassword: 'Current password', currentPasswordHint: 'Enter your current password to confirm account changes.',
    newPassword: 'New password (optional)', newPasswordHint: 'Leave blank to keep your password. Use 8–128 characters. Spaces are preserved.',
    sessions: 'Saving signs out your other devices. You can keep using this device.',
    save: 'Save changes', saving: 'Saving…', saved: 'Your account details have been updated.',
    active: 'End your call before changing your account details.',
    invalidId: 'Use 3–24 letters, numbers, or underscores for your ID.',
    invalidPassword: 'Your new password must have 8–128 characters.', currentRequired: 'Enter your current password to confirm these changes.',
    invalidCredentials: 'Your current password is incorrect. Please try again.', taken: 'This ID is taken. Try another one.',
    changed: 'Your account changed on another device. Please sign in again.', noChanges: 'Change your ID or enter a new password before saving.',
    expired: 'Your session has expired. Please sign in again.', rateLimited: 'Too many attempts. Please try again later.',
    network: 'The connection was interrupted. Please try again.', unavailable: 'We could not save your changes. Please try again later.',
  },
  ko: {
    title: '계정 정보', intro: '아이디 또는 비밀번호를 변경할 수 있어요.',
    id: '아이디', idRule: '영문, 숫자, 밑줄로 3–24자. 대소문자를 구분하지 않아요.',
    currentPassword: '현재 비밀번호', currentPasswordHint: '계정 정보를 변경하려면 현재 비밀번호를 입력해 주세요.',
    newPassword: '새 비밀번호 (선택)', newPasswordHint: '비워 두면 기존 비밀번호를 유지해요. 새 비밀번호는 8–128자이며, 공백도 포함돼요.',
    sessions: '저장하면 다른 기기에서 로그아웃돼요. 현재 기기에서는 계속 이용할 수 있어요.',
    save: '변경 사항 저장', saving: '저장 중…', saved: '계정 정보가 변경되었어요.',
    active: '통화를 마친 후 계정 정보를 변경해 주세요.',
    invalidId: '아이디는 영문, 숫자, 밑줄로 3–24자여야 해요.',
    invalidPassword: '새 비밀번호는 8–128자여야 해요.', currentRequired: '변경을 확인하려면 현재 비밀번호를 입력해 주세요.',
    invalidCredentials: '현재 비밀번호가 맞지 않아요. 다시 확인해 주세요.', taken: '이미 사용 중인 아이디예요. 다른 아이디를 입력해 주세요.',
    changed: '다른 기기에서 계정 정보가 변경되었어요. 다시 로그인해 주세요.', noChanges: '아이디를 변경하거나 새 비밀번호를 입력한 후 저장해 주세요.',
    expired: '로그인이 만료되었어요. 다시 로그인해 주세요.', rateLimited: '시도 횟수가 많아요. 잠시 후 다시 시도해 주세요.',
    network: '연결이 잠시 끊겼어요. 다시 시도해 주세요.', unavailable: '변경 사항을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.',
  },
} satisfies Record<Language, Record<string, string>>;

function errorMessage(code: string, language: Language): string {
  const t = copy[language];
  switch (code) {
    case 'INVALID_ID': return t.invalidId;
    case 'INVALID_PASSWORD': return t.invalidPassword;
    case 'CURRENT_PASSWORD_REQUIRED': return t.currentRequired;
    case 'INVALID_CREDENTIALS': return t.invalidCredentials;
    case 'ID_TAKEN': return t.taken;
    case 'ACCOUNT_CHANGED': return t.changed;
    case 'NO_CHANGES': return t.noChanges;
    case 'AUTH_REQUIRED': return t.expired;
    case 'AUTH_RATE_LIMITED':
    case 'RATE_LIMITED': return t.rateLimited;
    case 'NETWORK': return t.network;
    default: return t.unavailable;
  }
}

export default function AccountSettings({ user, language, active, onUpdate }: AccountSettingsProps) {
  const t = copy[language];
  const prefix = useId();
  const [draftId, setDraftId] = useState(user.id);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const currentPassword = useRef<HTMLInputElement>(null);
  const newPassword = useRef<HTMLInputElement>(null);
  const previousUser = useRef(user);
  const mounted = useRef(false);
  const submitting = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const currentInput = currentPassword.current;
    const newInput = newPassword.current;
    return () => {
      mounted.current = false;
      // Passwords stay only in the native fields and the in-flight request.
      if (currentInput) currentInput.value = '';
      if (newInput) newInput.value = '';
    };
  }, []);

  useEffect(() => {
    const previous = previousUser.current;
    if (previous.userId !== user.userId) {
      setDraftId(user.id); setError(''); setSaved(false);
      if (currentPassword.current) currentPassword.current.value = '';
      if (newPassword.current) newPassword.current.value = '';
    } else if (previous.id !== user.id) {
      setDraftId(value => normalizeAccountId(value) === normalizeAccountId(previous.id) ? user.id : value);
    }
    previousUser.current = user;
  }, [user.id, user.userId]);

  const clearFeedback = () => { setError(''); setSaved(false); };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (active || submitting.current) return;
    clearFeedback();
    const id = normalizeAccountId(draftId);
    const current = currentPassword.current?.value ?? '';
    const next = newPassword.current?.value ?? '';
    if (!isValidAccountId(id)) { setError('INVALID_ID'); document.getElementById(`${prefix}-id`)?.focus(); return; }
    if (!current) { setError('CURRENT_PASSWORD_REQUIRED'); currentPassword.current?.focus(); return; }
    const nextLength = Array.from(next).length;
    if (next && (nextLength < 8 || nextLength > 128)) { setError('INVALID_PASSWORD'); newPassword.current?.focus(); return; }
    if (id === normalizeAccountId(user.id) && !next) { setError('NO_CHANGES'); return; }
    const input: AccountUpdateInput = { currentPassword: current };
    if (id !== normalizeAccountId(user.id)) input.id = id;
    if (next) input.newPassword = next;
    submitting.current = true; setPending(true);
    try {
      await onUpdate(input);
      if (!mounted.current) return;
      setDraftId(id); setSaved(true);
      if (currentPassword.current) currentPassword.current.value = '';
      if (newPassword.current) newPassword.current.value = '';
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'UNAVAILABLE');
    } finally {
      submitting.current = false;
      if (mounted.current) setPending(false);
    }
  };

  return <section className="account-settings" aria-labelledby={`${prefix}-title`}>
    <div className="account-settings-heading"><h2 id={`${prefix}-title`}>{t.title}</h2><p>{t.intro}</p></div>
    {active && <p className="account-settings-call-notice" role="status">{t.active}</p>}
    <form onSubmit={event => void submit(event)} aria-busy={pending}>
      <fieldset disabled={active || pending}>
        <div className="account-settings-field">
          <label htmlFor={`${prefix}-id`}>{t.id}</label>
          <input id={`${prefix}-id`} name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={draftId} onChange={event => { setDraftId(event.target.value); clearFeedback(); }} required aria-describedby={`${prefix}-id-hint`} aria-invalid={error === 'INVALID_ID' || error === 'ID_TAKEN'} />
          <p id={`${prefix}-id-hint`}>{t.idRule}</p>
        </div>
        <div className="account-settings-field">
          <label htmlFor={`${prefix}-current-password`}>{t.currentPassword}</label>
          <input ref={currentPassword} id={`${prefix}-current-password`} name="currentPassword" type="password" autoComplete="current-password" required onChange={clearFeedback} aria-describedby={`${prefix}-current-hint`} aria-invalid={error === 'INVALID_CREDENTIALS' || error === 'CURRENT_PASSWORD_REQUIRED'} />
          <p id={`${prefix}-current-hint`}>{t.currentPasswordHint}</p>
        </div>
        <div className="account-settings-field">
          <label htmlFor={`${prefix}-new-password`}>{t.newPassword}</label>
          <input ref={newPassword} id={`${prefix}-new-password`} name="newPassword" type="password" autoComplete="new-password" onChange={clearFeedback} aria-describedby={`${prefix}-new-hint`} aria-invalid={error === 'INVALID_PASSWORD'} />
          <p id={`${prefix}-new-hint`}>{t.newPasswordHint}</p>
        </div>
        <p className="account-settings-session-note">{t.sessions}</p>
        <button className="account-settings-save" type="submit">{pending ? t.saving : t.save}</button>
      </fieldset>
      {error && <p className="account-settings-error" role="alert">{errorMessage(error, language)}</p>}
      {saved && <p className="account-settings-success" role="status">{t.saved}</p>}
    </form>
  </section>;
}
