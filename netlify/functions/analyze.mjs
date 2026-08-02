import { GoogleGenAI } from "@google/genai";

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

function friendlyError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/authentication|credential|oauth|unauthenticated|api key/i.test(message)) return "Gemini 인증에 실패했습니다. GEMINI_API_KEY를 확인하고 Netlify 개발 서버를 다시 시작해 주세요.";
  if (/quota|rate limit|resource exhausted/i.test(message)) return "Gemini 무료 사용 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.";
  return message || "분석 중 오류가 발생했습니다.";
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => { const error = new Error("Gemini request timed out"); error.name = "AbortError"; reject(error); }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function callGemini({ apiKey, data, mimeType, segmentLabel }) {
  const ai = new GoogleGenAI({ apiKey });
  const prompt = [
    "Act as a fast, exact OCR and layout extractor for one cropped page of a children's English book.",
    `This crop represents: ${segmentLabel || "one page"}.`,
    "Copy every printed English story word exactly. Preserve punctuation, capitalization, contractions, quotation marks, and reading order.",
    "Ignore illustrations, decorative marks, shadows, fingers, publisher logos, and standalone page numbers.",
    "Return tight sentence and word bounding boxes in normalized 0-1000 coordinates relative to this crop.",
    "Each word must use the zero-based sentenceIndex of its containing sentence.",
    "Never translate, summarize, correct, or invent missing text. Return only the requested JSON.",
  ].join(" ");

  const response = await withTimeout(ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType, data } }] }],
    config: { responseMimeType: "application/json", responseJsonSchema, mediaResolution: "MEDIA_RESOLUTION_MEDIUM", temperature: 0 },
  }), UPSTREAM_TIMEOUT_MS);

  const outputText = String(response.text ?? "").trim();
  if (!outputText) throw new Error("Gemini가 분석 결과를 반환하지 않았습니다.");
  const result = JSON.parse(outputText);
  return { ...result, model: MODEL, analyzedAt: Date.now() };
}

export default async (request) => {
  if (request.method !== "POST") return json({ error: "POST 요청만 지원합니다." }, 405);
  const apiKey = Netlify.env.get("GEMINI_API_KEY")?.trim();
  if (!apiKey) return json({ error: "Netlify 환경변수 GEMINI_API_KEY가 설정되지 않았습니다." }, 500);
  try {
    const input = await request.json();
    const { data, mimeType = "image/jpeg", segmentLabel = "one page" } = input ?? {};
    if (!data || typeof data !== "string") return json({ error: "이미지 데이터가 없습니다." }, 400);
    return json(await callGemini({ apiKey, data, mimeType, segmentLabel }));
  } catch (error) {
    const isTimeout = error?.name === "AbortError" || /timeout|timed out/i.test(error?.message ?? "");
    if (isTimeout) return json({ error: "AI 분석 시간이 초과되었습니다. 더 작은 이미지로 자동 재시도할 수 있습니다." }, 504);
    return json({ error: friendlyError(error) }, 500);
  }
};

export const config = { path: "/api/analyze" };
