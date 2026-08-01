import { useEffect, useMemo, useRef, useState } from "react";
import PageTextEditor from "../components/PageTextEditor";
import ReadingTextLayer from "../components/ReadingTextLayer";
import { useObjectUrl } from "../hooks/useObjectUrl";
import { getBook, updateBook } from "../services/BookService";
import { pauseSpeech, resumeSpeech, speakText, stopSpeech, VOICE_PRESETS, type SpeechEngine, type VoicePreset } from "../services/SpeechService";
import { extractPageText, type AnalysisProgress } from "../services/VisionService";
import { bestRecordingMimeType, evaluatePronunciation, type PronunciationEvaluation } from "../services/PronunciationService";
import type { Book } from "../types/Book";

interface Props { bookId: string; onBack: () => void; }

function ReaderImage({ image, title, pageNumber, children }: { image?: Blob; title: string; pageNumber: number; children?: React.ReactNode }) {
  const url = useObjectUrl(image);
  if (!url) return <div className="reader-empty-image">이미지를 불러오지 못했습니다.</div>;
  return (
    <div className="reader-image-frame">
      <img className="reader-image" src={url} alt={`${title} ${pageNumber}페이지`} />
      {children}
    </div>
  );
}

function splitSentences(text: string): string[] {
  return text.replace(/\s+/g, " ").match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((item) => item.trim()).filter(Boolean) ?? [];
}

export default function Reader({ bookId, onBack }: Props) {
  const [book, setBook] = useState<Book | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [rate, setRate] = useState(0.86);
  const [speechEngine] = useState<SpeechEngine>("gemini");
  const [voicePreset, setVoicePreset] = useState<VoicePreset>(() => (localStorage.getItem("talktalk.voicePreset") as VoicePreset) || "us-female");
  const [speechNotice, setSpeechNotice] = useState("");
  const [followReading, setFollowReading] = useState(false);
  const [readingMode, setReadingMode] = useState<"idle" | "story" | "follow" | "evaluate">("idle");
  const [readingPaused, setReadingPaused] = useState(false);
  const [storySentenceIndex, setStorySentenceIndex] = useState(0);
  const [storyAudioProgress, setStoryAudioProgress] = useState(0);
  const [showBoxes, setShowBoxes] = useState(false);
  const [analysisError, setAnalysisError] = useState("");
  const [analysisProgress, setAnalysisProgress] = useState<AnalysisProgress | null>(null);
  const [queueRunning, setQueueRunning] = useState(false);
  const [fullscreenMode, setFullscreenMode] = useState(false);
  const [fullscreenControls, setFullscreenControls] = useState(true);
  const [practiceState, setPracticeState] = useState<"idle" | "listening" | "recording" | "evaluating" | "passed" | "retry" | "error">("idle");
  const [practiceSentence, setPracticeSentence] = useState("");
  const [practiceResult, setPracticeResult] = useState<PronunciationEvaluation | null>(null);
  const [practiceAttempt, setPracticeAttempt] = useState(0);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [followDisplayIndex, setFollowDisplayIndex] = useState(0);
  const [microphonePermission, setMicrophonePermission] = useState<"unknown" | "granted" | "denied" | "unsupported">("unknown");
  const followTimer = useRef<number | null>(null);
  const followSentences = useRef<string[]>([]);
  const followIndex = useRef(0);
  const followWaiting = useRef(false);
  const readingPausedRef = useRef(false);
  const storyIndexRef = useRef(0);
  const storySentencesRef = useRef<string[]>([]);
  const fullscreenRoot = useRef<HTMLElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordingTimerRef = useRef<number | null>(null);
  const recordingTickRef = useRef<number | null>(null);
  const discardRecordingRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const silenceFrameRef = useRef<number | null>(null);
  const recordingStartedAtRef = useRef(0);

  function changeVoicePreset(value: VoicePreset) {
    setVoicePreset(value);
    localStorage.setItem("talktalk.voicePreset", value);
    const label = VOICE_PRESETS.find((item) => item.id === value)?.label ?? "선택한 음성";
    setSpeechNotice(`${label} 고음질 음성을 사용합니다. 처음 재생은 몇 초 걸릴 수 있습니다.`);
  }

  function handleSpeechError(message: string) {
    setSpeechNotice(message);
  }

  useEffect(() => {
    let active = true;
    void getBook(bookId).then((result) => {
      if (!active) return;
      setBook(result ?? null);
      const total = result?.pages.length ?? 0;
      const restored = total > 0 ? Math.min(total - 1, Math.max(0, Math.round(((result?.progress ?? 0) / 100) * total) - 1)) : 0;
      setPageIndex(restored);
      setLoading(false);
    });
    return () => {
      active = false;
      stopSpeech();
      if (followTimer.current) window.clearTimeout(followTimer.current);
      if (recordingTimerRef.current) window.clearTimeout(recordingTimerRef.current);
      if (recordingTickRef.current) window.clearInterval(recordingTickRef.current);
      mediaRecorderRef.current?.stop();
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      if (silenceFrameRef.current) cancelAnimationFrame(silenceFrameRef.current);
      void audioContextRef.current?.close();
    };
  }, [bookId]);

  const orderedPages = useMemo(() => [...(book?.pages ?? [])].sort((a, b) => a.order - b.order), [book]);
  const currentPage = orderedPages[pageIndex];
  const currentText = currentPage?.analysis?.fullText?.trim() || currentPage?.text?.trim() || "";
  const analysis = currentPage?.analysis;
  const storySentences = useMemo(() => analysis?.sentences.map((item) => item.text).filter(Boolean) ?? splitSentences(currentText), [analysis, currentText]);
  const analyzing = currentPage?.status === "processing";

  useEffect(() => {
    if (readingMode === "idle") return;
    const index = readingMode === "story" ? storySentenceIndex : followDisplayIndex;
    const element = document.querySelector(`[data-reading-sentence="${index}"]`);
    element?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [followDisplayIndex, readingMode, storySentenceIndex]);

  async function persistBook(nextBook: Book) {
    setBook(nextBook);
    await updateBook(nextBook);
  }

  async function moveTo(nextIndex: number) {
    if (!book || orderedPages.length === 0) return;
    stopSpeech();
    setFollowReading(false);
    setReadingMode("idle");
    setReadingPaused(false);
    readingPausedRef.current = false;
    setStorySentenceIndex(0);
    setStoryAudioProgress(0);
    setFollowDisplayIndex(0);
    storyIndexRef.current = 0;
    storySentencesRef.current = [];
    setAnalysisError("");
    stopPracticeRecording(true);
    const safeIndex = Math.max(0, Math.min(orderedPages.length - 1, nextIndex));
    setPageIndex(safeIndex);
    const progress = Math.round(((safeIndex + 1) / orderedPages.length) * 100);
    if (progress !== book.progress) await persistBook({ ...book, progress });
  }

  async function savePageText(text: string) {
    if (!book || !currentPage) return;
    const pages = book.pages.map((page) => page.id === currentPage.id ? { ...page, text, status: text ? "ready" as const : "pending" as const } : page);
    await persistBook({ ...book, pages });
  }

  async function runAiAnalysis() {
    if (!book || !currentPage || analyzing) return;
    setAnalysisError("");
    const processingPages = book.pages.map((page) => page.id === currentPage.id ? { ...page, status: "processing" as const, errorMessage: undefined } : page);
    const processingBook = { ...book, pages: processingPages };
    await persistBook(processingBook);

    try {
      const result = await extractPageText(currentPage.image, setAnalysisProgress);
      const pages = processingBook.pages.map((page) => page.id === currentPage.id ? {
        ...page,
        status: "ready" as const,
        text: result.fullText,
        analysis: result,
        errorMessage: undefined,
      } : page);
      await persistBook({ ...processingBook, pages });
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI 분석에 실패했습니다.";
      setAnalysisError(message);
      const pages = processingBook.pages.map((page) => page.id === currentPage.id ? { ...page, status: "error" as const, errorMessage: message } : page);
      await persistBook({ ...processingBook, pages });
    } finally {
      setAnalysisProgress(null);
    }
  }

  async function analyzeAllPendingPages() {
    if (!book || queueRunning) return;
    setQueueRunning(true);
    setAnalysisError("");
    let workingBook = book;
    const pending = [...workingBook.pages].sort((a, b) => a.order - b.order).filter((page) => !page.analysis);
    try {
      for (let index = 0; index < pending.length; index += 1) {
        const target = pending[index];
        setAnalysisProgress({ completed: index, total: pending.length, label: `${index + 1} / ${pending.length} 페이지 준비 중` });
        workingBook = { ...workingBook, pages: workingBook.pages.map((page) => page.id === target.id ? { ...page, status: "processing" as const, errorMessage: undefined } : page) };
        await persistBook(workingBook);
        try {
          const result = await extractPageText(target.image, (progress) => setAnalysisProgress({ completed: index, total: pending.length, label: `${index + 1}페이지 · ${progress.label}` }));
          workingBook = { ...workingBook, pages: workingBook.pages.map((page) => page.id === target.id ? { ...page, status: "ready" as const, text: result.fullText, analysis: result, errorMessage: undefined } : page) };
        } catch (error) {
          const message = error instanceof Error ? error.message : "AI 분석에 실패했습니다.";
          workingBook = { ...workingBook, pages: workingBook.pages.map((page) => page.id === target.id ? { ...page, status: "error" as const, errorMessage: message } : page) };
          setAnalysisError(`${target.order}페이지: ${message}`);
        }
        await persistBook(workingBook);
      }
    } finally {
      setQueueRunning(false);
      setAnalysisProgress(null);
    }
  }


  async function requestMicrophonePermission(): Promise<boolean> {
    if (!window.isSecureContext) {
      setMicrophonePermission("unsupported");
      setPracticeState("error");
      setSpeechNotice("마이크는 HTTPS 주소 또는 localhost에서만 사용할 수 있습니다. 배포된 https:// 주소나 http://localhost:8888로 접속해 주세요.");
      return false;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMicrophonePermission("unsupported");
      setPracticeState("error");
      setSpeechNotice("이 브라우저에서는 마이크 녹음을 지원하지 않습니다. Safari, Chrome 또는 Edge를 최신 버전으로 업데이트해 주세요.");
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      stream.getTracks().forEach((track) => track.stop());
      setMicrophonePermission("granted");
      setSpeechNotice("마이크 사용이 허용되었습니다. 문장을 들은 뒤 따라 읽어 주세요.");
      return true;
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      const denied = ["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(name);
      setMicrophonePermission(denied ? "denied" : "unsupported");
      setPracticeState("error");
      setSpeechNotice(denied
        ? "마이크 권한이 거부되었습니다. 주소창의 사이트 설정에서 마이크를 허용한 뒤 다시 눌러 주세요."
        : "마이크를 시작하지 못했습니다. 다른 앱에서 마이크를 사용 중인지 확인해 주세요.");
      return false;
    }
  }

  function speakKoreanFeedback(text: string, onEnd?: () => void) {
    if (!("speechSynthesis" in window)) {
      onEnd?.();
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ko-KR";
    utterance.rate = 0.95;
    utterance.pitch = 1.05;
    utterance.onend = () => onEnd?.();
    utterance.onerror = () => onEnd?.();
    window.speechSynthesis.speak(utterance);
  }

  function clearRecordingTimers() {
    if (recordingTimerRef.current) {
      window.clearTimeout(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    if (recordingTickRef.current) {
      window.clearInterval(recordingTickRef.current);
      recordingTickRef.current = null;
    }
    if (silenceFrameRef.current) {
      cancelAnimationFrame(silenceFrameRef.current);
      silenceFrameRef.current = null;
    }
    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }
  }

  function stopPracticeRecording(discard = false) {
    discardRecordingRef.current = discard;
    clearRecordingTimers();
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  }

  async function beginPracticeRecording(sentence: string) {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setPracticeState("error");
      setSpeechNotice("이 브라우저에서는 마이크 녹음을 지원하지 않습니다. Safari를 최신 버전으로 업데이트해 주세요.");
      return;
    }

    try {
      discardRecordingRef.current = false;
      setPracticeResult(null);
      setPracticeState("recording");
      setRecordingSeconds(0);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      mediaStreamRef.current = stream;
      const mimeType = bestRecordingMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
      recorder.onstop = async () => {
        clearRecordingTimers();
        stream.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;
        if (discardRecordingRef.current) return;
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
        if (blob.size < 1000) {
          setPracticeState("retry");
          setSpeechNotice("목소리가 잘 들리지 않았어요. 문장을 다시 듣고 조금 더 크게 말해 주세요.");
          followTimer.current = window.setTimeout(playEvaluationSentence, 700);
          return;
        }
        setPracticeState("evaluating");
        try {
          const result = await evaluatePronunciation(sentence, blob);
          setPracticeResult(result);
          if (result.overallScore >= 90) {
            setPracticeState("passed");
            setPracticeAttempt(0);
            setSpeechNotice(`정확도 ${result.overallScore}점! ${result.feedbackKo}`);
            followIndex.current += 1;
            speakKoreanFeedback("90점 이상이에요! 다음 문장으로 갈게요.", () => {
              followTimer.current = window.setTimeout(playEvaluationSentence, 350);
            });
          } else {
            setPracticeState("retry");
            setPracticeAttempt((value) => value + 1);
            const missed = result.missedWords.length ? ` 다시 연습할 단어: ${result.missedWords.join(", ")}` : "";
            setSpeechNotice(`정확도 ${result.overallScore}점. ${result.feedbackKo}${missed}`);
            speakKoreanFeedback("90점까지 한 번 더 연습해 볼까요?", () => {
              followTimer.current = window.setTimeout(playEvaluationSentence, 350);
            });
          }
        } catch (error) {
          setPracticeState("error");
          setSpeechNotice(error instanceof Error ? error.message : "발음 평가에 실패했습니다.");
          followTimer.current = window.setTimeout(playEvaluationSentence, 900);
        }
      };
      recorder.start(180);
      recordingStartedAtRef.current = performance.now();

      // Stop shortly after the child finishes speaking so scoring starts immediately.
      const AudioContextClass = window.AudioContext;
      if (AudioContextClass) {
        const audioContext = new AudioContextClass();
        audioContextRef.current = audioContext;
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.2;
        source.connect(analyser);
        const samples = new Uint8Array(analyser.fftSize);
        let heardVoice = false;
        let lastVoiceAt = performance.now();
        const monitorSilence = () => {
          if (recorder.state === "inactive") return;
          analyser.getByteTimeDomainData(samples);
          let sum = 0;
          for (const sample of samples) {
            const normalized = (sample - 128) / 128;
            sum += normalized * normalized;
          }
          const rms = Math.sqrt(sum / samples.length);
          const now = performance.now();
          if (rms > 0.035) {
            heardVoice = true;
            lastVoiceAt = now;
          }
          if (heardVoice && now - lastVoiceAt > 850 && now - recordingStartedAtRef.current > 1200) {
            stopPracticeRecording(false);
            return;
          }
          silenceFrameRef.current = requestAnimationFrame(monitorSilence);
        };
        silenceFrameRef.current = requestAnimationFrame(monitorSilence);
      }

      const wordCount = sentence.trim().split(/\s+/).length;
      const maxSeconds = Math.max(4, Math.min(10, Math.ceil(wordCount * 0.75 + 2.5)));
      recordingTickRef.current = window.setInterval(() => setRecordingSeconds((value) => value + 1), 1000);
      recordingTimerRef.current = window.setTimeout(() => stopPracticeRecording(false), maxSeconds * 1000);
    } catch (error) {
      setPracticeState("error");
      const denied = error instanceof DOMException && ["NotAllowedError", "PermissionDeniedError"].includes(error.name);
      setSpeechNotice(denied ? "마이크 권한이 필요합니다. Safari 주소창의 설정에서 마이크를 허용해 주세요." : "마이크를 시작하지 못했습니다.");
    }
  }

  function finishSpeakingNow() {
    if (practiceState === "recording") stopPracticeRecording(false);
  }

  function finishReading() {
    stopPracticeRecording(true);
    setPracticeState("idle");
    setPracticeSentence("");
    setPracticeResult(null);
    setPracticeAttempt(0);
    setFollowDisplayIndex(0);
    setReadingMode("idle");
    setReadingPaused(false);
    readingPausedRef.current = false;
    setFollowReading(false);
    followWaiting.current = false;
    if (followTimer.current) {
      window.clearTimeout(followTimer.current);
      followTimer.current = null;
    }
  }

  function playStorySentence(index: number) {
    const sentences = storySentencesRef.current;
    if (!sentences.length || index >= sentences.length) {
      finishReading();
      return;
    }
    const safeIndex = Math.max(0, Math.min(sentences.length - 1, index));
    storyIndexRef.current = safeIndex;
    setStorySentenceIndex(safeIndex);
    setStoryAudioProgress(0);
    speakText(sentences[safeIndex], {
      rate,
      engine: speechEngine,
      voicePreset,
      kind: "sentence",
      onError: handleSpeechError,
      onTimeUpdate: (current, duration) => {
        setStoryAudioProgress(duration > 0 ? Math.min(1, current / duration) : 0);
      },
      onEnd: () => {
        if (readingPausedRef.current) return;
        const next = safeIndex + 1;
        if (next >= sentences.length) {
          finishReading();
          return;
        }
        playStorySentence(next);
      },
    });
  }

  function startStoryReading(fromIndex = 0) {
    if (!currentText || !storySentences.length) return;
    stopSpeech();
    finishReading();
    storySentencesRef.current = storySentences;
    const safeIndex = Math.max(0, Math.min(storySentences.length - 1, fromIndex));
    storyIndexRef.current = safeIndex;
    setStorySentenceIndex(safeIndex);
    setReadingMode("story");
    setReadingPaused(false);
    readingPausedRef.current = false;
    playStorySentence(safeIndex);
  }

  function startStoryFromScroll(index: number) {
    const safeIndex = Math.max(0, Math.min(Math.max(0, storySentences.length - 1), index));
    setStorySentenceIndex(safeIndex);
    storyIndexRef.current = safeIndex;
    setStoryAudioProgress(0);
    startStoryReading(safeIndex);
  }

  function playEvaluationSentence() {
    const sentences = followSentences.current;
    const index = followIndex.current;
    if (index >= sentences.length) {
      speakKoreanFeedback("오늘 따라 읽기를 모두 마쳤어요. 정말 잘했어요!", finishReading);
      return;
    }

    const sentence = sentences[index];
    setFollowDisplayIndex(index);
    followWaiting.current = false;
    setPracticeSentence(sentence);
    setPracticeState("listening");
    speakText(sentence, {
      rate,
      engine: speechEngine,
      voicePreset,
      kind: "sentence",
      onError: handleSpeechError,
      onEnd: () => {
        if (readingPausedRef.current) {
          followWaiting.current = true;
          return;
        }
        void beginPracticeRecording(sentence);
      },
    });
  }

  async function startEvaluationReading() {
    const sentences = analysis?.sentences.map((item) => item.text) ?? splitSentences(currentText);
    if (!sentences.length) return;

    // Permission must be requested directly from the user's click event.
    // This is required by Safari, Chrome and Edge.
    const allowed = microphonePermission === "granted" || await requestMicrophonePermission();
    if (!allowed) return;

    stopSpeech();
    finishReading();
    followSentences.current = sentences;
    followIndex.current = 0;
    setPracticeAttempt(0);
    setPracticeResult(null);
    setFollowReading(true);
    setReadingMode("evaluate");
    setFollowDisplayIndex(0);
    setReadingPaused(false);
    readingPausedRef.current = false;
    playEvaluationSentence();
  }

  function playBasicFollowSentence() {
    const sentences = followSentences.current;
    const index = followIndex.current;
    if (index >= sentences.length) {
      speakKoreanFeedback("따라 읽기를 모두 마쳤어요!", finishReading);
      return;
    }
    const sentence = sentences[index];
    setFollowDisplayIndex(index);
    setPracticeSentence(sentence);
    followWaiting.current = false;
    speakText(sentence, {
      rate, engine: speechEngine, voicePreset, kind: "sentence", onError: handleSpeechError,
      onEnd: () => {
        if (readingPausedRef.current) { followWaiting.current = true; return; }
        followWaiting.current = true;
        followTimer.current = window.setTimeout(() => {
          followWaiting.current = false;
          followIndex.current += 1;
          playBasicFollowSentence();
        }, 3000);
      },
    });
  }

  function startBasicFollowReading() {
    const sentences = analysis?.sentences.map((item) => item.text) ?? splitSentences(currentText);
    if (!sentences.length) return;
    stopSpeech();
    finishReading();
    followSentences.current = sentences;
    followIndex.current = 0;
    setFollowDisplayIndex(0);
    setPracticeSentence(sentences[0]);
    setFollowReading(true);
    setReadingMode("follow");
    setReadingPaused(false);
    readingPausedRef.current = false;
    playBasicFollowSentence();
  }

  function togglePauseResume() {
    if (readingMode === "idle") return;

    if (readingPausedRef.current) {
      setReadingPaused(false);
      readingPausedRef.current = false;

      if (readingMode === "story") {
        const resumed = resumeSpeech();
        if (!resumed) playStorySentence(storyIndexRef.current);
        return;
      }

      // During sentence playback, resume from the exact audio position.
      if (!followWaiting.current && (readingMode === "follow" || practiceState === "listening")) {
        const resumed = resumeSpeech();
        if (resumed) return;
      }

      // Waiting periods and recordings resume by replaying the current prompt.
      followWaiting.current = false;
      if (readingMode === "follow") playBasicFollowSentence();
      else playEvaluationSentence();
      return;
    }

    readingPausedRef.current = true;
    setReadingPaused(true);

    if (practiceState === "recording") {
      stopPracticeRecording(true);
      followWaiting.current = true;
      setPracticeState("listening");
      return;
    }
    if (followTimer.current) {
      window.clearTimeout(followTimer.current);
      followTimer.current = null;
      followWaiting.current = true;
      return;
    }
    pauseSpeech();
  }

  useEffect(() => {
    function syncFullscreenState() {
      const active = Boolean(document.fullscreenElement);
      if (!active && fullscreenMode) setFullscreenMode(false);
    }
    document.addEventListener("fullscreenchange", syncFullscreenState);
    return () => document.removeEventListener("fullscreenchange", syncFullscreenState);
  }, [fullscreenMode]);

  useEffect(() => {
    if (!fullscreenMode) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [fullscreenMode]);

  async function enterFullscreen() {
    setFullscreenMode(true);
    setFullscreenControls(true);
    const root = fullscreenRoot.current;
    if (!root || !root.requestFullscreen) return;
    try { await root.requestFullscreen(); } catch {
      // iPhone Safari may not support the Fullscreen API for ordinary elements.
      // The app-level fullscreen layout remains active as a fallback.
    }
  }

  async function exitFullscreen() {
    if (document.fullscreenElement && document.exitFullscreen) {
      try { await document.exitFullscreen(); } catch { /* app layout still exits */ }
    }
    setFullscreenMode(false);
    setFullscreenControls(true);
  }

  function toggleFullscreenControls(event: React.MouseEvent<HTMLElement>) {
    if (!fullscreenMode) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, select, label, .coordinate-overlay")) return;
    setFullscreenControls((value) => !value);
  }

  if (loading) return <main className="reader-page"><div className="reader-message">책을 여는 중입니다…</div></main>;
  if (!book) return <main className="reader-page"><div className="reader-message"><h2>책을 찾을 수 없습니다.</h2><button className="primary-button" type="button" onClick={onBack}>책장으로 돌아가기</button></div></main>;

  const isFirst = pageIndex === 0;
  const isLast = pageIndex === orderedPages.length - 1;
  const activeSentenceIndex = readingMode === "story" ? storySentenceIndex : followDisplayIndex;
  const activeSentence = storySentences[activeSentenceIndex] ?? practiceSentence ?? "";

  return (
    <main
      ref={fullscreenRoot}
      className={`reader-page${fullscreenMode ? " reader-fullscreen" : ""}${fullscreenControls ? " controls-visible" : " controls-hidden"}`}
      onClick={toggleFullscreenControls}
    >
      <div className="reader-topbar">
        <button className="reader-back-button" type="button" onClick={onBack}>← 책장</button>
        <div className="reader-title-block"><strong>{book.title}</strong><span>{orderedPages.length ? `${pageIndex + 1} / ${orderedPages.length} 페이지` : "페이지 없음"}</span></div>
        <div className="reader-top-actions">
          <span className="reader-progress-pill">{book.progress}%</span>
          <button className="fullscreen-button" type="button" onClick={() => void enterFullscreen()} aria-label="책을 전체 화면으로 보기">⛶ 전체 화면</button>
        </div>
      </div>

      {orderedPages.length === 0 ? <div className="reader-message">이 책에는 등록된 페이지가 없습니다.</div> : (
        <>
          <section className="reader-stage" aria-label={`${pageIndex + 1}페이지`}>
            <ReaderImage image={currentPage?.image} title={book.title} pageNumber={pageIndex + 1}>
              {analysis && <ReadingTextLayer analysis={analysis} rate={rate} showBoxes={showBoxes} speechEngine={speechEngine} voicePreset={voicePreset} onSpeechError={handleSpeechError} />}
            </ReaderImage>
            <div className="reader-page-badge">{pageIndex + 1}</div>
            {(analyzing || queueRunning) && <div className="analysis-mask"><span className="analysis-spinner" />{analysisProgress?.label || "AI가 글자를 읽고 있습니다…"}{analysisProgress && <small>{analysisProgress.completed} / {analysisProgress.total}</small>}</div>}
          </section>

          <section className="reading-toolbar" aria-label="읽기 도구">
            <button className="ai-button" type="button" disabled={analyzing || queueRunning} onClick={() => void runAiAnalysis()}>{analyzing ? "분석 중…" : analysis ? "↻ 현재 페이지 재인식" : "✨ 현재 페이지 인식"}</button>
            <button className="secondary-button" type="button" disabled={analyzing || queueRunning || !book.pages.some((page) => !page.analysis)} onClick={() => void analyzeAllPendingPages()}>{queueRunning ? "책 전체 분석 중…" : "⚡ 미분석 페이지 모두"}</button>
            <button className="primary-button" type="button" disabled={!currentText} onClick={() => startStoryReading(storySentenceIndex)}>▶ 전체 읽기</button>
            <button className="secondary-button" type="button" disabled={!currentText || followReading} onClick={startBasicFollowReading}>🗣️ 따라 읽기</button>
            <button className="secondary-button" type="button" disabled={!currentText || followReading} onClick={() => void startEvaluationReading()}>🎤 따라 읽기 평가</button>
            <button className="secondary-button pause-resume-button" type="button" disabled={readingMode === "idle"} onClick={togglePauseResume}>{readingPaused ? "▶ 계속 읽기" : "⏸ 멈춤"}</button>
            <button className="secondary-button" type="button" onClick={() => setEditorOpen(true)}>{currentText ? "텍스트 수정" : "직접 입력"}</button>
            {analysis && <button className="secondary-button" type="button" onClick={() => setShowBoxes((value) => !value)}>{showBoxes ? "터치 영역 숨기기" : "터치 영역 보기"}</button>}
            <label className="voice-control">음성 <select value={voicePreset} onChange={(event) => changeVoicePreset(event.target.value as VoicePreset)}>{VOICE_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</select></label>
            <label className="speed-control">속도 <input type="range" min="0.6" max="1.2" step="0.05" value={rate} onChange={(event) => setRate(Number(event.target.value))} /><span>{rate.toFixed(2)}x</span></label>
          </section>

          {analysisError && <p className="analysis-error" role="alert">{analysisError}</p>}
          {speechNotice && <p className="speech-notice" role="status">{speechNotice}</p>}
          {readingMode !== "idle" && activeSentence && (
            <section className="reading-follow-panel" aria-live="polite">
              <div className="reading-follow-header">
                <strong>{readingMode === "story" ? "전체 읽기" : readingMode === "follow" ? "따라 읽기" : "따라 읽기 평가"}</strong>
                <span>{activeSentenceIndex + 1} / {storySentences.length}</span>
              </div>
              <p className="reading-follow-current">{activeSentence}</p>
              <div className="reading-follow-sentences" aria-label="읽는 문장 따라보기">
                {storySentences.map((sentence, index) => (
                  <button
                    key={`${index}-${sentence}`}
                    type="button"
                    data-reading-sentence={index}
                    className={index === activeSentenceIndex ? "is-active" : index < activeSentenceIndex ? "is-complete" : ""}
                    onClick={() => startStoryFromScroll(index)}
                  >
                    <span>{index + 1}</span>{sentence}
                  </button>
                ))}
              </div>
            </section>
          )}
          {readingMode === "evaluate" && practiceSentence && (
            <section className={`practice-panel practice-${practiceState}`} aria-live="polite">
              <div className="practice-panel-header">
                <strong>따라 읽기 평가</strong>
                <span>{followIndex.current + 1} / {followSentences.current.length}</span>
              </div>
              <p className="practice-target">{practiceSentence}</p>
              {microphonePermission !== "granted" && (
                <p className="microphone-permission-hint">🎙️ 따라 읽기를 시작하면 브라우저가 마이크 권한을 요청합니다. 반드시 “허용”을 눌러 주세요.</p>
              )}
              <div className="practice-status-row">
                {practiceState === "listening" && <span>🔊 문장을 잘 들어보세요.</span>}
                {practiceState === "recording" && <span className="recording-status"><i /> 녹음 중 · {recordingSeconds}초</span>}
                {practiceState === "evaluating" && <span>⚡ 빠르게 점수를 계산하고 있어요…</span>}
                {practiceState === "passed" && <span>🎉 90점 이상, 통과했어요!</span>}
                {practiceState === "retry" && <span>🔁 90점 이상이 될 때까지 다시 연습해요.</span>}
                {practiceState === "error" && <span>⚠️ 다시 시도할게요.</span>}
                {practiceAttempt > 0 && <small>도전 {practiceAttempt + 1}회</small>}
              </div>
              {practiceState === "recording" && <button className="finish-speaking-button" type="button" onClick={finishSpeakingNow}>말하기 완료</button>}
              {practiceResult && (
                <div className="practice-result-grid">
                  <div><strong>{practiceResult.overallScore}</strong><span>종합 점수</span></div>
                  <div><strong>{practiceResult.accuracyScore}</strong><span>단어 정확도</span></div>
                  <div><strong>{practiceResult.pronunciationScore}</strong><span>발음 명료도</span></div>
                  <p><b>인식된 문장:</b> {practiceResult.transcript || "인식되지 않음"}</p>
                  {practiceResult.missedWords.length > 0 && <p><b>다시 볼 단어:</b> {practiceResult.missedWords.join(", ")}</p>}
                </div>
              )}
            </section>
          )}
          {!currentText && !analysisError && <p className="reader-help">“현재 페이지 인식” 또는 “미분석 페이지 모두”를 누르면 문장과 단어 위치를 자동으로 찾습니다. 두 쪽이 함께 찍힌 사진은 좌우로 나눠 빠르게 분석합니다.</p>}
          {analysis && <p className="reader-help">파란 단어 영역을 누르면 단어 발음, 문장 영역을 누르면 문장 전체 발음이 재생됩니다.</p>}

          {storySentences.length > 0 && (
            <section className="page-reading-scroll" aria-label="현재 페이지 읽기 위치">
              <div className="page-reading-scroll-header">
                <strong>페이지 읽기 위치</strong>
                <span>{storySentenceIndex + 1} / {storySentences.length} 문장</span>
              </div>
              <input
                type="range"
                min="0"
                max={Math.max(0, storySentences.length - 1)}
                step="1"
                value={Math.min(storySentenceIndex, Math.max(0, storySentences.length - 1))}
                onChange={(event) => setStorySentenceIndex(Number(event.target.value))}
                onPointerUp={(event) => startStoryFromScroll(Number((event.currentTarget as HTMLInputElement).value))}
                onKeyUp={(event) => {
                  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) startStoryFromScroll(Number(event.currentTarget.value));
                }}
              />
              <div className="page-reading-scroll-progress" aria-hidden="true"><span style={{ width: `${((storySentenceIndex + storyAudioProgress) / Math.max(1, storySentences.length)) * 100}%` }} /></div>
              <p>{storySentences[storySentenceIndex] ?? ""}</p>
            </section>
          )}

          <div className="reader-progress-track" aria-label={`책 진행률 ${book.progress}%`}><div className="reader-progress-value" style={{ width: `${book.progress}%` }} /></div>
          <nav className="reader-controls" aria-label="페이지 이동">
            <button className="secondary-button reader-nav-button" type="button" disabled={isFirst} onClick={() => void moveTo(pageIndex - 1)}>← 이전 페이지</button>
            <button className="primary-button reader-nav-button" type="button" disabled={isLast} onClick={() => void moveTo(pageIndex + 1)}>다음 페이지 →</button>
          </nav>

          {fullscreenMode && (
            <>
              <div className="fullscreen-top-controls" aria-label="전체 화면 상단 도구">
                <button type="button" className="fullscreen-round-button" onClick={() => void exitFullscreen()} aria-label="전체 화면 종료">✕</button>
                <div className="fullscreen-page-title"><strong>{book.title}</strong><span>{pageIndex + 1} / {orderedPages.length}</span></div>
                <button type="button" className="fullscreen-round-button" onClick={() => setFullscreenControls((value) => !value)} aria-label="컨트롤 표시 또는 숨기기">{fullscreenControls ? "◉" : "○"}</button>
              </div>

              {storySentences.length > 0 && (
                <div className="fullscreen-reading-scroll" onClick={(event) => event.stopPropagation()}>
                  <div><strong>{storySentenceIndex + 1}</strong><span>/ {storySentences.length} 문장</span></div>
                  <input
                    type="range"
                    min="0"
                    max={Math.max(0, storySentences.length - 1)}
                    step="1"
                    value={Math.min(storySentenceIndex, Math.max(0, storySentences.length - 1))}
                    onChange={(event) => setStorySentenceIndex(Number(event.target.value))}
                    onPointerUp={(event) => startStoryFromScroll(Number((event.currentTarget as HTMLInputElement).value))}
                    aria-label="페이지 읽기 시작 위치"
                  />
                </div>
              )}
              {readingMode !== "idle" && activeSentence && (
                <div className="fullscreen-current-sentence" onClick={(event) => event.stopPropagation()}>
                  <span>{activeSentenceIndex + 1} / {storySentences.length}</span>
                  <strong>{activeSentence}</strong>
                </div>
              )}
              <div className="fullscreen-bottom-controls" aria-label="전체 화면 읽기 컨트롤">
                <button type="button" disabled={isFirst} onClick={() => void moveTo(pageIndex - 1)} aria-label="이전 페이지">‹</button>
                <button type="button" disabled={!currentText} onClick={() => startStoryReading(storySentenceIndex)} aria-label="전체 읽기">▶<span>읽기</span></button>
                <button type="button" disabled={!currentText || followReading} onClick={startBasicFollowReading} aria-label="따라 읽기">🗣️<span>따라</span></button>
                <button type="button" disabled={!currentText || followReading} onClick={() => void startEvaluationReading()} aria-label="따라 읽기 평가">🎤<span>평가</span></button>
                <button type="button" disabled={readingMode === "idle"} onClick={togglePauseResume} aria-label={readingPaused ? "멈춘 곳부터 계속 읽기" : "읽기 일시정지"}>{readingPaused ? "▶" : "⏸"}<span>{readingPaused ? "계속" : "멈춤"}</span></button>
                {analysis && <button type="button" onClick={() => setShowBoxes((value) => !value)} aria-label="단어 터치 영역 표시 또는 숨기기">▦<span>단어</span></button>}
                <button type="button" disabled={isLast} onClick={() => void moveTo(pageIndex + 1)} aria-label="다음 페이지">›</button>
              </div>
              <p className="fullscreen-tap-hint">책 화면을 누르면 컨트롤을 숨기거나 다시 표시할 수 있습니다.</p>
            </>
          )}

          <PageTextEditor open={editorOpen} initialText={currentText} pageNumber={pageIndex + 1} onClose={() => setEditorOpen(false)} onSave={savePageText} />
        </>
      )}
    </main>
  );
}
