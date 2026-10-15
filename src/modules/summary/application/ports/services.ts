import type { DigestItem } from "../../domain/digest.js";
import type { PageContent, PageInfo, SummarizeInput } from "../../domain/summary.js";

export interface PageSource {
  getPageInfo(pageId: string): Promise<PageInfo>;
  getPageContent(pageId: string): Promise<PageContent>;
  getDatabaseTitle(databaseId: string): Promise<string | undefined>;
  getUserName(userId: string): Promise<string>;
}
export interface Summarizer {
  summarize(input: SummarizeInput): Promise<string>;
}
export interface DeliveryResult {
  channel: string;
  ok: boolean;
  ts?: string;
  error?: string;
}
/** 外部サービス固有のメッセージ形式はアダプター内に閉じ込める。 */
export interface PreparedDigestPart {
  pageIds: string[];
  post(channels: string[]): Promise<DeliveryResult[]>;
}
export interface DigestPublisher {
  prepare(input: {
    count: number;
    items: DigestItem[];
    itemMaxChars: number;
  }): PreparedDigestPart[];
}
/** 各アダプターが外部APIエラーを再試行可否へ翻訳する。未知の例外は従来どおり再試行する。 */
export class ExternalServiceError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ExternalServiceError";
  }
}
