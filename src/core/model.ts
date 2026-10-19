import type { CallStatus, ChatMessage, Language, MemoryItem, MicrophoneState, ServiceHealth, SessionRecord, UserSettings } from '../../shared/types';

export interface AppModel {
  settings: UserSettings;
  status: CallStatus;
  level: number;
  microphone: MicrophoneState;
  elapsedSeconds: number;
  messages: ChatMessage[];
  error: string | null;
  service: ServiceHealth | null;
  sessions: SessionRecord[];
  memories: MemoryItem[];
  memoryBusy: boolean;
  muted: boolean;
  availableVoices: Array<{ id: string; name: string; local: boolean }>;
  cvAvailable: boolean;
  cvEnabled: boolean;
  cvInputCount: number;
  updateSettings: (next: Partial<UserSettings>) => void;
  setLanguage: (language: Language) => void;
  startCall: () => Promise<void>;
  restartMicrophone: () => Promise<void>;
  endCall: () => Promise<void>;
  toggleMute: () => void;
  stopSpeaking: () => void;
  sendText: (text: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  deleteMemory: (id: string) => Promise<void>;
  editMemory: (id: string, text: string) => Promise<void>;
  clearAllMemory: () => Promise<void>;
  retrySummary: (id: string) => Promise<void>;
  setCvEnabled: (enabled: boolean) => Promise<void>;
  setCvImages: (files: File[]) => Promise<void>;
  refreshService: () => Promise<void>;
  clearError: () => void;
}
