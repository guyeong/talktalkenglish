import { useEffect, useMemo, useRef, useState } from "react";
import { addBook } from "../services/BookService";
import type { Book } from "../types/Book";
import type { Page } from "../types/Page";

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}

export default function AddBookDialog({ open, onClose, onSaved }: Props) {
  const [title, setTitle] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const previews = useMemo(
    () => files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [files],
  );

  useEffect(() => {
    return () => previews.forEach((preview) => URL.revokeObjectURL(preview.url));
  }, [previews]);

  useEffect(() => {
    if (!open) {
      setTitle("");
      setFiles([]);
      setSaving(false);
      setError("");
    }
  }, [open]);

  if (!open) return null;

  function handleFiles(nextFiles: FileList | null) {
    if (!nextFiles) return;
    const images = Array.from(nextFiles).filter((file) => file.type.startsWith("image/"));
    setFiles(images);
    setError(images.length ? "" : "이미지 파일을 선택해 주세요.");
  }

  async function handleSave() {
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setError("책 제목을 입력해 주세요.");
      return;
    }
    if (files.length === 0) {
      setError("책 페이지 사진을 한 장 이상 선택해 주세요.");
      return;
    }

    setSaving(true);
    setError("");

    try {
      const pages: Page[] = files.map((file, index) => ({
        id: crypto.randomUUID(),
        image: file,
        fileName: file.name,
        order: index + 1,
        status: "pending",
      }));

      const now = Date.now();
      const book: Book = {
        id: crypto.randomUUID(),
        title: cleanTitle,
        pages,
        progress: 0,
        createdAt: now,
        updatedAt: now,
      };

      await addBook(book);
      await onSaved();
      onClose();
    } catch (saveError) {
      console.error(saveError);
      setError("책을 저장하지 못했습니다. 다시 시도해 주세요.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-book-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <div>
            <p className="eyebrow">새 영어책</p>
            <h2 id="add-book-title">책 추가</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose}>닫기</button>
        </div>

        <label className="field-label" htmlFor="book-title">책 제목</label>
        <input
          id="book-title"
          className="text-input"
          placeholder="예: Brown Bear"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          autoFocus
        />

        <button className="image-picker" type="button" onClick={() => inputRef.current?.click()}>
          <span className="image-picker-icon">＋</span>
          <strong>사진첩에서 페이지 선택</strong>
          <small>여러 장을 한 번에 선택할 수 있어요.</small>
        </button>

        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          multiple
          accept="image/*"
          onChange={(event) => handleFiles(event.target.files)}
        />

        {previews.length > 0 && (
          <div>
            <div className="preview-summary">
              <strong>{previews.length}장 선택됨</strong>
              <button className="text-button" type="button" onClick={() => setFiles([])}>전체 지우기</button>
            </div>
            <div className="preview-grid">
              {previews.map((preview, index) => (
                <figure className="preview-card" key={`${preview.file.name}-${preview.file.lastModified}`}>
                  <img src={preview.url} alt={`${index + 1}페이지 미리보기`} />
                  <figcaption>{index + 1}</figcaption>
                </figure>
              ))}
            </div>
          </div>
        )}

        {error && <p className="form-error" role="alert">{error}</p>}

        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={onClose} disabled={saving}>취소</button>
          <button className="primary-button" type="button" onClick={handleSave} disabled={saving}>
            {saving ? "저장 중…" : "책 저장"}
          </button>
        </div>
      </section>
    </div>
  );
}
