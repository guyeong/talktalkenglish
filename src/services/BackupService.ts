import { v4 as uuidv4 } from "uuid";
import type { Book } from "../types/Book";
import type { Page } from "../types/Page";
import { convertHeicBlob, isHeicLike } from "../utils/imageFormat";

const BACKUP_FORMAT = "talktalkenglish-backup";
const BACKUP_VERSION = 2;
const SUPPORTED_BACKUP_VERSIONS = new Set([1, 2]);

interface SerializedImage {
  dataUrl: string;
  type: string;
  byteLength?: number;
}

interface SerializedPage extends Omit<Page, "image"> {
  image: SerializedImage;
}

interface SerializedBook extends Omit<Book, "pages"> {
  pages: SerializedPage[];
}

interface BackupPayload {
  format: typeof BACKUP_FORMAT;
  version: number;
  scope: "book" | "library";
  exportedAt: number;
  books: SerializedBook[];
}

export interface ImportResult {
  books: Book[];
  scope: "book" | "library";
  exportedAt: number;
}

function safeFileName(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || "talktalk-book";
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("사진을 백업 파일로 변환하지 못했습니다."));
    reader.readAsDataURL(blob);
  });
}

function decodeBase64(encoded: string): Uint8Array {
  // Decode in chunks. This uses less temporary memory than one very large loop on
  // iPhone/iPad Safari and prevents partially restored image blobs.
  const binary = atob(encoded.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  const chunkSize = 32 * 1024;
  for (let offset = 0; offset < binary.length; offset += chunkSize) {
    const end = Math.min(binary.length, offset + chunkSize);
    for (let index = offset; index < end; index += 1) bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function sniffImageType(bytes: Uint8Array, declaredType = "", fileName = ""): string {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") return "image/png";
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";

  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4).toLowerCase();
    if (["avif", "avis"].includes(brand)) return "image/avif";
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) return "image/heic";
  }

  const normalized = declaredType.toLowerCase();
  if (normalized.startsWith("image/") && normalized !== "image/*") return normalized;
  if (/\.png$/i.test(fileName)) return "image/png";
  if (/\.webp$/i.test(fileName)) return "image/webp";
  if (/\.avif$/i.test(fileName)) return "image/avif";
  if (/\.(heic|heif)$/i.test(fileName)) return "image/heic";
  return "image/jpeg";
}

function dataUrlToBlob(dataUrl: string, fallbackType = "image/jpeg", fileName = ""): Blob {
  if (dataUrl.startsWith("blob:")) {
    throw new Error("이 백업은 기기 내부 임시 사진 주소를 포함하고 있어 다른 기기에서 복원할 수 없습니다. 원래 기기에서 최신 버전으로 다시 백업해 주세요.");
  }

  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) throw new Error("백업 사진 데이터가 올바르지 않습니다.");
  const metadata = dataUrl.slice(0, commaIndex);
  const encoded = dataUrl.slice(commaIndex + 1);
  const declaredType = metadata.match(/^data:([^;,]+)/i)?.[1] || fallbackType;
  const isBase64 = /;base64/i.test(metadata);
  const bytes = isBase64
    ? decodeBase64(encoded)
    : new TextEncoder().encode(decodeURIComponent(encoded));

  if (bytes.byteLength === 0) throw new Error("백업 사진 데이터가 비어 있습니다.");
  const actualType = sniffImageType(bytes, declaredType, fileName);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type: actualType });
}

function canDisplayImage(blob: Blob): Promise<boolean> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    const cleanup = (result: boolean) => {
      URL.revokeObjectURL(url);
      resolve(result);
    };
    image.onload = () => cleanup(image.naturalWidth > 0 && image.naturalHeight > 0);
    image.onerror = () => cleanup(false);
    image.src = url;
  });
}

async function restoreImage(image: SerializedImage, fileName: string, bookTitle: string, pageNumber: number): Promise<{ blob: Blob; fileName: string }> {
  if (!image?.dataUrl || typeof image.dataUrl !== "string") {
    throw new Error(`“${bookTitle}” ${pageNumber}페이지의 사진 데이터가 없습니다.`);
  }

  let blob = dataUrlToBlob(image.dataUrl, image.type, fileName);

  // HEIC/HEIF may be readable on the source iPhone but not on the destination PC,
  // Android device, or older iPad. Convert it to JPEG while importing.
  const wasHeic = isHeicLike(blob, fileName);
  if (wasHeic) {
    blob = await convertHeicBlob(blob, fileName);
  }

  if (!(await canDisplayImage(blob))) {
    throw new Error(`“${bookTitle}” ${pageNumber}페이지 사진을 표시 가능한 형식으로 복원하지 못했습니다.`);
  }

  return {
    blob,
    fileName: wasHeic ? fileName.replace(/\.(heic|heif)$/i, ".jpg") : fileName,
  };
}

async function serializeBook(book: Book): Promise<SerializedBook> {
  const pages = await Promise.all(book.pages.map(async (page) => ({
    ...page,
    image: {
      dataUrl: await blobToDataUrl(page.image),
      type: page.image.type || "image/jpeg",
      byteLength: page.image.size,
    },
  })));
  return { ...book, pages };
}

async function deserializeBook(book: SerializedBook): Promise<Book> {
  if (!book || typeof book.id !== "string" || typeof book.title !== "string" || !Array.isArray(book.pages)) {
    throw new Error("백업에 올바른 책 정보가 없습니다.");
  }

  const pages: Page[] = [];
  for (let index = 0; index < book.pages.length; index += 1) {
    const page = book.pages[index];
    const fileName = typeof page.fileName === "string" && page.fileName ? page.fileName : `page-${index + 1}.jpg`;
    const restored = await restoreImage(page.image, fileName, book.title, index + 1);
    pages.push({
      ...page,
      fileName: restored.fileName,
      image: restored.blob,
    });
  }

  return {
    ...book,
    progress: Number.isFinite(book.progress) ? Math.max(0, Math.min(100, book.progress)) : 0,
    pages,
  };
}

function triggerDownload(payload: BackupPayload, fileName: string): void {
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export async function exportBookBackup(book: Book): Promise<void> {
  const serialized = await serializeBook(book);
  triggerDownload({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    scope: "book",
    exportedAt: Date.now(),
    books: [serialized],
  }, `${safeFileName(book.title)}.talktalk`);
}

export async function exportLibraryBackup(books: Book[]): Promise<void> {
  const serialized = await Promise.all(books.map(serializeBook));
  const date = new Date().toISOString().slice(0, 10);
  triggerDownload({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    scope: "library",
    exportedAt: Date.now(),
    books: serialized,
  }, `TalkTalk-English-전체백업-${date}.talktalk`);
}

export async function readBackupFile(file: File): Promise<ImportResult> {
  let payload: BackupPayload;
  try {
    payload = JSON.parse(await file.text()) as BackupPayload;
  } catch {
    throw new Error("백업 파일을 읽을 수 없습니다. .talktalk 파일인지 확인해 주세요.");
  }

  if (payload.format !== BACKUP_FORMAT || !SUPPORTED_BACKUP_VERSIONS.has(Number(payload.version)) || !Array.isArray(payload.books)) {
    throw new Error("지원하지 않는 백업 파일입니다.");
  }
  if (payload.books.length === 0) throw new Error("백업 파일에 책이 없습니다.");

  const books: Book[] = [];
  for (const book of payload.books) books.push(await deserializeBook(book));

  return {
    books,
    scope: payload.scope === "library" ? "library" : "book",
    exportedAt: Number(payload.exportedAt) || Date.now(),
  };
}

export function prepareImportedBooks(imported: Book[], existingIds: Set<string>, overwrite: boolean): Book[] {
  const now = Date.now();
  const claimedIds = new Set(existingIds);
  return imported.map((book, index) => {
    const duplicate = claimedIds.has(book.id);
    if (duplicate && !overwrite) {
      const id = uuidv4();
      claimedIds.add(id);
      return {
        ...book,
        id,
        title: `${book.title} (복사본)`,
        createdAt: now + index,
        updatedAt: now + index,
      };
    }
    claimedIds.add(book.id);
    return { ...book, updatedAt: now + index };
  });
}
