export type SpeechEngine = "gemini" | "browser";
export type SpeechKind = "word" | "sentence" | "story";
export type VoicePreset = "us-female" | "uk-male" | "au-female";
export type NarrationStyle = "clear" | "storybook" | "theater";

export const VOICE_PRESETS: Array<{ id: VoicePreset; label: string; locale: string }> = [
  { id: "us-female", label: "미국식 · 여자", locale: "en-US" },
  { id: "uk-male", label: "영국식 · 남자", locale: "en-GB" },
  { id: "au-female", label: "호주식 · 여자", locale: "en-AU" },
];

export const NARRATION_STYLES: Array<{ id: NarrationStyle; label: string; description: string }> = [
  { id: "clear", label: "또렷하게", description: "등장인물 연기 없이 일정한 톤으로 정확하게 읽습니다." },
  { id: "storybook", label: "동화책처럼", description: "따뜻한 내레이션과 대화체 억양을 확실히 구분합니다." },
  { id: "theater", label: "연극처럼", description: "속삭임·놀람·긴장·외침을 크게 살려 연기합니다." },
];

export interface SpeakOptions {
  rate?: number;
  voicePreset?: VoicePreset;
  engine?: SpeechEngine;
  kind?: SpeechKind;
  narrationStyle?: NarrationStyle;
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

const GEMINI_TTS_COOLDOWN_KEY = "talktalk.geminiTtsCooldownUntil";
const GEMINI_TTS_COOLDOWN_MS = 60 * 60 * 1000;
let quotaNoticeShown = false;

function geminiTtsCooldownUntil(): number {
  try { return Number(localStorage.getItem(GEMINI_TTS_COOLDOWN_KEY) ?? 0) || 0; }
  catch { return 0; }
}

function geminiTtsIsCoolingDown(): boolean {
  return Date.now() < geminiTtsCooldownUntil();
}

function startGeminiTtsCooldown(): void {
  try { localStorage.setItem(GEMINI_TTS_COOLDOWN_KEY, String(Date.now() + GEMINI_TTS_COOLDOWN_MS)); }
  catch { /* localStorage may be unavailable in private browsing */ }
}

function isQuotaError(message: string): boolean {
  return /무료 사용 한도|quota|rate limit|resource exhausted|429/i.test(message);
}

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
  configureAudioPlayback(audio, request.options);
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

function clampRate(value: number | undefined): number {
  return Math.max(0.5, Math.min(2, Number(value ?? 0.9)));
}

function configureAudioPlayback(audio: HTMLAudioElement, options: SpeakOptions): void {
  audio.playbackRate = clampRate(options.rate);
  audio.defaultPlaybackRate = audio.playbackRate;
  try { audio.preservesPitch = true; } catch { /* older browsers may not expose this option */ }
}

function browserPerformance(text: string, options: SpeakOptions): { rate: number; pitch: number; volume: number } {
  const style = options.narrationStyle ?? "clear";
  const preset = options.voicePreset ?? "us-female";
  const lower = text.toLowerCase();
  const quoted = /[“”"]/.test(text);
  const question = /\?/.test(text);
  const exclamation = /!/.test(text);
  const basePitch = preset === "uk-male" ? 0.92 : 1.04;
  let rate = clampRate(options.rate);
  let pitch = basePitch;
  let volume = 1;

  if (style === "clear") {
    return { rate, pitch, volume };
  }

  if (style === "storybook") {
    if (quoted) pitch += 0.1;
    if (question) pitch += 0.08;
    if (exclamation) { pitch += 0.06; rate *= 1.03; }
    if (/whisper|murmur|softly|quietly/.test(lower)) { volume = 0.72; pitch -= 0.08; rate *= 0.9; }
    if (/shout|yell|scream|roared/.test(lower)) { pitch += 0.14; rate *= 1.05; }
    if (/sad|sob|tear|lonely/.test(lower)) { pitch -= 0.12; rate *= 0.9; }
    if (/laugh|giggl|happy|delighted/.test(lower)) { pitch += 0.14; rate *= 1.04; }
  }

  if (style === "theater") {
    if (quoted) { pitch += 0.2; rate *= 0.94; }
    if (question) { pitch += 0.17; rate *= 0.92; }
    if (exclamation) { pitch += 0.19; rate *= 1.08; }
    if (/whisper|murmur|softly|quietly/.test(lower)) { volume = 0.5; pitch -= 0.17; rate *= 0.78; }
    if (/shout|yell|scream|roared|cried out/.test(lower)) { volume = 1; pitch += 0.24; rate *= 1.13; }
    if (/afraid|scared|trembl|terrified/.test(lower)) { pitch += 0.08; rate *= 0.78; }
    if (/angry|furious|growl|snapped/.test(lower)) { pitch -= 0.2; rate *= 0.92; }
    if (/sad|sob|tear|lonely/.test(lower)) { pitch -= 0.22; rate *= 0.76; }
    if (/laugh|giggl|happy|delighted/.test(lower)) { pitch += 0.24; rate *= 1.12; }
    if (/suddenly|bang|crash|slam|boom/.test(lower)) { pitch += 0.16; rate *= 1.12; }
  }

  return {
    rate: Math.max(0.5, Math.min(2, rate)),
    pitch: Math.max(0.5, Math.min(1.8, pitch)),
    volume: Math.max(0.1, Math.min(1, volume)),
  };
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
  const performance = browserPerformance(text, options);
  utterance.rate = performance.rate;
  utterance.pitch = performance.pitch;
  utterance.volume = performance.volume;
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
  const kind = options.kind ?? "sentence";
  const voicePreset = options.voicePreset ?? "us-female";
  const narrationStyle = options.narrationStyle ?? "clear";
  const cacheKey = `${voicePreset}|${kind}|${narrationStyle}|${text}`;
  const cached = audioCache.get(cacheKey);
  if (cached) return cached;
  const response = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, rate: 1, kind, voicePreset, narrationStyle }),
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
    configureAudioPlayback(audio, options);
    currentAudio = audio;
    pendingSpeech = false;
    pausedAudioPosition = 0;
    attachAudioHandlers(audio, request, generation);
    if (!pauseRequested) await audio.play();
  } catch (error) {
    if (generation !== playbackGeneration) return;
    const message = error instanceof Error ? error.message : "고음질 음성 생성에 실패했습니다.";
    if (isQuotaError(message)) {
      startGeminiTtsCooldown();
      if (!quotaNoticeShown) {
        quotaNoticeShown = true;
        options.onError?.("Gemini 음성 사용 한도에 도달해 1시간 동안 기기 음성으로 읽습니다.");
      }
    } else {
      options.onError?.(`${message} 기기 음성으로 재생합니다.`);
    }
    pendingSpeech = true;
    browserSpeak(text, options, generation);
  }
}

function startSpeech(cleanText: string, options: SpeakOptions): void {
  cancelCurrentPlayback(false);
  lastSpeechRequest = { text: cleanText, options };
  const generation = playbackGeneration;
  pendingSpeech = true;
  if ((options.engine ?? "gemini") === "gemini") {
    if (!geminiTtsIsCoolingDown()) {
      void geminiSpeak(cleanText, options, generation);
      return;
    }
    if (!quotaNoticeShown) {
      quotaNoticeShown = true;
      options.onError?.("Gemini 음성 사용 한도에 도달해 1시간 동안 기기 음성으로 읽습니다.");
    }
  }
  browserSpeak(cleanText, options, generation);
}

export function speakText(text: string, options: SpeakOptions = {}): void {
  const cleanText = text.replace(/\s+/g, " ").trim();
  if (!cleanText) return;
  startSpeech(cleanText, options);
}
