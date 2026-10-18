export type Language = 'zh' | 'en' | 'ko';
export type CallStatus = 'idle' | 'connecting' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'ended' | 'error';
export type SpeechStyle = 'warm' | 'steady' | 'clear';

/** Local microphone health only; never sent to an AI provider or stored with memories. */
export interface MicrophoneState {
  status: 'idle' | 'starting' | 'ready' | 'hearing' | 'quiet' | 'interrupted' | 'error' | 'unclear';
  deviceLabel?: string;
}

export interface UserSettings {
  language: Language;
  rate: number;
  silenceMs: number;
  memoryEnabled: boolean;
  voiceURI: string;
  captions: boolean;
}

export interface VoiceSignals {
  durationMs: number;
  voicedRatio: number;
  meanEnergy: number;
  peakEnergy: number;
}

/** CV is implemented by the CV owner. These are observations, never diagnostic scores. */
export interface CvObservation {
  source: 'face';
  capturedAt: number;
  quality: number;
  features: Record<string, number>;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
  /** Only complete, actually spoken sentences belong in future shared context. */
  spokenText?: string;
  interrupted?: boolean;
}

export interface SpeechPlan {
  style: SpeechStyle;
  rate: number;
  pitch: number;
  pauseMs: number;
}

export interface Reflection {
  feeling: string;
  evidence: string[];
  uncertain: boolean;
}

export interface MemoryItem {
  id: string;
  kind: 'preference' | 'event' | 'self_report';
  text: string;
  sourceSessionIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface SessionSummary {
  text: string;
  selfReported: string[];
  preferences: string[];
  followUp: string[];
}

export interface SessionRecord {
  id: string;
  language: Language;
  startedAt: number;
  endedAt?: number;
  messages: ChatMessage[];
  summary?: SessionSummary;
  summaryStatus: 'none' | 'pending' | 'ready' | 'failed';
}

export interface RespondRequest {
  language: Language;
  text: string;
  history: ChatMessage[];
  memories: MemoryItem[];
  voice?: VoiceSignals;
  cv?: CvObservation;
}

export interface RespondResult {
  reply: string;
  speech: SpeechPlan;
  reflection: Reflection;
}

export interface SummarizeRequest {
  language: Language;
  sessionId: string;
  messages: ChatMessage[];
}

export interface MemoryCandidate {
  kind: MemoryItem['kind'];
  text: string;
  sourceSessionIds: string[];
}

export interface SummarizeResult {
  summary: SessionSummary;
  memories: MemoryCandidate[];
}

export interface ConsolidateRequest {
  language: Language;
  summaries: Array<{ id: string; endedAt: number; summary: SessionSummary }>;
  existing: MemoryItem[];
}

export interface ConsolidateResult { memories: MemoryCandidate[] }

export interface ServiceHealth {
  configured: boolean;
  provider: 'groq';
  models: { chat: string; stt: string };
}

export interface ApiErrorBody {
  error: { code: string; message: string; retryAfter?: number };
}
