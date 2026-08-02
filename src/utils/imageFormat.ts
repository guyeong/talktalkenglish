type HeicConversionResult = Blob | Blob[];

type HeicConverter = ((options: {
  blob: Blob;
  type: "image/jpeg" | "image/png";
  quality?: number;
}) => Promise<HeicConversionResult>) & {
  isHeic?: (blob: Blob) => Promise<boolean>;
};

declare global {
  interface Window {
    HeicTo?: HeicConverter;
  }
}

const HEIC_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/heic-to@1.5.2/dist/iife/heic-to.js";
let converterPromise: Promise<HeicConverter> | null = null;

function hasHeicExtension(fileName = "") {
  return /\.(heic|heif)$/i.test(fileName);
}

export function isHeicLike(blob: Blob, fileName = "") {
  const type = blob.type.toLowerCase();
  return hasHeicExtension(fileName)
    || type === "image/heic"
    || type === "image/heif"
    || type === "image/heic-sequence"
    || type === "image/heif-sequence";
}

function loadHeicConverter(): Promise<HeicConverter> {
  if (window.HeicTo) return Promise.resolve(window.HeicTo);
  if (converterPromise) return converterPromise;

  converterPromise = new Promise<HeicConverter>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${HEIC_SCRIPT_URL}"]`);
    const script = existing ?? document.createElement("script");

    const finish = () => {
      if (window.HeicTo) resolve(window.HeicTo);
      else reject(new Error("HEIC 변환 모듈을 시작하지 못했습니다."));
    };

    script.addEventListener("load", finish, { once: true });
    script.addEventListener("error", () => reject(new Error("HEIC 변환 모듈을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.")), { once: true });

    if (!existing) {
      script.src = HEIC_SCRIPT_URL;
      script.async = true;
      script.crossOrigin = "anonymous";
      document.head.appendChild(script);
    }
  }).catch((error) => {
    converterPromise = null;
    throw error;
  });

  return converterPromise;
}

export async function convertHeicBlob(blob: Blob, fileName = ""): Promise<Blob> {
  if (!isHeicLike(blob, fileName)) return blob;

  const converter = await loadHeicConverter();
  const result = await converter({
    blob,
    type: "image/jpeg",
    quality: 0.9,
  });
  const converted = Array.isArray(result) ? result[0] : result;
  if (!(converted instanceof Blob)) throw new Error("HEIC 사진을 JPEG로 변환하지 못했습니다.");
  return converted;
}

export async function normalizeImageFile(file: File): Promise<File> {
  const converted = await convertHeicBlob(file, file.name);
  if (converted === file) return file;

  const baseName = file.name.replace(/\.(heic|heif)$/i, "") || "iphone-photo";
  return new File([converted], `${baseName}.jpg`, {
    type: "image/jpeg",
    lastModified: file.lastModified || Date.now(),
  });
}
