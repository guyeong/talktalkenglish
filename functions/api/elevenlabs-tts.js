const MODEL = "eleven_v3";
const UPSTREAM_TIMEOUT_MS = 55_000;
const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";

const json = (body, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  },
});

function voiceIdForPreset(env, preset) {
  const mapped = {
    "us-female": env.ELEVENLABS_VOICE_US_FEMALE,
    "us-male": env.ELEVENLABS_VOICE_US_MALE,
    "uk-male": env.ELEVENLABS_VOICE_UK_MALE,
    "au-female": env.ELEVENLABS_VOICE_AU_FEMALE,
  };
  return String(mapped[preset] || env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID).trim();
}

function emotionTag(sentence) {
  const lower = sentence.toLowerCase();
  const quoted = /[“”"]/.test(sentence);
  if (/whisper|murmur|softly|quietly/.test(lower)) return "[whispers]";
  if (/shout|yell|scream|roared|cried out/.test(lower)) return "[shouts]";
  if (/trembl|afraid|scared|fright|terrified|nervous/.test(lower)) return "[nervous]";
  if (/laugh|giggl|grin|smile|cheer|happy|delighted/.test(lower)) return "[happily]";
  if (/sob|sad|tear|lonely|sorry|disappointed/.test(lower)) return "[sad]";
  if (/angry|furious|growl|snapped/.test(lower)) return "[angry]";
  if (/suddenly|bang|crash|slam|boom/.test(lower)) return "[dramatically]";
  if (/dark|shadow|crept|tiptoe|myster|haunt|ghost/.test(lower)) return "[mysteriously]";
  if (/\?/.test(sentence)) return quoted ? "[curious]" : "[thoughtfully]";
  if (/!/.test(sentence)) return "[excited]";
  if (quoted) return "[in character]";
  return "[warmly]";
}

function buildTheaterScript(text, kind) {
  const cleanLines = String(text ?? "")
    .split(/\n+/)
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter(Boolean);
  if (kind === "word") return cleanLines.join(" ");
  const lines = cleanLines.length ? cleanLines : [String(text ?? "").replace(/\s+/g, " ").trim()];
  return lines.map((line, index) => {
    const tag = emotionTag(line);
    const pause = index < lines.length - 1 ? " ..." : "";
    return `${tag} ${line}${pause}`;
  }).join("\n");
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("ElevenLabs TTS request timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function friendlyError(status, message) {
  if (status === 401 || /api key|unauthorized|authentication/i.test(message)) {
    return "ElevenLabs 인증에 실패했습니다. ELEVENLABS_API_KEY를 확인해 주세요.";
  }
  if (status === 402 || /credits|quota|subscription|payment|insufficient/i.test(message)) {
    return "ElevenLabs 무료 크레딧을 모두 사용했습니다. 다음 무료 크레딧 갱신 후 다시 이용할 수 있습니다.";
  }
  if (status === 429 || /rate limit|too many|concurrency/i.test(message)) {
    return "ElevenLabs 요청이 잠시 많습니다. 잠시 후 다시 시도해 주세요.";
  }
  if (/timeout|timed out/i.test(message)) {
    return "ElevenLabs 음성 생성 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.";
  }
  return message || "ElevenLabs 음성 생성 중 오류가 발생했습니다.";
}

async function handler(request, env) {
  if (request.method !== "POST") return json({ error: "POST 요청만 지원합니다." }, 405);
  const apiKey = String(env.ELEVENLABS_API_KEY || "").trim();
  if (!apiKey) return json({ error: "Cloudflare 환경변수 ELEVENLABS_API_KEY가 설정되지 않았습니다." }, 500);

  try {
    const {
      text,
      kind = "story",
      voicePreset = "us-female",
    } = await request.json();
    const clean = String(text ?? "").trim();
    if (!clean) return json({ error: "읽을 문장이 없습니다." }, 400);
    if (clean.length > 2500) return json({ error: "ElevenLabs 무료 버전에서는 한 번에 읽을 텍스트를 2,500자 이하로 줄여 주세요." }, 400);

    const voiceId = voiceIdForPreset(env, voicePreset);
    const script = buildTheaterScript(clean, kind);
    const response = await withTimeout(fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "content-type": "application/json",
          "accept": "audio/mpeg",
        },
        body: JSON.stringify({
          text: script,
          model_id: MODEL,
          language_code: "en",
          voice_settings: {
            stability: 0.35,
            similarity_boost: 0.75,
            style: 0.9,
            use_speaker_boost: true,
            speed: 0.93,
          },
        }),
      },
    ), UPSTREAM_TIMEOUT_MS);

    if (!response.ok) {
      const raw = await response.text();
      let detail = raw;
      try {
        const parsed = JSON.parse(raw);
        detail = parsed?.detail?.message || parsed?.detail || parsed?.message || raw;
      } catch { /* use raw response */ }
      const retryAfterSeconds = Number(response.headers.get("retry-after") || (response.status === 429 ? 60 : response.status === 402 ? 3600 : 300));
      return json({
        error: friendlyError(response.status, String(detail)),
        retryAfterSeconds,
      }, response.status, retryAfterSeconds ? { "retry-after": String(retryAfterSeconds) } : {});
    }

    if (!response.body) return json({ error: "ElevenLabs가 음성 데이터를 반환하지 않았습니다." }, 502);
    return new Response(response.body, {
      status: 200,
      headers: {
        "content-type": response.headers.get("content-type") || "audio/mpeg",
        "cache-control": "no-store",
        "x-talktalk-model": MODEL,
        "x-talktalk-voice-id": voiceId,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return json({ error: friendlyError(500, message), retryAfterSeconds: 300 }, /timeout/i.test(message) ? 504 : 500);
  }
}

export async function onRequestPost(context) {
  return handler(context.request, context.env);
}

export function onRequest() {
  return json({ error: "POST 요청만 지원합니다." }, 405);
}
