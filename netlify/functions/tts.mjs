import { GoogleGenAI } from "@google/genai";

const MODEL = "gemini-3.1-flash-tts-preview";
const UPSTREAM_TIMEOUT_MS = 45_000;

const PRESETS = {
  "us-female": {
    voice: "Aoede",
    languageCode: "en-US",
    accent: "native General American accent",
    profile: "a warm, friendly adult woman reading clearly to a child",
  },
  "uk-male": {
    voice: "Iapetus",
    languageCode: "en-GB",
    accent: "natural contemporary British English accent",
    profile: "a calm, clear adult man reading a children's book",
  },
  "au-female": {
    voice: "Leda",
    languageCode: "en-AU",
    accent: "natural Australian English accent",
    profile: "a bright, friendly adult woman reading clearly to a child",
  },
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, max-age=86400",
  },
});

function pace(rate) {
  if (rate <= 0.7) return "very slowly, with clear separation between words";
  if (rate <= 0.85) return "slowly and clearly";
  if (rate <= 1) return "at a calm natural pace";
  return "at a slightly brisk but clear pace";
}

function emotionCue(text, narrationStyle) {
  if (narrationStyle === "clear") return "[clear and neutral]";

  const lower = text.toLowerCase();
  const quoted = /[“”\"]/.test(text);
  const question = /\?/.test(text);
  const exclamation = /!/.test(text);

  if (/whisper|murmur|softly|quietly/.test(lower)) return "[whispers, gently]";
  if (/shout|yell|scream|cried out|roared/.test(lower)) return narrationStyle === "theater" ? "[shouting, urgent]" : "[excited, urgent]";
  if (/trembl|afraid|scared|fright|terrified|nervous/.test(lower)) return "[trembling, cautiously]";
  if (/laugh|giggl|grin|smile|cheer|happy|delighted/.test(lower)) return narrationStyle === "theater" ? "[brightly, playfully, delighted]" : "[warmly, cheerfully]";
  if (/sob|sad|tear|lonely|sorry|disappointed/.test(lower)) return "[sadly, softly]";
  if (/angry|furious|growl|snapped/.test(lower)) return narrationStyle === "theater" ? "[angrily, forcefully]" : "[firmly]";
  if (/suddenly|bang|crash|slam|boom/.test(lower)) return "[dramatically, with a sudden change of energy]";
  if (/dark|shadow|crept|tiptoe|myster|haunt|ghost/.test(lower)) return narrationStyle === "theater" ? "[spookily, with suspense]" : "[mysteriously, softly]";
  if (question) return quoted ? "[curious, conversationally]" : "[curious]";
  if (exclamation) return narrationStyle === "theater" ? "[excitedly, with strong emphasis]" : "[brightly, with emphasis]";
  if (quoted) return narrationStyle === "theater" ? "[expressively, in character]" : "[naturally, conversationally]";
  return narrationStyle === "theater" ? "[dramatic storyteller]" : "[warm storyteller]";
}

function styleDirections(narrationStyle) {
  if (narrationStyle === "theater") {
    return [
      "Perform like an expressive children's theatre narrator.",
      "Make a strong audible distinction between narration and quoted dialogue.",
      "Give each quoted line a clear character intention while keeping one consistent voice identity.",
      "Use noticeable changes in energy, pitch, pauses, suspense, surprise, and humor, but never become hard to understand.",
    ].join(" ");
  }
  if (narrationStyle === "storybook") {
    return [
      "Read like a skilled children's audiobook narrator.",
      "Keep narration warm and steady, then shift clearly into a more conversational character tone for quoted dialogue.",
      "Infer gentle emotion from punctuation, dialogue verbs, and scene words.",
      "Use natural pauses around quotation marks and scene changes without overacting.",
    ].join(" ");
  }
  return [
    "Read as a clear English-learning model.",
    "Use restrained emotion, steady pacing, precise consonants, and easy-to-copy sentence stress.",
  ].join(" ");
}

function buildInstruction({ clean, rate, kind, preset, narrationStyle }) {
  if (kind === "word") {
    return `Synthesize speech only. Pronounce exactly the English word in the transcript once. Use ${preset.accent} and ${preset.profile}. Do not add any words. Do not speak directions or labels.\n\nTRANSCRIPT:\n${clean}`;
  }

  const cue = emotionCue(clean, narrationStyle);
  return [
    "Synthesize speech only.",
    `Use ${preset.accent}. The speaker is ${preset.profile}.`,
    `Speak ${pace(Number(rate))}.`,
    styleDirections(narrationStyle),
    "For quoted dialogue, sound like a character speaking; for unquoted text, sound like the narrator.",
    "Use the punctuation and dialogue verbs as performance cues.",
    "Read the transcript exactly. Do not add, remove, explain, paraphrase, or speak any directions, labels, or audio tags.",
    "PERFORMANCE CUE:",
    cue,
    "TRANSCRIPT:",
    clean,
  ].join("\n");
}

function friendlyError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/authentication|credential|oauth|unauthenticated|api key/i.test(message)) {
    return "Gemini 인증에 실패했습니다. GEMINI_API_KEY를 확인하고 Netlify 개발 서버를 다시 시작해 주세요.";
  }
  if (/quota|rate limit|resource exhausted/i.test(message)) {
    return "Gemini 무료 사용 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.";
  }
  if (/timeout|timed out|abort/i.test(message)) {
    return "AI 음성 생성 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.";
  }
  return message || "음성 생성 중 오류가 발생했습니다.";
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Gemini TTS request timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function toBase64(data) {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return Buffer.from(data).toString("base64");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("base64");
  return "";
}

export default async (request) => {
  if (request.method !== "POST") return json({ error: "POST 요청만 지원합니다." }, 405);

  const apiKey = Netlify.env.get("GEMINI_API_KEY")?.trim();
  if (!apiKey) return json({ error: "Netlify 환경변수 GEMINI_API_KEY가 설정되지 않았습니다." }, 500);

  try {
    const {
      text,
      rate = 0.86,
      kind = "sentence",
      voicePreset = "us-female",
      narrationStyle = "storybook",
    } = await request.json();
    const clean = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!clean) return json({ error: "읽을 문장이 없습니다." }, 400);
    if (clean.length > 3000) return json({ error: "한 번에 읽을 텍스트가 너무 깁니다." }, 400);

    const preset = PRESETS[voicePreset] ?? PRESETS["us-female"];
    const safeStyle = ["clear", "storybook", "theater"].includes(narrationStyle) ? narrationStyle : "storybook";
    const instruction = buildInstruction({ clean, rate, kind, preset, narrationStyle: safeStyle });

    const ai = new GoogleGenAI({ apiKey });
    const response = await withTimeout(ai.models.generateContent({
      model: MODEL,
      contents: instruction,
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          languageCode: preset.languageCode,
          voiceConfig: { prebuiltVoiceConfig: { voiceName: preset.voice } },
        },
      },
    }), UPSTREAM_TIMEOUT_MS);

    const parts = response?.candidates?.[0]?.content?.parts ?? [];
    const audioPart = parts.find((part) => part?.inlineData?.data);
    const audioData = toBase64(audioPart?.inlineData?.data);
    if (!audioData) return json({ error: "Gemini가 음성 데이터를 반환하지 않았습니다." }, 502);

    return json({
      data: audioData,
      mimeType: audioPart?.inlineData?.mimeType ?? "audio/L16;codec=pcm;rate=24000",
      model: MODEL,
      voice: preset.voice,
      voicePreset,
      narrationStyle: safeStyle,
    });
  } catch (error) {
    return json({ error: friendlyError(error) }, 500);
  }
};

export const config = { path: "/api/tts" };
