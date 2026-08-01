import { speakText, type SpeechEngine, type VoicePreset } from "../services/SpeechService";
import type { PageAnalysis } from "../types/Page";

interface Props {
  analysis: PageAnalysis;
  rate: number;
  showBoxes: boolean;
  speechEngine: SpeechEngine;
  voicePreset: VoicePreset;
  onSpeechError?: (message: string) => void;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function boxStyle(bbox: { x: number; y: number; width: number; height: number }) {
  // Keep the target centred on the detected word while adding only a tiny margin.
  // This improves touchability without allowing neighbouring words to overlap heavily.
  const marginX = Math.min(3, Math.max(0.8, bbox.width * 0.04));
  const marginY = Math.min(3, Math.max(0.8, bbox.height * 0.08));
  const x = clamp(bbox.x - marginX, 0, 1000);
  const y = clamp(bbox.y - marginY, 0, 1000);
  const right = clamp(bbox.x + bbox.width + marginX, 0, 1000);
  const bottom = clamp(bbox.y + bbox.height + marginY, 0, 1000);
  return {
    left: `${x / 10}%`, top: `${y / 10}%`,
    width: `${Math.max(0.5, right - x) / 10}%`, height: `${Math.max(0.5, bottom - y) / 10}%`,
  };
}

export default function ReadingTextLayer({ analysis, rate, showBoxes, speechEngine, voicePreset, onSpeechError }: Props) {
  return (
    <div className={`coordinate-overlay ${showBoxes ? "show-boxes" : ""}`} aria-label="AI가 인식한 영어 단어">
      {analysis.sentences.map((sentence, index) => (
        <button
          className="sentence-hitbox"
          style={boxStyle(sentence.bbox)}
          key={sentence.id}
          type="button"
          onClick={() => speakText(sentence.text, { rate, engine: speechEngine, voicePreset, kind: "sentence", onError: onSpeechError })}
          aria-label={`${index + 1}번째 문장 읽기: ${sentence.text}`}
        />
      ))}
      {analysis.words.map((word) => (
        <button
          className="word-hitbox"
          style={boxStyle(word.bbox)}
          key={word.id}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            speakText(word.text, { rate, engine: speechEngine, voicePreset, kind: "word", onError: onSpeechError });
          }}
          aria-label={`${word.text} 발음 듣기`}
        ><span>{word.text}</span></button>
      ))}
    </div>
  );
}
