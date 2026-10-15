export type SummaryLength = "short" | "medium" | "long";
export type SummaryStyle = "bullet" | "paragraph";

export interface PageInfo {
  id: string;
  title: string;
  url: string;
  lastEditedTime: string;
  parentDatabaseId?: string;
  lastEditedById?: string;
}
export interface PageContent {
  markdown: string;
  blockCount: number;
  truncated: boolean;
}
export interface SummarizeInput {
  title: string;
  category?: string;
  markdown: string;
}
