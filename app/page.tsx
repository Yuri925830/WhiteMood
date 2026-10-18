"use client";

import App from '../src/App';
import AuthGate, { type AccountControls, type AccountUser } from '../src/AuthGate';
import { useWhiteMood } from '../src/core/useWhiteMood';

function WhiteMoodCall({ user, account }: { user: AccountUser; account: AccountControls }) {
  const model = useWhiteMood(user.userId);
  return <App model={model} user={user} account={account} />;
}

export default function Home() {
  return <AuthGate>{(user, account) => <WhiteMoodCall key={user.userId} user={user} account={account} />}</AuthGate>;
}
