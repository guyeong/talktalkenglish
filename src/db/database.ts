import Dexie, { type Table } from "dexie";
import type { Book } from "../types/Book";

export interface SpeechAudioCacheRecord {
  key: string;
  blob: Blob;
  bytes: number;
  updatedAt: number;
  lastAccessedAt: number;
  bookId?: string;
  pageId?: string;
}

class TalkTalkDB extends Dexie {
  books!: Table<Book, string>;
  speechAudio!: Table<SpeechAudioCacheRecord, string>;

  constructor() {
    super("TalkTalkEnglish");
    this.version(1).stores({
      books: "id, title, createdAt, updatedAt",
    });
    this.version(2).stores({
      books: "id, title, createdAt, updatedAt",
      speechAudio: "key, updatedAt, lastAccessedAt, bookId, pageId",
    });
  }
}

export const db = new TalkTalkDB();
