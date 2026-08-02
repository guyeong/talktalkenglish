import { useEffect, useMemo, useRef, useState } from "react";
import { addBook } from "../services/BookService";
import type { Book } from "../types/Book";
import type { Page } from "../types/Page";
import { normalizeImageFile } from "../utils/imageFormat";

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}

export default function AddBookDialog({ open, onClose, onSaved }: Props) {
  const [title, setTitle] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [preparingImages, setPreparingImages] = useState(false);
  const [prepareProgress, setPrepareProgress] = useState("");
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
      setPreparingImages(false);
      setPrepareProgress("");
      setError("");
    }
  }, [open]);

  if (!open) return null;

  async function handleFiles(nextFiles: FileList | null) {
    if (!nextFiles) return;

    const selected = Array.from(nextFiles);
    const supported = selected.filter((file) =>
      file.type.startsWith("image/") || /\.(jpe?g|png|webp|avif|heic|heif)$/i.test(file.name),
    );

    if (!supported.length) {
      setFiles([]);
      setError("사진 파일을 선택해 주세요. JPEG, PNG, HEIC, HEIF, WebP, AVIF를 사용할 수 있습니다.");
      return;
    }

    setPreparingImages(true);
    setError("");
    const prepared: File[] = [];
    const failed: string[] = [];

    try {
      for (let index = 0; index < supported.length; index += 1) {
        const file = supported[index];
        setPrepareProgress(`${index + 1} / ${supported.length} 사진 준비 중`);
        try {
          prepared.push(await normalizeImageFile(file));
        } catch (conversionError) {
          console.error(conversionError);
          failed.push(file.name);
        }
      }
      setFiles(prepared);
      if (failed.length) {
        setError(`${failed.length}장의 사진을 변환하지 못했습니다: ${failed.slice(0, 3).join(", ")}`);
      } else if (selected.length !== supported.length) {
        setError("지원되지 않는 파일은 제외했습니다. 사진 파일만 선택해 주세요.");
      }
    } finally {
      setPreparingImages(false);
      setPrepareProgress("");
    }
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
          <small>JPEG·PNG·HEIC·HEIF·WebP·AVIF를 여러 장 선택할 수 있어요.</small>
        </button>

        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          multiple
          accept="image/*,.heic,.heif,.HEIC,.HEIF,.webp,.avif"
          onChange={(event) => {
            void handleFiles(event.target.files);
            event.currentTarget.value = "";
          }}
        />

        {preparingImages && <p className="image-prepare-status" role="status">{prepareProgress || "사진 형식을 확인하는 중…"}</p>}

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
          <button className="primary-button" type="button" onClick={handleSave} disabled={saving || preparingImages}>
            {preparingImages ? "사진 준비 중…" : saving ? "저장 중…" : "책 저장"}
          </button>
        </div>
      </section>
    </div>
  );
}
