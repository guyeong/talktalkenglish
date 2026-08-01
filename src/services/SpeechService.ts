export type SpeechEngine = "gemini" | "browser";
export type SpeechKind = "word" | "sentence" | "story";
export type VoicePreset = "us-female" | "uk-male" | "au-female";

export const VOICE_PRESETS: Array<{ id: VoicePreset; label: string; locale: string }> = [
  { id: "us-female", label: "미국식 · 여자", locale: "en-US" },
  { id: "uk-male", label: "영국식 · 남자", locale: "en-GB" },
  { id: "au-female", label: "호주식 · 여자", locale: "en-AU" },
];

export interface SpeakOptions {
  rate?: number;
  voicePreset?: VoicePreset;
  engine?: SpeechEngine;
  kind?: SpeechKind;
  onEnd?: () => void;
  onError?: (message: string) => void;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
}

interface LastSpeechRequest {
  text: string;
  options: SpeakOptions;
  audioUrl?: string;
}

const audioCache = new Map<string, string>();
let currentAudio: HTMLAudioElement | null = null;
let playbackGeneration = 0;
let pauseRequested = false;
let pendingSpeech = false;
let pausedAudioPosition = 0;
let lastSpeechRequest: LastSpeechRequest | null = null;

export function getEnglishVoices(): SpeechSynthesisVoice[] {
  if (!("speechSynthesis" in window)) return [];
  return window.speechSynthesis.getVoices().filter((voice) => voice.lang.toLowerCase().startsWith("en"));
}

function presetLocale(preset: VoicePreset): string {
  return VOICE_PRESETS.find((item) => item.id === preset)?.locale ?? "en-US";
}

function voiceScore(voice: SpeechSynthesisVoice, preset: VoicePreset): number {
  const name = voice.name.toLowerCase();
  const language = voice.lang.toLowerCase();
  const target = presetLocale(preset).toLowerCase();
  let score = language === target ? 120 : language.startsWith(target) ? 110 : language.startsWith("en") ? 10 : 0;
  const preferredNames: Record<VoicePreset, string[]> = {
    "us-female": ["aria", "jenny", "ava", "samantha", "zira", "google us english"],
    "uk-male": ["ryan", "george", "daniel", "oliver", "arthur", "google uk english male"],
    "au-female": ["natasha", "karen", "catherine", "matilda", "google australian english"],
  };
  preferredNames[preset].forEach((candidate, index) => {
    if (name.includes(candidate)) score += 70 - index * 5;
  });
  if (name.includes("natural")) score += 35;
  if (name.includes("online")) score += 10;
  return score;
}

export function getPreferredVoice(preset: VoicePreset): SpeechSynthesisVoice | undefined {
  return getEnglishVoices().sort((a, b) => voiceScore(b, preset) - voiceScore(a, preset))[0];
}

function detachAudio(audio: HTMLAudioElement): void {
  audio.onended = null;
  audio.onerror = null;
  audio.ontimeupdate = null;
  audio.onloadedmetadata = null;
}

function cancelCurrentPlayback(clearLastRequest = false): void {
  playbackGeneration += 1;
  pauseRequested = false;
  pendingSpeech = false;
  pausedAudioPosition = 0;
  if (clearLastRequest) lastSpeechRequest = null;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  if (currentAudio) {
    detachAudio(currentAudio);
    currentAudio.pause();
    currentAudio = null;
  }
}

export function stopSpeech(): void {
  cancelCurrentPlayback(true);
}

export function pauseSpeech(): boolean {
  pauseRequested = true;
  if (currentAudio) {
    pausedAudioPosition = Number.isFinite(currentAudio.currentTime) ? currentAudio.currentTime : pausedAudioPosition;
    if (!currentAudio.paused) currentAudio.pause();
    return true;
  }
  if ("speechSynthesis" in window && window.speechSynthesis.speaking) {
    if (!window.speechSynthesis.paused) window.speechSynthesis.pause();
    return true;
  }
  return pendingSpeech;
}

function attachAudioHandlers(audio: HTMLAudioElement, request: LastSpeechRequest, generation: number): void {
  const { options } = request;
  audio.ontimeupdate = () => {
    if (generation !== playbackGeneration || currentAudio !== audio) return;
    pausedAudioPosition = audio.currentTime;
    options.onTimeUpdate?.(audio.currentTime, Number.isFinite(audio.duration) ? audio.duration : 0);
  };
  audio.onended = () => {
    if (generation !== playbackGeneration || currentAudio !== audio) return;
    pausedAudioPosition = 0;
    currentAudio = null;
    options.onEnd?.();
  };
  audio.onerror = () => {
    if (generation !== playbackGeneration || currentAudio !== audio) return;
    currentAudio = null;
    options.onError?.("음성을 이어서 재생하지 못했습니다.");
  };
}

function recreateAudioAt(position: number): boolean {
  if (!lastSpeechRequest?.audioUrl) return false;
  const request = lastSpeechRequest;
  const generation = ++playbackGeneration;
  const audio = new Audio(request.audioUrl);
  currentAudio = audio;
  pendingSpeech = false;
  pauseRequested = false;
  attachAudioHandlers(audio, request, generation);

  const start = () => {
    if (generation !== playbackGeneration || currentAudio !== audio) return;
    const duration = Number.isFinite(audio.duration) ? audio.duration : position;
    const safePosition = Math.max(0, Math.min(position, Math.max(0, duration - 0.05)));
    try { audio.currentTime = safePosition; } catch { /* Safari retries after metadata */ }
    void audio.play().catch(() => request.options.onError?.("이어 읽기를 시작하지 못했습니다. 재생 버튼을 다시 눌러 주세요."));
  };
  audio.onloadedmetadata = start;
  if (audio.readyState >= 1) start();
  return true;
}

export function resumeSpeech(): boolean {
  pauseRequested = false;
  if (currentAudio && currentAudio.paused && !currentAudio.ended) {
    const position = Number.isFinite(currentAudio.currentTime) ? currentAudio.currentTime : pausedAudioPosition;
    pausedAudioPosition = position;
    void currentAudio.play().catch(() => {
      detachAudio(currentAudio!);
      currentAudio = null;
      recreateAudioAt(position);
    });
    return true;
  }
  if (lastSpeechRequest?.audioUrl && pausedAudioPosition > 0) return recreateAudioAt(pausedAudioPosition);
  if ("speechSynthesis" in window && window.speechSynthesis.paused) {
    window.speechSynthesis.resume();
    return true;
  }
  if (pendingSpeech) return true;
  return false;
}

function browserSpeak(text: string, options: SpeakOptions, generation = playbackGeneration): void {
  if (!("speechSynthesis" in window)) {
    pendingSpeech = false;
    options.onError?.("이 브라우저는 음성 읽기를 지원하지 않습니다.");
    return;
  }
  const voicePreset = options.voicePreset ?? "us-female";
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = presetLocale(voicePreset);
  utterance.rate = options.rate ?? 0.86;
  utterance.pitch = voicePreset === "uk-male" ? 0.92 : 1.04;
  utterance.volume = 1;
  utterance.voice = getPreferredVoice(voicePreset) ?? null;
  utterance.onstart = () => {
    if (generation !== playbackGeneration) return;
    pendingSpeech = false;
    if (pauseRequested) window.speechSynthesis.pause();
  };
  utterance.onend = () => {
    if (generation !== playbackGeneration) return;
    pendingSpeech = false;
    options.onEnd?.();
  };
  utterance.onerror = () => {
    if (generation !== playbackGeneration) return;
    pendingSpeech = false;
    options.onError?.("기기 음성 재생에 실패했습니다.");
  };
  window.speechSynthesis.speak(utterance);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function pcmToWavBlob(pcm: Uint8Array, sampleRate = 24000): Blob {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const write = (offset: number, value: string) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  write(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  write(8, "WAVE"); write(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, "data"); view.setUint32(40, pcm.byteLength, true);
  return new Blob([header, pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer], { type: "audio/wav" });
}

async function requestGeminiAudio(text: string, options: SpeakOptions): Promise<string> {
  const rate = options.rate ?? 0.86;
  const kind = options.kind ?? "sentence";
  const voicePreset = options.voicePreset ?? "us-female";
  const cacheKey = `${voicePreset}|${kind}|${rate.toFixed(2)}|${text}`;
  const cached = audioCache.get(cacheKey);
  if (cached) return cached;
  const response = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, rate, kind, voicePreset }),
  });
  const raw = await response.text();
  let payload: { data?: string; mimeType?: string; error?: string } = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch { throw new Error(raw || `고음질 음성 요청 실패 (${response.status})`); }
  if (!response.ok || !payload.data) throw new Error(payload.error || `고음질 음성 요청 실패 (${response.status})`);
  const mimeType = payload.mimeType ?? "audio/L16;rate=24000";
  const bytes = base64ToBytes(payload.data);
  const blob = mimeType.includes("wav")
    ? new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: "audio/wav" })
    : pcmToWavBlob(bytes, Number(mimeType.match(/rate=(\d+)/)?.[1] ?? 24000));
  const url = URL.createObjectURL(blob);
  audioCache.set(cacheKey, url);
  return url;
}

async function geminiSpeak(text: string, options: SpeakOptions, generation: number): Promise<void> {
  try {
    const url = await requestGeminiAudio(text, options);
    if (generation !== playbackGeneration) return;
    const request = lastSpeechRequest ?? { text, options };
    request.audioUrl = url;
    lastSpeechRequest = request;
    const audio = new Audio(url);
    currentAudio = audio;
    pendingSpeech = false;
    pausedAudioPosition = 0;
    attachAudioHandlers(audio, request, generation);
    if (!pauseRequested) await audio.play();
  } catch (error) {
    if (generation !== playbackGeneration) return;
    const message = error instanceof Error ? error.message : "고음질 음성 생성에 실패했습니다.";
    options.onError?.(`${message} 기기 음성으로 재생합니다.`);
    pendingSpeech = true;
    browserSpeak(text, options, generation);
  }
}

function startSpeech(cleanText: string, options: SpeakOptions): void {
  cancelCurrentPlayback(false);
  lastSpeechRequest = { text: cleanText, options };
  const generation = playbackGeneration;
  pendingSpeech = true;
  if ((options.engine ?? "gemini") === "gemini") void geminiSpeak(cleanText, options, generation);
  else browserSpeak(cleanText, options, generation);
}

export function speakText(text: string, options: SpeakOptions = {}): void {
  const cleanText = text.replace(/\s+/g, " ").trim();
  if (!cleanText) return;
  startSpeech(cleanText, options);
}
