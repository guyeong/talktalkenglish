const MODEL = "gemini-3.5-flash-lite";
const UPSTREAM_TIMEOUT_MS = 43_000;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

const responseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["fullText", "sentences", "words"],
  properties: {
    fullText: { type: "string" },
    sentences: { type: "array", items: { type: "object", additionalProperties: false, required: ["text", "bbox"], properties: {
      text: { type: "string" }, bbox: { type: "object", additionalProperties: false, required: ["x", "y", "width", "height"], properties: {
        x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" },
      } },
    } } },
    words: { type: "array", items: { type: "object", additionalProperties: false, required: ["text", "bbox", "sentenceIndex"], properties: {
      text: { type: "string" }, sentenceIndex: { type: "integer" }, bbox: { type: "object", additionalProperties: false, required: ["x", "y", "width", "height"], properties: {
        x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" },
      } },
    } } },
  },
};

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Gemini request timed out")), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function callGemini(apiKey, body) {
  const response = await withTimeout(fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    },
  ), UPSTREAM_TIMEOUT_MS);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `Gemini 요청 실패 (${response.status})`);
  return payload;
}

function friendlyError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/authentication|credential|oauth|unauthenticated|api key/i.test(message)) return "Gemini 인증에 실패했습니다. GEMINI_API_KEY를 확인해 주세요.";
  if (/quota|rate limit|resource exhausted|429/i.test(message)) return "Gemini 무료 사용 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.";
  if (/timeout|timed out/i.test(message)) return "AI 분석 시간이 초과되었습니다. 더 작은 이미지로 자동 재시도할 수 있습니다.";
  return message || "분석 중 오류가 발생했습니다.";
}

async function handler(request, env) {
  const apiKey = String(env.GEMINI_API_KEY || "").trim();
  if (!apiKey) return json({ error: "Cloudflare 환경변수 GEMINI_API_KEY가 설정되지 않았습니다." }, 500);
  try {
    const { data, mimeType = "image/jpeg", segmentLabel = "one page" } = await request.json();
    if (!data || typeof data !== "string") return json({ error: "이미지 데이터가 없습니다." }, 400);
    const prompt = [
      "Act as a fast, exact OCR and layout extractor for one cropped page of a children's English book.",
      `This crop represents: ${segmentLabel || "one page"}.`,
      "Copy every printed English story word exactly. Preserve punctuation, capitalization, contractions, quotation marks, and reading order.",
      "Ignore illustrations, decorative marks, shadows, fingers, publisher logos, and standalone page numbers.",
      "Return tight sentence and word bounding boxes in normalized 0-1000 coordinates relative to this crop.",
      "Each word must use the zero-based sentenceIndex of its containing sentence.",
      "Never translate, summarize, correct, or invent missing text. Return only the requested JSON.",
    ].join(" ");
    const payload = await callGemini(apiKey, {
      contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType, data } }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema,
        mediaResolution: "MEDIA_RESOLUTION_MEDIUM",
        temperature: 0,
      },
    });
    const outputText = String(payload?.candidates?.[0]?.content?.parts?.find((part) => part?.text)?.text || "").trim();
    if (!outputText) return json({ error: "Gemini가 분석 결과를 반환하지 않았습니다." }, 502);
    return json({ ...JSON.parse(outputText), model: MODEL, analyzedAt: Date.now() });
  } catch (error) {
    const message = friendlyError(error);
    return json({ error: message }, /시간이 초과|timed out/i.test(message) ? 504 : 500);
  }
}

export async function onRequestPost(context) { return handler(context.request, context.env); }
export function onRequest() { return json({ error: "POST 요청만 지원합니다." }, 405); }
