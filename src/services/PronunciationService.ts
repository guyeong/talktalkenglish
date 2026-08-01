export interface PronunciationEvaluation {
  transcript: string;
  accuracyScore: number;
  pronunciationScore: number;
  overallScore: number;
  missedWords: string[];
  feedbackKo: string;
  model?: string;
  evaluatedAt?: number;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result ?? "");
      resolve(value.includes(",") ? value.split(",")[1] : value);
    };
    reader.onerror = () => reject(reader.error ?? new Error("녹음 파일을 읽지 못했습니다."));
    reader.readAsDataURL(blob);
  });
}

export async function evaluatePronunciation(expectedText: string, audio: Blob): Promise<PronunciationEvaluation> {
  const audioData = await blobToBase64(audio);
  const response = await fetch("/api/evaluate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedText, audioData, mimeType: audio.type || "audio/webm" }),
  });

  const raw = await response.text();
  let payload: Partial<PronunciationEvaluation> & { error?: string } = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch { throw new Error(raw || `발음 평가 요청 실패 (${response.status})`); }
  if (!response.ok) throw new Error(payload.error || `발음 평가 요청 실패 (${response.status})`);
  if (typeof payload.overallScore !== "number") throw new Error("발음 평가 점수를 받지 못했습니다.");
  return payload as PronunciationEvaluation;
}

export function bestRecordingMimeType(): string {
  const candidates = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  return candidates.find((type) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) ?? "";
}
