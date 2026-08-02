import { useCallback, useEffect, useRef, useState } from "react";
import AddBookDialog from "../components/AddBookDialog";
import BookCard from "../components/BookCard";
import { exportBookBackup, exportLibraryBackup, prepareImportedBooks, readBackupFile } from "../services/BackupService";
import { deleteBook, getBooks, saveImportedBooks } from "../services/BookService";
import type { Book } from "../types/Book";

interface Props {
  onOpenBook: (id: string) => void;
}

export default function Home({ onOpenBook }: Props) {
  const [books, setBooks] = useState<Book[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupStatus, setBackupStatus] = useState("");
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const loadBooks = useCallback(async () => {
    try {
      setBooks(await getBooks());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBooks();
  }, [loadBooks]);

  async function handleDelete(id: string) {
    const target = books.find((book) => book.id === id);
    if (!target || !window.confirm(`“${target.title}” 책을 삭제할까요?`)) return;
    await deleteBook(id);
    await loadBooks();
  }

  async function handleExportBook(id: string) {
    const target = books.find((book) => book.id === id);
    if (!target || backupBusy) return;
    setBackupBusy(true);
    setBackupStatus(`“${target.title}” 백업 파일을 만드는 중입니다…`);
    try {
      await exportBookBackup(target);
      setBackupStatus(`“${target.title}” 내보내기가 완료되었습니다.`);
    } catch (error) {
      setBackupStatus(error instanceof Error ? error.message : "책을 내보내지 못했습니다.");
    } finally {
      setBackupBusy(false);
    }
  }

  async function handleExportLibrary() {
    if (!books.length || backupBusy) return;
    setBackupBusy(true);
    setBackupStatus(`${books.length}권의 사진과 분석 결과를 백업하는 중입니다…`);
    try {
      await exportLibraryBackup(books);
      setBackupStatus("전체 책 백업이 완료되었습니다.");
    } catch (error) {
      setBackupStatus(error instanceof Error ? error.message : "전체 백업을 만들지 못했습니다.");
    } finally {
      setBackupBusy(false);
    }
  }

  async function handleImportFile(file: File) {
    if (backupBusy) return;
    setBackupBusy(true);
    setBackupStatus("백업 파일을 확인하고 사진을 복원하는 중입니다…");
    try {
      const result = await readBackupFile(file);
      const existingIds = new Set(books.map((book) => book.id));
      const duplicateCount = result.books.filter((book) => existingIds.has(book.id)).length;
      const overwrite = duplicateCount === 0 || window.confirm(
        `같은 책이 ${duplicateCount}권 있습니다.\n\n확인: 기존 책 덮어쓰기\n취소: 새 복사본으로 가져오기`,
      );
      const prepared = prepareImportedBooks(result.books, existingIds, overwrite);
      await saveImportedBooks(prepared);
      await loadBooks();
      setBackupStatus(`${prepared.length}권의 책을 가져왔습니다.`);
    } catch (error) {
      setBackupStatus(error instanceof Error ? error.message : "백업을 가져오지 못했습니다.");
    } finally {
      setBackupBusy(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  }

  return (
    <main className="home-page">
      <section className="hero-card">
        <div>
          <p className="eyebrow">오늘도 한 페이지</p>
          <h1>영어책을 듣고<br />따라 읽어 보세요.</h1>
          <p className="hero-description">책 사진을 등록하면 다음 단계에서 AI가 문장과 단어를 찾아 읽기 연습을 도와줍니다.</p>
        </div>
        <button className="primary-button hero-button" type="button" onClick={() => setDialogOpen(true)}>
          ＋ 책 추가
        </button>
      </section>

      <section className="library-section" aria-labelledby="library-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">MY LIBRARY</p>
            <h2 id="library-heading">내 책</h2>
          </div>
          <div className="library-heading-actions">
            <span className="book-count">{books.length}권</span>
            <button className="library-backup-button" type="button" disabled={!books.length || backupBusy} onClick={() => void handleExportLibrary()}>
              📦 전체 백업
            </button>
            <button className="library-backup-button" type="button" disabled={backupBusy} onClick={() => importInputRef.current?.click()}>
              📥 백업 가져오기
            </button>
            <input
              ref={importInputRef}
              className="visually-hidden"
              type="file"
              accept=".talktalk,application/json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleImportFile(file);
              }}
            />
          </div>
        </div>

        {backupStatus && (
          <div className="backup-status" role="status">
            <span>{backupBusy ? "⏳" : "✓"}</span>
            <p>{backupStatus}</p>
            {!backupBusy && <button type="button" onClick={() => setBackupStatus("")} aria-label="백업 알림 닫기">×</button>}
          </div>
        )}

        {loading ? (
          <div className="empty-state"><p>책장을 불러오는 중입니다…</p></div>
        ) : books.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📚</div>
            <h3>아직 등록된 책이 없습니다.</h3>
            <p>영어책 페이지를 사진첩에서 선택해 첫 번째 책을 만들어 보세요. 다른 기기의 .talktalk 백업도 가져올 수 있습니다.</p>
            <div className="empty-actions">
              <button className="secondary-button" type="button" onClick={() => setDialogOpen(true)}>첫 책 추가하기</button>
              <button className="secondary-button" type="button" onClick={() => importInputRef.current?.click()}>백업 가져오기</button>
            </div>
          </div>
        ) : (
          <div className="book-grid">
            {books.map((book) => (
              <BookCard key={book.id} book={book} onOpen={onOpenBook} onExport={handleExportBook} onDelete={handleDelete} backupBusy={backupBusy} />
            ))}
          </div>
        )}
      </section>

      <AddBookDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onSaved={loadBooks} />
    </main>
  );
}
