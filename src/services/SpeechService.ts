import { db } from "../db/database";

export type SpeechEngine = "gemini" | "browser";
export type SpeechKind = "word" | "sentence" | "story";
export type VoicePreset = "us-female" | "us-male" | "uk-male" | "au-female";
export type NarrationStyle = "clear" | "reference" | "storybook" | "theater";

export const VOICE_PRESETS: Array<{ id: VoicePreset; label: string; locale: string }> = [
  { id: "us-female", label: "미국식 · 여자", locale: "en-US" },
  { id: "us-male", label: "미국식 · 남자", locale: "en-US" },
  { id: "uk-male", label: "영국식 · 남자", locale: "en-GB" },
  { id: "au-female", label: "호주식 · 여자", locale: "en-AU" },
];

export const NARRATION_STYLES: Array<{ id: NarrationStyle; label: string; description: string }> = [
  { id: "clear", label: "또렷하게", description: "등장인물 연기 없이 일정한 톤으로 정확하게 읽습니다." },
  { id: "reference", label: "교재 음원처럼", description: "업로드한 학교 음원의 차분한 속도, 강세와 문장 억양을 참고합니다." },
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
  /** Start a cached full-page audio track at an estimated 0-1 position. */
  startAtRatio?: number;
  /** Text used only when Gemini is unavailable and browser speech is used. */
  fallbackText?: string;
  /** Optional context used to organize persistent audio cache entries. */
  cacheContext?: { bookId?: string; pageId?: string };
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
let browserSequenceTimer: number | null = null;
let browserSequenceResume: (() => void) | null = null;

const GEMINI_TTS_COOLDOWN_KEY = "talktalk.geminiTtsCooldownUntil";
const GEMINI_TTS_FAILURES_KEY = "talktalk.geminiTtsFailures";
const GEMINI_TTS_REQUESTS_KEY = "talktalk.geminiTtsRecentRequests";
const GEMINI_TTS_WINDOW_MS = 60_000;
const GEMINI_TTS_MAX_REQUESTS_PER_WINDOW = 3;
const GEMINI_TTS_CACHE_LIMIT_BYTES = 120 * 1024 * 1024;
const GEMINI_TTS_CACHE_LIMIT_ENTRIES = 160;
let quotaNoticeShown = false;

class GeminiTtsError extends Error {
  status: number;
  retryAfterSeconds: number;

  constructor(message: string, status = 0, retryAfterSeconds = 0) {
    super(message);
    this.name = "GeminiTtsError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function readNumber(key: string): number {
  try { return Number(localStorage.getItem(key) ?? 0) || 0; }
  catch { return 0; }
}

function writeNumber(key: string, value: number): void {
  try { localStorage.setItem(key, String(value)); }
  catch { /* localStorage may be unavailable in private browsing */ }
}

function geminiTtsCooldownUntil(): number {
  const stored = readNumber(GEMINI_TTS_COOLDOWN_KEY);
  const maximumReasonable = Date.now() + 10 * 60 * 1000;
  if (stored > maximumReasonable) {
    const migrated = Date.now() + 65 * 1000;
    writeNumber(GEMINI_TTS_COOLDOWN_KEY, migrated);
    return migrated;
  }
  return stored;
}

function geminiTtsIsCoolingDown(): boolean {
  const until = geminiTtsCooldownUntil();
  if (until <= Date.now()) {
    quotaNoticeShown = false;
    return false;
  }
  return true;
}

function startGeminiTtsCooldown(retryAfterSeconds = 65): number {
  const failures = Math.min(5, readNumber(GEMINI_TTS_FAILURES_KEY) + 1);
  writeNumber(GEMINI_TTS_FAILURES_KEY, failures);
  const adaptiveSeconds = Math.min(10 * 60, 65 * (2 ** Math.max(0, failures - 1)));
  const delaySeconds = Math.max(65, retryAfterSeconds, adaptiveSeconds);
  writeNumber(GEMINI_TTS_COOLDOWN_KEY, Date.now() + delaySeconds * 1000);
  return delaySeconds;
}

function clearGeminiTtsCooldown(): void {
  writeNumber(GEMINI_TTS_COOLDOWN_KEY, 0);
  writeNumber(GEMINI_TTS_FAILURES_KEY, 0);
  quotaNoticeShown = false;
}

function recentGeminiRequests(): number[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(GEMINI_TTS_REQUESTS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - GEMINI_TTS_WINDOW_MS;
    return parsed.map(Number).filter((value) => Number.isFinite(value) && value > cutoff);
  } catch {
    return [];
  }
}

function reserveGeminiRequestSlot(): void {
  const now = Date.now();
  const recent = recentGeminiRequests();
  if (recent.length >= GEMINI_TTS_MAX_REQUESTS_PER_WINDOW) {
    const retryAfterSeconds = Math.max(2, Math.ceil((recent[0] + GEMINI_TTS_WINDOW_MS - now) / 1000));
    throw new GeminiTtsError("Gemini 요청이 잠시 많습니다.", 429, retryAfterSeconds);
  }
  recent.push(now);
  try { localStorage.setItem(GEMINI_TTS_REQUESTS_KEY, JSON.stringify(recent)); }
  catch { /* ignore */ }
}

function isQuotaError(message: string): boolean {
  return /요청이 잠시 많|quota|rate limit|resource exhausted|429/i.test(message);
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
    "us-male": ["guy", "david", "mark", "christopher", "andrew", "google us english male"],
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
  if (browserSequenceTimer) {
    window.clearTimeout(browserSequenceTimer);
    browserSequenceTimer = null;
  }
  browserSequenceResume = null;
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
  if (browserSequenceTimer) {
    window.clearTimeout(browserSequenceTimer);
    browserSequenceTimer = null;
  }
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
  if (browserSequenceResume) {
    const resume = browserSequenceResume;
    browserSequenceResume = null;
    resume();
    return true;
  }
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

  if (style === "reference") {
    // The uploaded school recording uses a calm classroom-reading cadence:
    // clearly stressed content words, restrained emotion and audible phrase boundaries.
    rate *= 0.94;
    pitch = preset === "us-male" || preset === "uk-male" ? 0.96 : 1.02;
    if (quoted) { pitch += 0.07; rate *= 0.98; }
    if (question) { pitch += 0.1; rate *= 0.96; }
    if (exclamation) { pitch += 0.07; rate *= 1.01; }
    if (/whisper|murmur|softly|quietly/.test(lower)) { volume = 0.78; pitch -= 0.06; rate *= 0.92; }
    if (/shout|yell|scream|roared/.test(lower)) { pitch += 0.1; rate *= 1.02; }
    if (/sad|sob|tear|lonely/.test(lower)) { pitch -= 0.07; rate *= 0.94; }
    if (/laugh|giggl|happy|delighted/.test(lower)) { pitch += 0.09; rate *= 1.01; }
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

function browserSegmentWeight(sentence: string): number {
  const words = sentence.trim().split(/\s+/).filter(Boolean).length;
  const commas = (sentence.match(/[,;:]/g) ?? []).length;
  const dialogueTurns = (sentence.match(/[“”"]/g) ?? []).length / 2;
  return Math.max(1, words + commas * 0.45 + dialogueTurns * 0.35 + 1.2);
}

function browserSpeak(text: string, options: SpeakOptions, generation = playbackGeneration): void {
  const fallbackSource = options.fallbackText?.trim() || text.trim();
  if (!("speechSynthesis" in window)) {
    pendingSpeech = false;
    options.onError?.("이 브라우저는 음성 읽기를 지원하지 않습니다.");
    return;
  }

  const storySegments = options.kind === "story"
    ? fallbackSource.split(/\n+/).map((item) => item.replace(/[\t ]+/g, " ").trim()).filter(Boolean)
    : [];
  const segments = storySegments.length > 0
    ? storySegments
    : [fallbackSource.replace(/\s+/g, " ").trim()].filter(Boolean);
  if (!segments.length) {
    pendingSpeech = false;
    options.onEnd?.();
    return;
  }

  const voicePreset = options.voicePreset ?? "us-female";
  const startRatio = Math.max(0, Math.min(0.98, Number(options.startAtRatio ?? 0)));
  const weights = segments.map(browserSegmentWeight);
  const totalWeight = Math.max(1, weights.reduce((sum, value) => sum + value, 0));
  const pauseBetweenSegments = options.kind === "story" ? 500 : 0;
  let completedWeight = 0;

  window.speechSynthesis.cancel();

  const emitProgress = (segmentIndex: number, segmentProgress: number) => {
    const before = weights.slice(0, segmentIndex).reduce((sum, value) => sum + value, 0);
    const localRatio = Math.max(0, Math.min(1, (before + weights[segmentIndex] * segmentProgress) / totalWeight));
    const fullRatio = startRatio + (1 - startRatio) * localRatio;
    options.onTimeUpdate?.(fullRatio, 1);
  };

  const speakSegment = (segmentIndex: number) => {
    if (generation !== playbackGeneration) return;
    if (segmentIndex >= segments.length) {
      pendingSpeech = false;
      options.onTimeUpdate?.(1, 1);
      options.onEnd?.();
      return;
    }
    if (pauseRequested) {
      pendingSpeech = true;
      browserSequenceResume = () => speakSegment(segmentIndex);
      return;
    }

    browserSequenceResume = null;
    const segment = segments[segmentIndex];
    const utterance = new SpeechSynthesisUtterance(segment);
    utterance.lang = presetLocale(voicePreset);
    const performanceSettings = browserPerformance(segment, options);
    utterance.rate = performanceSettings.rate;
    utterance.pitch = performanceSettings.pitch;
    utterance.volume = performanceSettings.volume;
    utterance.voice = getPreferredVoice(voicePreset) ?? null;

    let progressTimer: number | null = null;
    let elapsedSeconds = 0;
    let lastTickAt = 0;
    let lastProgress = 0;
    const wordCount = Math.max(1, segment.split(/\s+/).filter(Boolean).length);
    const punctuationCount = (segment.match(/[,;:!?]/g) ?? []).length;
    const estimatedDuration = Math.max(0.9, wordCount / Math.max(1, (155 * performanceSettings.rate) / 60) + punctuationCount * 0.12);

    const stopProgressTimer = () => {
      if (progressTimer) {
        window.clearInterval(progressTimer);
        progressTimer = null;
      }
    };
    const updateProgress = (value: number) => {
      lastProgress = Math.max(lastProgress, Math.min(0.98, value));
      emitProgress(segmentIndex, lastProgress);
    };

    utterance.onstart = () => {
      if (generation !== playbackGeneration) return;
      pendingSpeech = false;
      lastTickAt = performance.now();
      emitProgress(segmentIndex, 0);
      progressTimer = window.setInterval(() => {
        if (generation !== playbackGeneration) {
          stopProgressTimer();
          return;
        }
        const now = performance.now();
        if (!window.speechSynthesis.paused && !pauseRequested) {
          elapsedSeconds += Math.max(0, now - lastTickAt) / 1000;
          updateProgress(elapsedSeconds / estimatedDuration);
        }
        lastTickAt = now;
      }, 160);
      if (pauseRequested) window.speechSynthesis.pause();
    };
    utterance.onboundary = (event) => {
      if (generation !== playbackGeneration || !segment.length) return;
      updateProgress(event.charIndex / segment.length);
    };
    utterance.onend = () => {
      stopProgressTimer();
      if (generation !== playbackGeneration) return;
      emitProgress(segmentIndex, 1);
      completedWeight += weights[segmentIndex];
      pendingSpeech = segmentIndex < segments.length - 1;
      const continueSequence = () => speakSegment(segmentIndex + 1);
      if (pauseRequested) {
        browserSequenceResume = continueSequence;
        return;
      }
      if (pauseBetweenSegments > 0 && segmentIndex < segments.length - 1) {
        browserSequenceResume = continueSequence;
        browserSequenceTimer = window.setTimeout(() => {
          browserSequenceTimer = null;
          browserSequenceResume = null;
          continueSequence();
        }, pauseBetweenSegments);
      } else {
        continueSequence();
      }
    };
    utterance.onerror = () => {
      stopProgressTimer();
      if (generation !== playbackGeneration) return;
      pendingSpeech = false;
      options.onError?.("기기 음성 재생에 실패했습니다.");
    };
    window.speechSynthesis.speak(utterance);
  };

  void completedWeight;
  pendingSpeech = true;
  speakSegment(0);
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

function hashCacheText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function speechCacheKey(text: string, options: SpeakOptions): string {
  const kind = options.kind ?? "sentence";
  const voicePreset = options.voicePreset ?? "us-female";
  const narrationStyle = options.narrationStyle ?? "clear";
  return `tts-v3|${voicePreset}|${kind}|${narrationStyle}|${hashCacheText(text)}|${text.length}`;
}

async function trimPersistentAudioCache(): Promise<void> {
  try {
    const records = await db.speechAudio.orderBy("lastAccessedAt").toArray();
    let totalBytes = records.reduce((sum, record) => sum + Number(record.bytes || record.blob?.size || 0), 0);
    let excessEntries = Math.max(0, records.length - GEMINI_TTS_CACHE_LIMIT_ENTRIES);
    const deleteKeys: string[] = [];
    for (const record of records) {
      if (excessEntries <= 0 && totalBytes <= GEMINI_TTS_CACHE_LIMIT_BYTES) break;
      deleteKeys.push(record.key);
      totalBytes -= Number(record.bytes || record.blob?.size || 0);
      excessEntries -= 1;
      const url = audioCache.get(record.key);
      if (url) {
        URL.revokeObjectURL(url);
        audioCache.delete(record.key);
      }
    }
    if (deleteKeys.length) await db.speechAudio.bulkDelete(deleteKeys);
  } catch {
    // Audio cache cleanup must never block reading.
  }
}

async function getPersistentAudioUrl(cacheKey: string): Promise<string | undefined> {
  const memoryUrl = audioCache.get(cacheKey);
  if (memoryUrl) return memoryUrl;
  try {
    const record = await db.speechAudio.get(cacheKey);
    if (!record?.blob?.size) return undefined;
    const url = URL.createObjectURL(record.blob);
    audioCache.set(cacheKey, url);
    void db.speechAudio.update(cacheKey, { lastAccessedAt: Date.now() });
    return url;
  } catch {
    return undefined;
  }
}

async function savePersistentAudio(cacheKey: string, blob: Blob, options: SpeakOptions): Promise<void> {
  try {
    const now = Date.now();
    await db.speechAudio.put({
      key: cacheKey,
      blob,
      bytes: blob.size,
      updatedAt: now,
      lastAccessedAt: now,
      bookId: options.cacheContext?.bookId,
      pageId: options.cacheContext?.pageId,
    });
    void trimPersistentAudioCache();
  } catch {
    // IndexedDB may be full or disabled. In-memory playback still works.
  }
}

async function requestGeminiAudio(text: string, options: SpeakOptions): Promise<string> {
  const kind = options.kind ?? "sentence";
  const voicePreset = options.voicePreset ?? "us-female";
  const narrationStyle = options.narrationStyle ?? "clear";
  const cacheKey = speechCacheKey(text, options);
  const cached = await getPersistentAudioUrl(cacheKey);
  if (cached) return cached;

  reserveGeminiRequestSlot();
  const response = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, rate: 1, kind, voicePreset, narrationStyle }),
  });
  const raw = await response.text();
  let payload: { data?: string; mimeType?: string; error?: string; retryAfterSeconds?: number } = {};
  try { payload = raw ? JSON.parse(raw) : {}; }
  catch { throw new GeminiTtsError(raw || `고음질 음성 요청 실패 (${response.status})`, response.status); }

  if (!response.ok || !payload.data) {
    throw new GeminiTtsError(
      payload.error || `고음질 음성 요청 실패 (${response.status})`,
      response.status,
      Number(payload.retryAfterSeconds ?? response.headers.get("retry-after") ?? 0),
    );
  }

  const mimeType = payload.mimeType ?? "audio/L16;rate=24000";
  const bytes = base64ToBytes(payload.data);
  const blob = mimeType.includes("wav")
    ? new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: "audio/wav" })
    : pcmToWavBlob(bytes, Number(mimeType.match(/rate=(\d+)/)?.[1] ?? 24000));
  const url = URL.createObjectURL(blob);
  audioCache.set(cacheKey, url);
  await savePersistentAudio(cacheKey, blob, options);
  clearGeminiTtsCooldown();
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

    const playFromRequestedPosition = () => {
      if (generation !== playbackGeneration || currentAudio !== audio || pauseRequested) return;
      const ratio = Math.max(0, Math.min(0.98, Number(options.startAtRatio ?? 0)));
      if (ratio > 0 && Number.isFinite(audio.duration) && audio.duration > 0) {
        const position = Math.min(audio.duration - 0.05, audio.duration * ratio);
        try { audio.currentTime = Math.max(0, position); } catch { /* Safari retries after metadata */ }
      }
      void audio.play().catch(() => options.onError?.("음성을 재생하지 못했습니다. 재생 버튼을 다시 눌러 주세요."));
    };

    if (audio.readyState >= 1) playFromRequestedPosition();
    else audio.onloadedmetadata = playFromRequestedPosition;
  } catch (error) {
    if (generation !== playbackGeneration) return;
    const message = error instanceof Error ? error.message : "고음질 음성 생성에 실패했습니다.";
    if (isQuotaError(message) || (error instanceof GeminiTtsError && error.status === 429)) {
      const retryAfterSeconds = error instanceof GeminiTtsError ? error.retryAfterSeconds : 65;
      const cooldownSeconds = startGeminiTtsCooldown(retryAfterSeconds);
      if (!quotaNoticeShown) {
        quotaNoticeShown = true;
        const wait = cooldownSeconds >= 120 ? `${Math.ceil(cooldownSeconds / 60)}분` : `${cooldownSeconds}초`;
        options.onError?.(`Gemini 요청이 잠시 많아 기기 음성으로 재생합니다. 약 ${wait} 후 고품질 음성을 다시 사용할 수 있습니다.`);
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
      const remainingSeconds = Math.max(1, Math.ceil((geminiTtsCooldownUntil() - Date.now()) / 1000));
      const wait = remainingSeconds >= 120 ? `${Math.ceil(remainingSeconds / 60)}분` : `${remainingSeconds}초`;
      options.onError?.(`Gemini 요청이 잠시 많아 기기 음성으로 재생합니다. 약 ${wait} 후 고품질 음성을 다시 사용할 수 있습니다.`);
    }
  }
  browserSpeak(cleanText, options, generation);
}

export function speakText(text: string, options: SpeakOptions = {}): void {
  const cleanText = text
    .split(/\r?\n/)
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!cleanText) return;
  startSpeech(cleanText, options);
}
