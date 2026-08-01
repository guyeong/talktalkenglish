import type { Page } from "./Page";

export interface Book {
  id: string;
  title: string;
  pages: Page[];
  createdAt: number;
  updatedAt: number;
  progress: number;
}
