import type { BoundingBox, PageAnalysis } from "../types/Page";
import { convertHeicBlob, isHeicLike } from "../utils/imageFormat";

interface RawSentence { text: string; bbox: BoundingBox; }
interface RawWord { text: string; bbox: BoundingBox; sentenceIndex: number; }
interface RawAnalysis {
  fullText: string;
  sentences: RawSentence[];
  words: RawWord[];
  analyzedAt?: number;
  model?: string;
  error?: string;
}

export interface AnalysisProgress {
  completed: number;
  total: number;
  label: string;
}

interface PreparedSegment {
  data: string;
  mimeType: string;
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
  label: string;
}

const MAX_SEGMENT_SIDE = 1280;
const RETRY_SEGMENT_SIDE = 960;
const JPEG_QUALITY = 0.78;
const REQUEST_TIMEOUT_MS = 48_000;

function loadNativeImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("native-image-decode-failed")); };
    image.src = url;
  });
}

async function loadImage(blob: Blob): Promise<HTMLImageElement> {
  try {
    return await loadNativeImage(blob);
  } catch {
    try {
      const fileName = blob instanceof File ? blob.name : "";
      const converted = isHeicLike(blob, fileName) ? await convertHeicBlob(blob, fileName) : blob;
      if (converted !== blob) return await loadNativeImage(converted);
    } catch (conversionError) {
      console.error(conversionError);
    }
    throw new Error("사진을 열지 못했습니다. JPEG, PNG, HEIC, HEIF, WebP 또는 AVIF 사진을 사용해 주세요.");
  }
}

function canvasToPayload(canvas: HTMLCanvasElement): { data: string; mimeType: string } {
  const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) throw new Error("사진 형식을 변환하지 못했습니다.");
  return { data: dataUrl.slice(commaIndex + 1), mimeType: "image/jpeg" };
}

function drawEnhancedSegment(
  image: HTMLImageElement,
  sourceX: number,
  sourceY: number,
  sourceWidth: number,
  sourceHeight: number,
  maxSide: number,
): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!context) throw new Error("사진 변환 기능을 사용할 수 없습니다.");

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.filter = "contrast(1.13) brightness(1.04) saturate(0.9)";
  context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);
  context.filter = "none";
  return canvas;
}

async function prepareSegments(blob: Blob, maxSide = MAX_SEGMENT_SIDE): Promise<PreparedSegment[]> {
  const image = await loadImage(blob);
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const isSpread = width / Math.max(1, height) >= 1.28;

  if (!isSpread) {
    const canvas = drawEnhancedSegment(image, 0, 0, width, height, maxSide);
    return [{ ...canvasToPayload(canvas), offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, label: "한 페이지" }];
  }

  // Two-page photos are substantially faster and more accurate when each page is
  // analyzed independently. A small overlap prevents words near the book fold from
  // being lost. Coordinates are merged back into the original 0-1000 space.
  const overlap = Math.round(width * 0.025);
  const midpoint = Math.round(width / 2);
  const leftWidth = Math.min(width, midpoint + overlap);
  const rightX = Math.max(0, midpoint - overlap);
  const rightWidth = width - rightX;

  const leftCanvas = drawEnhancedSegment(image, 0, 0, leftWidth, height, maxSide);
  const rightCanvas = drawEnhancedSegment(image, rightX, 0, rightWidth, height, maxSide);

  return [
    { ...canvasToPayload(leftCanvas), offsetX: 0, offsetY: 0, scaleX: leftWidth / width, scaleY: 1, label: "왼쪽 페이지" },
    { ...canvasToPayload(rightCanvas), offsetX: rightX / width, offsetY: 0, scaleX: rightWidth / width, scaleY: 1, label: "오른쪽 페이지" },
  ];
}

function clampBox(box: BoundingBox): BoundingBox {
  const x = Math.max(0, Math.min(1000, Number(box?.x) || 0));
  const y = Math.max(0, Math.min(1000, Number(box?.y) || 0));
  const width = Math.max(1, Math.min(1000 - x, Number(box?.width) || 1));
  const height = Math.max(1, Math.min(1000 - y, Number(box?.height) || 1));
  return { x, y, width, height };
}

function mapBox(box: BoundingBox, segment: PreparedSegment): BoundingBox {
  return clampBox({
    x: (segment.offsetX + (box.x / 1000) * segment.scaleX) * 1000,
    y: (segment.offsetY + (box.y / 1000) * segment.scaleY) * 1000,
    width: (box.width / 1000) * segment.scaleX * 1000,
    height: (box.height / 1000) * segment.scaleY * 1000,
  });
}

function parseServerResponse(text: string, status: number): RawAnalysis {
  const cleanText = text.trim();
  if (!cleanText) throw new Error(`AI 서버가 빈 응답을 보냈습니다. (${status})`);
  try { return JSON.parse(cleanText) as RawAnalysis; }
  catch {
    if (/timeout|timeouterr|timed out/i.test(cleanText)) throw new Error("AI 분석 시간이 초과되었습니다.");
    throw new Error(`AI 서버 응답을 읽지 못했습니다: ${cleanText.slice(0, 180)}`);
  }
}

async function analyzeSegment(segment: PreparedSegment): Promise<RawAnalysis> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: segment.data, mimeType: segment.mimeType, segmentLabel: segment.label }),
      signal: controller.signal,
    });
    const responseText = await response.text();
    const raw = parseServerResponse(responseText, response.status);
    if (!response.ok) throw new Error(raw.error || `AI 분석 요청 실패 (${response.status})`);
    return raw;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("AI 분석 시간이 초과되었습니다.");
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function normalizeSegment(raw: RawAnalysis, segment: PreparedSegment, sentenceOffset: number) {
  const sentences = (raw.sentences ?? [])
    .map((sentence, index) => ({ id: `sentence-${sentenceOffset + index}`, text: sentence.text.trim(), bbox: mapBox(sentence.bbox, segment) }))
    .filter((sentence) => sentence.text);
  const words = (raw.words ?? [])
    .map((word, index) => ({
      id: `word-${sentenceOffset}-${index}`,
      text: word.text.trim(),
      sentenceIndex: sentenceOffset + Math.max(0, Math.min(Math.max(0, sentences.length - 1), Number(word.sentenceIndex) || 0)),
      bbox: mapBox(word.bbox, segment),
    }))
    .filter((word) => word.text);
  return { sentences, words };
}

export async function extractPageText(
  image: Blob,
  onProgress?: (progress: AnalysisProgress) => void,
): Promise<PageAnalysis> {
  let segments = await prepareSegments(image);
  const allSentences: PageAnalysis["sentences"] = [];
  const allWords: PageAnalysis["words"] = [];
  const texts: string[] = [];
  const models = new Set<string>();

  for (let index = 0; index < segments.length; index += 1) {
    let segment = segments[index];
    onProgress?.({ completed: index, total: segments.length, label: `${segment.label} 분석 중` });
    let raw: RawAnalysis;
    try {
      raw = await analyzeSegment(segment);
    } catch (error) {
      if (!/시간이 초과|timed out|timeout/i.test(error instanceof Error ? error.message : String(error))) throw error;
      // Retry only the failed segment at a smaller resolution. This avoids repeating
      // successful work and keeps each Netlify invocation comfortably below its limit.
      const retrySegments = await prepareSegments(image, RETRY_SEGMENT_SIDE);
      segment = retrySegments[index];
      raw = await analyzeSegment(segment);
    }

    const sentenceOffset = allSentences.length;
    const normalized = normalizeSegment(raw, segment, sentenceOffset);
    allSentences.push(...normalized.sentences);
    allWords.push(...normalized.words);
    if (raw.fullText?.trim()) texts.push(raw.fullText.trim());
    if (raw.model) models.add(raw.model);
    onProgress?.({ completed: index + 1, total: segments.length, label: `${segment.label} 완료` });
  }

  if (!allSentences.length && !texts.length) throw new Error("영어 문장을 찾지 못했습니다. 글자가 더 크게 보이도록 촬영해 주세요.");

  return {
    fullText: texts.join("\n").trim() || allSentences.map((sentence) => sentence.text).join(" "),
    sentences: allSentences,
    words: allWords,
    analyzedAt: Date.now(),
    model: [...models].join(", ") || "gemini-3.5-flash-lite",
  };
}
