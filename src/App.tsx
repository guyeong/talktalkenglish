import { useState } from "react";
import Home from "./pages/Home";
import Reader from "./pages/Reader";

export default function App() {
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null);

  return (
    <div className="app-shell">
      {!selectedBookId && (
        <header className="app-header">
          <div className="brand-mark" aria-hidden="true">T</div>
          <div>
            <strong>TalkTalk English</strong>
            <span>Read · Listen · Speak</span>
          </div>
        </header>
      )}

      {selectedBookId ? (
        <Reader bookId={selectedBookId} onBack={() => setSelectedBookId(null)} />
      ) : (
        <Home onOpenBook={setSelectedBookId} />
      )}
    </div>
  );
}
