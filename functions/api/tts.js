const MODEL = "gemini-3.1-flash-tts-preview";
const UPSTREAM_TIMEOUT_MS = 45_000;

const PRESETS = {
  "us-female": {
    voice: "Aoede",
    languageCode: "en-US",
    accent: "native General American accent",
    profile: "a warm, friendly adult woman reading clearly to a child",
  },
  "us-male": {
    voice: "Iapetus",
    languageCode: "en-US",
    accent: "native General American accent",
    profile: "a calm adult man recording a clear elementary-school English listening track",
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
    "cache-control": "no-store",
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

  if (narrationStyle === "reference") {
    if (/whisper|murmur|softly|quietly/.test(lower)) return "[quietly, with careful textbook diction]";
    if (/shout|yell|scream|cried out|roared/.test(lower)) return "[firmly, with controlled emphasis]";
    if (question) return quoted ? "[conversationally, with a clear question contour]" : "[with a clear question contour]";
    if (exclamation) return "[brightly, with controlled emphasis]";
    if (quoted) return "[natural classroom dialogue, slightly brighter than narration]";
    return "[calm school-listening-track narration]";
  }

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
  if (narrationStyle === "reference") {
    return [
      "Read like a professionally recorded elementary-school English listening track.",
      "Use a calm General American classroom pronunciation with crisp consonants, natural linking, and clearly reduced unstressed function words.",
      "Keep the pace steady and easy to shadow, roughly 135 to 150 words per minute before the user's playback-rate adjustment.",
      "Stress the important content words clearly, while keeping articles, prepositions, and auxiliary verbs lighter.",
      "Use short audible phrase breaks at commas and clause boundaries, then a clean half-second pause between complete sentences.",
      "Let statements finish with a gentle downward contour, yes-or-no questions rise clearly, and wh-questions usually fall.",
      "Quoted dialogue should sound conversational and slightly brighter than narration, but never theatrical or exaggerated.",
      "The result must sound like a polished school textbook recording rather than an audiobook performance.",
    ].join(" ");
  }
  if (narrationStyle === "theater") {
    return [
      "Perform as a vivid children's stage actor, not as a neutral reader.",
      "Make narration and quoted dialogue unmistakably different: narration is grounded and cinematic; every quoted line is acted in character.",
      "Use large but intelligible changes in pitch, rhythm, volume, suspense, surprise, fear, delight, anger, and humor.",
      "A whisper must sound genuinely quiet and close; a shout must sound urgent and powerful; a frightened line should tremble; a joyful line should sparkle.",
      "Pause clearly at commas and clauses, and take a dramatic breath at dialogue boundaries or scene changes.",
      "Do not flatten the performance. The difference from an English-learning voice must be obvious on first listen.",
    ].join(" ");
  }
  if (narrationStyle === "storybook") {
    return [
      "Read like a professional children's audiobook narrator.",
      "Keep unquoted narration warm, calm, and gently cinematic.",
      "Shift quoted dialogue into a clearly more conversational character voice with noticeably different pitch, rhythm, and intention.",
      "Use punctuation and dialogue verbs to express curiosity, surprise, worry, happiness, and suspense without overacting.",
      "Pause naturally at commas and clauses and take a clear breath between narration and dialogue.",
      "The difference between narration and dialogue must be easy for a child to hear.",
    ].join(" ");
  }
  return [
    "Read as a precise English-learning model, not as an actor.",
    "Keep narration and quoted dialogue in nearly the same steady voice.",
    "Use restrained emotion, even volume, stable pitch, precise consonants, and easy-to-copy sentence stress.",
    "Pause briefly at commas and clearly at the end of clauses, but avoid dramatic character voices.",
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
    kind === "story" ? "Treat each complete sentence as one reading unit and leave about half a second of silence between sentences." : "Pause naturally at the end of the sentence.",
    "Never run clauses together. Leave audible space at commas, semicolons, quotation boundaries, and changes of speaker.",
    "Read the transcript exactly. Do not add, remove, explain, paraphrase, or speak any directions, labels, or audio tags.",
    "PERFORMANCE CUE:",
    cue,
    "TRANSCRIPT:",
    clean,
  ].join("\n");
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Gemini TTS request timed out")), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

function friendlyError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/authentication|credential|oauth|unauthenticated|api key/i.test(message)) return "Gemini 인증에 실패했습니다. GEMINI_API_KEY를 확인해 주세요.";
  if (/quota|rate limit|resource exhausted|429/i.test(message)) return "Gemini 요청이 잠시 많습니다. 잠시 후 고품질 음성을 다시 사용할 수 있습니다.";
  if (/timeout|timed out|abort/i.test(message)) return "AI 음성 생성 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.";
  return message || "음성 생성 중 오류가 발생했습니다.";
}

async function handler(request, env) {
  const apiKey = String(env.GEMINI_API_KEY || "").trim();
  if (!apiKey) return json({ error: "Cloudflare 환경변수 GEMINI_API_KEY가 설정되지 않았습니다." }, 500);
  try {
    const { text, rate = 0.86, kind = "sentence", voicePreset = "us-female", narrationStyle = "storybook" } = await request.json();
    const clean = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!clean) return json({ error: "읽을 문장이 없습니다." }, 400);
    if (clean.length > 3000) return json({ error: "한 번에 읽을 텍스트가 너무 깁니다." }, 400);
    const preset = PRESETS[voicePreset] ?? PRESETS["us-female"];
    const safeStyle = ["clear", "reference", "storybook", "theater"].includes(narrationStyle) ? narrationStyle : "storybook";
    const instruction = buildInstruction({ clean, rate, kind, preset, narrationStyle: safeStyle });
    const response = await withTimeout(fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: instruction }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              languageCode: preset.languageCode,
              voiceConfig: { prebuiltVoiceConfig: { voiceName: preset.voice } },
            },
          },
        }),
      },
    ), UPSTREAM_TIMEOUT_MS);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload?.error?.message || `Gemini 요청 실패 (${response.status})`;
      if (response.status === 429 || /quota|rate limit|resource exhausted/i.test(message)) {
        return json({ error: "Gemini 요청이 잠시 많습니다. 기기 음성으로 재생한 뒤 잠시 후 다시 시도해 주세요.", retryAfterSeconds: 65 }, 429);
      }
      throw new Error(message);
    }
    const audioPart = payload?.candidates?.[0]?.content?.parts?.find((part) => part?.inlineData?.data);
    if (!audioPart?.inlineData?.data) return json({ error: "Gemini가 음성 데이터를 반환하지 않았습니다." }, 502);
    return json({
      data: audioPart.inlineData.data,
      mimeType: audioPart.inlineData.mimeType ?? "audio/L16;codec=pcm;rate=24000",
      model: MODEL,
      voice: preset.voice,
      voicePreset,
      narrationStyle: safeStyle,
    });
  } catch (error) {
    return json({ error: friendlyError(error) }, /timeout/i.test(String(error?.message || "")) ? 504 : 500);
  }
}

export async function onRequestPost(context) { return handler(context.request, context.env); }
export function onRequest() { return json({ error: "POST 요청만 지원합니다." }, 405); }
