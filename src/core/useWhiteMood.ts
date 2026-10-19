import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { AppModel } from './model';
import { createAccountController } from './accountController';
import { createImageCvAdapter } from '../integrations/image';
import { registerCvAdapter } from '../integrations/cv';

export function useWhiteMood(userId: string): AppModel {
  const controller = useMemo(() => createAccountController(userId), [userId]);
  const imageInput = useMemo(() => createImageCvAdapter(), []);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    const unregisterCv = registerCvAdapter(imageInput);
    void controller.initialize();
    const changed = () => controller.refreshVoices();
    globalThis.speechSynthesis?.addEventListener('voiceschanged', changed);
    return () => { globalThis.speechSynthesis?.removeEventListener('voiceschanged', changed); controller.dispose(); unregisterCv(); };
  }, [imageInput, controller]);
  return {
    ...state, updateSettings: controller.updateSettings, setLanguage: controller.setLanguage,
    startCall: controller.startCall, restartMicrophone: controller.restartMicrophone, endCall: controller.endCall, toggleMute: controller.toggleMute,
    stopSpeaking: controller.stopSpeaking, sendText: controller.sendText, deleteSession: controller.deleteSession,
    deleteMemory: controller.deleteMemory, editMemory: controller.editMemory, clearAllMemory: controller.clearAllMemory,
    retrySummary: controller.retrySummary, setCvEnabled: controller.setCvEnabled, setCvImages: controller.setCvImages,
    refreshService: controller.refreshService, clearError: controller.clearError,
  };
}
