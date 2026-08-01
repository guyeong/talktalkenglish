import { useObjectUrl } from "../hooks/useObjectUrl";
import type { Book } from "../types/Book";

interface Props {
  book: Book;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}

export default function BookCard({ book, onOpen, onDelete }: Props) {
  const coverUrl = useObjectUrl(book.pages[0]?.image);
  const readyPages = book.pages.filter((page) => page.status === "ready").length;

  return (
    <article
      className="book-card book-card-clickable"
      role="button"
      tabIndex={0}
      onClick={() => onOpen(book.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onOpen(book.id);
      }}
      aria-label={`${book.title} 열기`}
    >
      <div className="book-cover-wrap">
        {coverUrl ? (
          <img className="book-cover" src={coverUrl} alt={`${book.title} 표지`} />
        ) : (
          <div className="book-cover-placeholder" aria-hidden="true">📖</div>
        )}
      </div>

      <div className="book-card-body">
        <div className="book-title-row">
          <div>
            <h2>{book.title}</h2>
            <p>{book.pages.length}페이지</p>
          </div>
          <button
            className="icon-button danger"
            type="button"
            aria-label={`${book.title} 삭제`}
            onClick={(event) => {
              event.stopPropagation();
              onDelete(book.id);
            }}
          >
            삭제
          </button>
        </div>

        <div className="progress-track" aria-label={`읽기 진행률 ${book.progress}%`}>
          <div className="progress-value" style={{ width: `${book.progress}%` }} />
        </div>

        <div className="book-meta-row">
          <span>읽기 {book.progress}%</span>
          <span>분석 준비 {readyPages}/{book.pages.length}</span>
        </div>
      </div>
    </article>
  );
}
