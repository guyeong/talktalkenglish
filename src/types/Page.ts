export type PageStatus = "pending" | "processing" | "ready" | "error";

export interface BoundingBox {
  /** Normalized 0-1000 coordinate space. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectedSentence {
  id: string;
  text: string;
  bbox: BoundingBox;
}

export interface DetectedWord {
  id: string;
  text: string;
  bbox: BoundingBox;
  sentenceIndex: number;
}

export interface PageAnalysis {
  fullText: string;
  sentences: DetectedSentence[];
  words: DetectedWord[];
  analyzedAt: number;
  model: string;
}

export interface Page {
  id: string;
  image: Blob;
  fileName: string;
  order: number;
  status: PageStatus;
  text?: string;
  analysis?: PageAnalysis;
  errorMessage?: string;
}
