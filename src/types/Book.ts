import type { Page } from "./Page";

export interface Book {
  id: string;
  title: string;
  pages: Page[];
  createdAt: number;
  updatedAt: number;
  progress: number;
  /** Page ids that were read to the end. */
  readPageIds?: string[];
  completedAt?: number;
  quizBestScore?: number;
  quizAttempts?: number;
}
