import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { AppModel } from './model';
import { createAccountController } from './accountController';

export function useWhiteMood(userId: string): AppModel {
  const controller = useMemo(() => createAccountController(userId), [userId]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    void controller.initialize();
    const changed = () => controller.refreshVoices();
    globalThis.speechSynthesis?.addEventListener('voiceschanged', changed);
    return () => { globalThis.speechSynthesis?.removeEventListener('voiceschanged', changed); controller.dispose(); };
  }, [controller]);
  return {
    ...state, updateSettings: controller.updateSettings, setLanguage: controller.setLanguage,
    startCall: controller.startCall, restartMicrophone: controller.restartMicrophone, endCall: controller.endCall, toggleMute: controller.toggleMute,
    stopSpeaking: controller.stopSpeaking, sendText: controller.sendText, deleteSession: controller.deleteSession,
    deleteMemory: controller.deleteMemory, editMemory: controller.editMemory, clearAllMemory: controller.clearAllMemory,
    retrySummary: controller.retrySummary, setCvEnabled: controller.setCvEnabled, refreshService: controller.refreshService, clearError: controller.clearError,
  };
}
