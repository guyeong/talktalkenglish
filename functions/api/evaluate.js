const MODEL = "gemini-3.1-flash-lite";
const UPSTREAM_TIMEOUT_MS = 40_000;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

const responseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["transcript", "accuracyScore", "pronunciationScore", "overallScore", "missedWords", "feedbackKo"],
  properties: {
    transcript: { type: "string" },
    accuracyScore: { type: "integer", minimum: 0, maximum: 100 },
    pronunciationScore: { type: "integer", minimum: 0, maximum: 100 },
    overallScore: { type: "integer", minimum: 0, maximum: 100 },
    missedWords: { type: "array", items: { type: "string" } },
    feedbackKo: { type: "string" },
  },
};

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Pronunciation evaluation timed out")), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

function friendlyError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/authentication|credential|oauth|unauthenticated|api key/i.test(message)) return "Gemini 인증에 실패했습니다. GEMINI_API_KEY를 확인해 주세요.";
  if (/quota|rate limit|resource exhausted|429/i.test(message)) return "Gemini 무료 사용 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.";
  if (/timeout|timed out/i.test(message)) return "발음 평가 시간이 초과되었습니다. 다시 시도해 주세요.";
  return message || "발음 평가 중 오류가 발생했습니다.";
}

async function handler(request, env) {
  const apiKey = String(env.GEMINI_API_KEY || "").trim();
  if (!apiKey) return json({ error: "Cloudflare 환경변수 GEMINI_API_KEY가 설정되지 않았습니다." }, 500);
  try {
    const { expectedText, audioData, mimeType = "audio/webm" } = await request.json();
    const expected = String(expectedText ?? "").replace(/\s+/g, " ").trim();
    if (!expected) return json({ error: "평가할 원문 문장이 없습니다." }, 400);
    if (!audioData || typeof audioData !== "string") return json({ error: "녹음된 음성이 없습니다." }, 400);
    const prompt = [
      "You are a supportive pronunciation evaluator for a child learning English.",
      `REFERENCE SENTENCE: ${expected}`,
      "Listen to the child's recording. Transcribe only what was actually spoken.",
      "Score word accuracy by comparing the spoken words with the reference, allowing normal contractions and minor accent variation.",
      "Score pronunciation based on intelligibility, stress, and clarity. Do not penalize a Korean accent if the words are understandable.",
      "overallScore should be 70% accuracyScore and 30% pronunciationScore, rounded to an integer.",
      "List only omitted, substituted, or clearly unintelligible reference words in missedWords.",
      "feedbackKo must be one short, warm Korean sentence suitable for a child. Never be harsh.",
      "Return only the requested JSON.",
    ].join("\n");
    const response = await withTimeout(fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType, data: audioData } }] }],
          generationConfig: { responseMimeType: "application/json", responseJsonSchema, temperature: 0 },
        }),
      },
    ), UPSTREAM_TIMEOUT_MS);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || `Gemini 요청 실패 (${response.status})`);
    const outputText = String(payload?.candidates?.[0]?.content?.parts?.find((part) => part?.text)?.text || "").trim();
    if (!outputText) return json({ error: "Gemini가 발음 평가 결과를 반환하지 않았습니다." }, 502);
    return json({ ...JSON.parse(outputText), model: MODEL, evaluatedAt: Date.now() });
  } catch (error) {
    return json({ error: friendlyError(error) }, 500);
  }
}

export async function onRequestPost(context) { return handler(context.request, context.env); }
export function onRequest() { return json({ error: "POST 요청만 지원합니다." }, 405); }
