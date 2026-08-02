import { db } from "../db/database";
import type { Book } from "../types/Book";

export async function getBooks(): Promise<Book[]> {
  return db.books.orderBy("updatedAt").reverse().toArray();
}

export async function getBook(id: string): Promise<Book | undefined> {
  return db.books.get(id);
}

export async function addBook(book: Book): Promise<string> {
  return db.books.add(book);
}

export async function updateBook(book: Book): Promise<string> {
  return db.books.put({ ...book, updatedAt: Date.now() });
}

export async function deleteBook(id: string): Promise<void> {
  await db.books.delete(id);
}

export async function saveImportedBooks(books: Book[]): Promise<void> {
  await db.transaction("rw", db.books, async () => {
    await db.books.bulkPut(books);
  });
}
