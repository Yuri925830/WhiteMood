import { useEffect, useRef } from 'react';
import type { AppModel } from './core/model';
import type { AccountControls, AccountUser } from './AuthGate';
import Cloud from './Cloud';
import { translations } from './i18n';
import { workspaceCopy } from './workspace-copy';
import './workspace.css';

export type WorkspaceView = 'call' | 'records' | 'privacy' | 'account';
const navPaths: Record<WorkspaceView, string> = {
  call: 'M8 3 5 4c-1 1 1 7 5 11s10 6 11 5l1-3-5-3-2 2-7-7 2-2-2-4Z',
  records: 'M7 3h10a2 2 0 0 1 2 2v16l-4-2-3 2-3-2-4 2V5a2 2 0 0 1 2-2Zm2 5h6m-6 4h6',
  privacy: 'M12 3 4 6v5c0 5 8 10 8 10s8-5 8-10V6l-8-3Zm-3 9 2 2 4-4',
  account: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2',
};
function NavIcon({ name }: { name: WorkspaceView }) {
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={navPaths[name]} /></svg>;
}

export default function WorkspaceSidebar({ model, user, account, view, onNavigate, open, onClose }: {
  model: AppModel; user: AccountUser; account: AccountControls; view: WorkspaceView;
  onNavigate: (view: WorkspaceView) => void; open: boolean; onClose: () => void;
}) {
  const t = workspaceCopy[model.settings.language];
  const dialog = useRef<HTMLDialogElement>(null);
  const active = !['idle', 'ended', 'error'].includes(model.status);
  useEffect(() => {
    const element = dialog.current;
    if (open && element && !element.open) element.showModal();
    if (!open && element?.open) element.close();
  }, [open]);
  useEffect(() => {
    const desktop = matchMedia('(min-width: 980px)');
    const resize = () => { if (desktop.matches) onClose(); };
    desktop.addEventListener('change', resize);
    return () => desktop.removeEventListener('change', resize);
  }, [onClose]);

  function contents(mobile: boolean) {
    return <>
      <div className="sidebar-heading"><button className="sidebar-brand" disabled={account.busy} onClick={() => { onNavigate('call'); onClose(); }} aria-label="WhiteMood"><Cloud className="sidebar-cloud" /><span>WhiteMood<small>{translations[model.settings.language].brandNote}</small></span></button>{mobile && <button className="icon-button" onClick={onClose} aria-label={t.closeMenu}><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>}</div>
      <nav className="sidebar-links" aria-label={t.navigation}>{(['call', 'records', 'privacy', 'account'] as WorkspaceView[]).map(item => <button key={item} type="button" disabled={account.busy} aria-current={view === item ? 'page' : undefined} onClick={() => { onNavigate(item); onClose(); }}><NavIcon name={item} /><span>{t[item]}</span>{item === 'call' && active && <span className="sidebar-live" aria-label={t.ongoing} />}</button>)}</nav>
      <div className="sidebar-bottom"><p className="sidebar-storage">{t.storage}</p><div className="sidebar-account"><span className="account-initial" aria-hidden="true">{user.id.slice(0, 1).toUpperCase()}</span><div><small>{t.signedIn}</small><span title={user.id}>{user.id}</span></div></div>{account.error && <p className="sidebar-error" role="alert">{account.error}</p>}<button className="sidebar-logout" type="button" disabled={account.busy} onClick={() => void account.logout()}>{account.busy ? t.loggingOut : t.logout}<span aria-hidden="true">↗</span></button></div>
    </>;
  }
  return <>
    <aside className="workspace-sidebar" aria-label={t.navigation}>{contents(false)}</aside>
    <dialog className="sidebar-dialog" ref={dialog} onClose={onClose} aria-label={t.navigation}>{contents(true)}</dialog>
  </>;
}
