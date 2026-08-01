import { useEffect, useState } from "react";

interface Props {
  open: boolean;
  initialText: string;
  pageNumber: number;
  onClose: () => void;
  onSave: (text: string) => Promise<void> | void;
}

export default function PageTextEditor({ open, initialText, pageNumber, onClose, onSave }: Props) {
  const [text, setText] = useState(initialText);
  const [saving, setSaving] = useState(false);

  useEffect(() => setText(initialText), [initialText, open]);

  if (!open) return null;

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(text.trim());
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="dialog-panel text-editor-panel" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <div>
            <p className="eyebrow">{pageNumber}페이지</p>
            <h2>페이지 영어 입력</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose}>닫기</button>
        </div>
        <p className="editor-guide">현재 버전에서는 사진 속 영어 문장을 붙여 넣거나 직접 입력하세요. 다음 버전에서 AI 이미지 인식을 연결합니다.</p>
        <textarea
          className="page-textarea"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="예: Brown Bear, Brown Bear, what do you see?"
          autoFocus
        />
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={onClose}>취소</button>
          <button className="primary-button" type="button" onClick={() => void handleSave()} disabled={saving}>
            {saving ? "저장 중…" : "텍스트 저장"}
          </button>
        </div>
      </section>
    </div>
  );
}
