import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { WhiteMoodController } from './controller';
import type { AppModel } from './model';

export function useWhiteMood(): AppModel {
  const controller = useMemo(() => new WhiteMoodController(), []);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    void controller.initialize();
    const changed = () => controller.refreshVoices();
    globalThis.speechSynthesis?.addEventListener('voiceschanged', changed);
    return () => { globalThis.speechSynthesis?.removeEventListener('voiceschanged', changed); controller.dispose(); };
  }, [controller]);
  return {
    ...state, updateSettings: controller.updateSettings, setLanguage: controller.setLanguage,
    startCall: controller.startCall, endCall: controller.endCall, toggleMute: controller.toggleMute,
    stopSpeaking: controller.stopSpeaking, sendText: controller.sendText, deleteSession: controller.deleteSession,
    deleteMemory: controller.deleteMemory, editMemory: controller.editMemory, clearAllMemory: controller.clearAllMemory,
    retrySummary: controller.retrySummary, setCvEnabled: controller.setCvEnabled, refreshService: controller.refreshService, clearError: controller.clearError,
  };
}
