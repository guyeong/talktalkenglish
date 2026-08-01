import { useCallback, useEffect, useState } from "react";
import AddBookDialog from "../components/AddBookDialog";
import BookCard from "../components/BookCard";
import { deleteBook, getBooks } from "../services/BookService";
import type { Book } from "../types/Book";

interface Props {
  onOpenBook: (id: string) => void;
}

export default function Home({ onOpenBook }: Props) {
  const [books, setBooks] = useState<Book[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [loading, setLoading] = useState(true);

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
          <span className="book-count">{books.length}권</span>
        </div>

        {loading ? (
          <div className="empty-state"><p>책장을 불러오는 중입니다…</p></div>
        ) : books.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📚</div>
            <h3>아직 등록된 책이 없습니다.</h3>
            <p>영어책 페이지를 사진첩에서 선택해 첫 번째 책을 만들어 보세요.</p>
            <button className="secondary-button" type="button" onClick={() => setDialogOpen(true)}>첫 책 추가하기</button>
          </div>
        ) : (
          <div className="book-grid">
            {books.map((book) => (
              <BookCard key={book.id} book={book} onOpen={onOpenBook} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </section>

      <AddBookDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onSaved={loadBooks} />
    </main>
  );
}
