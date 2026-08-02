import { useMemo, useState } from "react";
import type { Book } from "../types/Book";

interface Props {
  book: Book;
  onClose: () => void;
  onComplete: (score: number, total: number) => void;
}

type QuestionKind = "blank" | "word" | "sentence" | "dialogue" | "next";

interface QuizQuestion {
  id: string;
  kind: QuestionKind;
  title: string;
  prompt: string;
  options: string[];
  answer: string;
  explanation: string;
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "had", "has", "have", "he", "her", "hers", "him", "his",
  "i", "in", "is", "it", "its", "me", "my", "of", "on", "or", "our", "she", "so", "that", "the", "their", "them", "then", "there",
  "they", "this", "to", "up", "us", "was", "we", "were", "what", "when", "where", "which", "who", "why", "will", "with", "you", "your",
]);

const DISTRACTOR_WORDS = [
  "spaceship", "banana", "robot", "rainbow", "dinosaur", "piano", "volcano", "camera", "tiger", "ocean", "planet", "castle", "garden", "pencil",
];

function cleanSentence(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sentencesFromBook(book: Book): string[] {
  return [...book.pages]
    .sort((a, b) => a.order - b.order)
    .flatMap((page) => {
      const analyzed = page.analysis?.sentences.map((item) => item.text).filter(Boolean) ?? [];
      if (analyzed.length) return analyzed;
      const text = page.analysis?.fullText || page.text || "";
      return text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [];
    })
    .map(cleanSentence)
    .filter((sentence) => sentence.length >= 3);
}

function wordsFromSentence(sentence: string): string[] {
  return sentence.match(/[A-Za-z]+(?:['’][A-Za-z]+)?/g) ?? [];
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function rotate<T>(items: T[], offset: number): T[] {
  if (!items.length) return [];
  const safe = ((offset % items.length) + items.length) % items.length;
  return [...items.slice(safe), ...items.slice(0, safe)];
}

function selectDistractors(correct: string, vocabulary: string[], count: number, seed: number): string[] {
  const lowerCorrect = correct.toLowerCase();
  const fromBook = vocabulary.filter((word) => word.toLowerCase() !== lowerCorrect && Math.abs(word.length - correct.length) <= 4);
  const fallback = DISTRACTOR_WORDS.filter((word) => word.toLowerCase() !== lowerCorrect && !vocabulary.some((item) => item.toLowerCase() === word));
  return unique(rotate([...fromBook, ...fallback], seed)).slice(0, count);
}

function mixOptions(options: string[], seed: number): string[] {
  if (options.length <= 1) return options;
  return rotate(options, seed % options.length);
}

function replaceOneWord(sentence: string, replacement: string, fromEnd = false): string {
  const words = wordsFromSentence(sentence);
  if (!words.length) return `${sentence} ${replacement}`;
  const target = fromEnd ? words[Math.max(0, words.length - 2)] : words[Math.min(1, words.length - 1)];
  return sentence.replace(target, replacement);
}

export function buildCompletionQuestions(book: Book): QuizQuestion[] {
  const sentences = sentencesFromBook(book);
  if (!sentences.length) return [];

  const vocabulary = unique(sentences.flatMap(wordsFromSentence).filter((word) => word.length >= 3));
  const contentWords = vocabulary.filter((word) => word.length >= 4 && !STOP_WORDS.has(word.toLowerCase()));
  const questions: QuizQuestion[] = [];

  const blankSentence = sentences.find((sentence) => wordsFromSentence(sentence).filter((word) => word.length >= 4 && !STOP_WORDS.has(word.toLowerCase())).length > 0);
  if (blankSentence) {
    const candidates = wordsFromSentence(blankSentence).filter((word) => word.length >= 4 && !STOP_WORDS.has(word.toLowerCase()));
    const answer = [...candidates].sort((a, b) => b.length - a.length)[0];
    const prompt = blankSentence.replace(answer, "_____");
    const options = mixOptions([answer, ...selectDistractors(answer, vocabulary, 3, 1)], 2);
    questions.push({ id: "blank", kind: "blank", title: "빠진 단어 찾기", prompt, options, answer, explanation: `책에는 “${blankSentence}”라고 나왔어요.` });
  }

  const bookWord = contentWords[Math.min(2, Math.max(0, contentWords.length - 1))] ?? vocabulary[0];
  if (bookWord) {
    const outsiders = DISTRACTOR_WORDS.filter((word) => !vocabulary.some((item) => item.toLowerCase() === word)).slice(0, 3);
    questions.push({
      id: "word",
      kind: "word",
      title: "책 속 단어 찾기",
      prompt: "이 책에 실제로 나온 단어는 무엇일까요?",
      options: mixOptions([bookWord, ...outsiders], 1),
      answer: bookWord,
      explanation: `“${bookWord}”는 이 책에서 찾을 수 있는 단어예요.`,
    });
  }

  const sentenceAnswer = sentences[Math.floor(sentences.length / 2)];
  if (sentenceAnswer) {
    const replacements = selectDistractors("story", vocabulary, 3, 3);
    const fakeOne = replaceOneWord(sentenceAnswer, replacements[0] ?? "spaceship");
    const fakeTwo = replaceOneWord(sentenceAnswer, replacements[1] ?? "banana", true);
    const fakeThree = `${sentenceAnswer.replace(/[.!?]+$/, "")} and flew to the moon.`;
    questions.push({
      id: "sentence",
      kind: "sentence",
      title: "진짜 문장 찾기",
      prompt: "책에서 본 문장을 골라 보세요.",
      options: mixOptions(unique([sentenceAnswer, fakeOne, fakeTwo, fakeThree]).slice(0, 4), 3),
      answer: sentenceAnswer,
      explanation: "사진에서 읽었던 문장을 잘 기억했어요.",
    });
  }

  const dialogue = sentences.find((sentence) => /[“”\"]/.test(sentence));
  if (dialogue) {
    const otherSentences = sentences.filter((sentence) => sentence !== dialogue && !/[“”\"]/.test(sentence)).slice(0, 3);
    const fallbacks = ["The moon was made of cheese.", "A robot danced in the kitchen.", "The tiger drove a bus."];
    questions.push({
      id: "dialogue",
      kind: "dialogue",
      title: "등장인물 대사 찾기",
      prompt: "등장인물이 말한 문장은 어느 것일까요?",
      options: mixOptions([dialogue, ...[...otherSentences, ...fallbacks].slice(0, 3)], 2),
      answer: dialogue,
      explanation: "따옴표 안의 문장은 등장인물이 직접 말한 대사예요.",
    });
  }

  if (sentences.length >= 2) {
    const sourceIndex = Math.min(Math.max(0, Math.floor(sentences.length / 3)), sentences.length - 2);
    const source = sentences[sourceIndex];
    const answer = sentences[sourceIndex + 1];
    const other = sentences.filter((sentence, index) => index !== sourceIndex + 1 && sentence !== source).slice(-3);
    const fallback = ["Then a rainbow spaceship appeared.", "Everyone ate a giant banana.", "A robot began to sing."];
    questions.push({
      id: "next",
      kind: "next",
      title: "다음 문장 기억하기",
      prompt: `“${source}” 다음에 나온 문장은 무엇일까요?`,
      options: mixOptions([answer, ...[...other, ...fallback].slice(0, 3)], 1),
      answer,
      explanation: `그다음 문장은 “${answer}”였어요.`,
    });
  }

  return questions.slice(0, 5);
}

export default function CompletionQuiz({ book, onClose, onComplete }: Props) {
  const questions = useMemo(() => buildCompletionQuestions(book), [book]);
  const [started, setStarted] = useState(false);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [score, setScore] = useState(0);
  const [finished, setFinished] = useState(false);

  const question = questions[questionIndex];
  const correct = selected === question?.answer;
  const stars = questions.length ? Math.max(1, Math.round((score / questions.length) * 3)) : 0;

  function choose(option: string) {
    if (!question || selected) return;
    setSelected(option);
    if (option === question.answer) setScore((value) => value + 1);
  }

  function next() {
    if (!question || !selected) return;
    if (questionIndex >= questions.length - 1) {
      const finalScore = score;
      setFinished(true);
      onComplete(finalScore, questions.length);
      return;
    }
    setQuestionIndex((value) => value + 1);
    setSelected(null);
  }

  function retry() {
    setStarted(true);
    setQuestionIndex(0);
    setSelected(null);
    setScore(0);
    setFinished(false);
  }

  return (
    <div className="completion-quiz-backdrop" role="dialog" aria-modal="true" aria-labelledby="completion-quiz-title">
      <section className="completion-quiz-card">
        <button className="completion-quiz-close" type="button" onClick={onClose} aria-label="완독 퀴즈 닫기">×</button>

        {!questions.length ? (
          <div className="completion-quiz-empty">
            <div className="completion-trophy">📚</div>
            <h2 id="completion-quiz-title">먼저 페이지를 분석해 주세요.</h2>
            <p>인식된 문장이 있어야 책 내용으로 퀴즈를 만들 수 있습니다.</p>
            <button className="primary-button" type="button" onClick={onClose}>책으로 돌아가기</button>
          </div>
        ) : !started ? (
          <div className="completion-quiz-start">
            <div className="completion-confetti" aria-hidden="true">🎉 ⭐ 🎈</div>
            <div className="completion-trophy">🏆</div>
            <p className="eyebrow">BOOK COMPLETE</p>
            <h2 id="completion-quiz-title">한 권을 끝까지 읽었어요!</h2>
            <p>책에서 나온 문장과 단어로 만든 {questions.length}개의 미니게임에 도전해 보세요.</p>
            <div className="completion-best-score">최고 점수: {book.quizBestScore ?? 0} / {questions.length}</div>
            <button className="primary-button completion-start-button" type="button" onClick={() => setStarted(true)}>🎮 퀴즈 시작</button>
          </div>
        ) : finished ? (
          <div className="completion-quiz-finish">
            <div className="completion-confetti" aria-hidden="true">🎊 ✨ 🎊</div>
            <div className="completion-stars" aria-label={`${stars}개 별`}>{"⭐".repeat(stars)}{"☆".repeat(Math.max(0, 3 - stars))}</div>
            <h2 id="completion-quiz-title">정말 잘했어요!</h2>
            <p className="completion-score"><strong>{score}</strong> / {questions.length} 정답</p>
            <p>{score === questions.length ? "책 내용을 완벽하게 기억했어요!" : score >= Math.ceil(questions.length * 0.6) ? "조금만 더 하면 만점이에요!" : "책을 한 번 더 읽고 다시 도전해 보세요."}</p>
            <div className="completion-quiz-actions">
              <button className="secondary-button" type="button" onClick={retry}>↻ 다시 도전</button>
              <button className="primary-button" type="button" onClick={onClose}>책으로 돌아가기</button>
            </div>
          </div>
        ) : question ? (
          <div className="completion-question">
            <div className="completion-question-header">
              <span>{questionIndex + 1} / {questions.length}</span>
              <div className="completion-question-progress"><i style={{ width: `${((questionIndex + 1) / questions.length) * 100}%` }} /></div>
            </div>
            <p className="eyebrow">{question.title}</p>
            <h2 id="completion-quiz-title">{question.prompt}</h2>
            <div className="completion-options">
              {question.options.map((option, index) => {
                const isAnswer = option === question.answer;
                const isSelected = option === selected;
                const stateClass = selected ? isAnswer ? " correct" : isSelected ? " wrong" : "" : "";
                return (
                  <button key={`${question.id}-${option}`} className={`completion-option${stateClass}`} type="button" disabled={Boolean(selected)} onClick={() => choose(option)}>
                    <span>{String.fromCharCode(65 + index)}</span><strong>{option}</strong>
                  </button>
                );
              })}
            </div>
            {selected && (
              <div className={`completion-answer${correct ? " correct" : " wrong"}`} role="status">
                <strong>{correct ? "정답이에요! 🎉" : "아쉽지만 다시 기억해 볼까요?"}</strong>
                <p>{question.explanation}</p>
                <button className="primary-button" type="button" onClick={next}>{questionIndex >= questions.length - 1 ? "결과 보기" : "다음 문제 →"}</button>
              </div>
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}
