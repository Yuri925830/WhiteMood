"use client";

import App from '../src/App';
import AuthGate from '../src/AuthGate';
import { useWhiteMood } from '../src/core/useWhiteMood';

function WhiteMoodCall({ userId }: { userId: string }) {
  const model = useWhiteMood(userId);
  return <App model={model} />;
}

export default function Home() {
  return <AuthGate>{user => <WhiteMoodCall key={user.userId} userId={user.userId} />}</AuthGate>;
}
