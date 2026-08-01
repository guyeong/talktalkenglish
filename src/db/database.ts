import Dexie, { type Table } from "dexie";
import type { Book } from "../types/Book";

class TalkTalkDB extends Dexie {
  books!: Table<Book, string>;

  constructor() {
    super("TalkTalkEnglish");
    this.version(1).stores({
      books: "id, title, createdAt, updatedAt",
    });
  }
}

export const db = new TalkTalkDB();
