import { v4 as uuidv4 } from "uuid";
import type { Book } from "../types/Book";
import type { Page } from "../types/Page";

const BACKUP_FORMAT = "talktalkenglish-backup";
const BACKUP_VERSION = 1;

interface SerializedPage extends Omit<Page, "image"> {
  image: {
    dataUrl: string;
    type: string;
  };
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

function dataUrlToBlob(dataUrl: string, fallbackType = "image/jpeg"): Blob {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) throw new Error("백업 사진 데이터가 올바르지 않습니다.");
  const metadata = dataUrl.slice(0, commaIndex);
  const encoded = dataUrl.slice(commaIndex + 1);
  const type = metadata.match(/^data:([^;,]+)/i)?.[1] || fallbackType;
  const isBase64 = /;base64/i.test(metadata);
  const binary = isBase64 ? atob(encoded) : decodeURIComponent(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type });
}

async function serializeBook(book: Book): Promise<SerializedBook> {
  const pages = await Promise.all(book.pages.map(async (page) => ({
    ...page,
    image: {
      dataUrl: await blobToDataUrl(page.image),
      type: page.image.type || "image/jpeg",
    },
  })));
  return { ...book, pages };
}

function deserializeBook(book: SerializedBook): Book {
  if (!book || typeof book.id !== "string" || typeof book.title !== "string" || !Array.isArray(book.pages)) {
    throw new Error("백업에 올바른 책 정보가 없습니다.");
  }
  const pages: Page[] = book.pages.map((page) => {
    if (!page?.image?.dataUrl) throw new Error(`“${book.title}”의 페이지 사진이 손상되었습니다.`);
    return {
      ...page,
      image: dataUrlToBlob(page.image.dataUrl, page.image.type),
    };
  });
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
  if (payload.format !== BACKUP_FORMAT || payload.version !== BACKUP_VERSION || !Array.isArray(payload.books)) {
    throw new Error("지원하지 않는 백업 파일입니다.");
  }
  if (payload.books.length === 0) throw new Error("백업 파일에 책이 없습니다.");
  return {
    books: payload.books.map(deserializeBook),
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
