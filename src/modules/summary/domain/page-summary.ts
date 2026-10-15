export type PageStatus =
  | "pending"
  | "processing"
  | "summarized"
  | "completed"
  | "failed"
  | "skipped";

/** ページ単位の要約状態。永続化のカラム名やAPIの応答形式を持ち込まない。 */
export class PageSummary {
  constructor(
    readonly pageId: string,
    readonly status: PageStatus,
    readonly lastEditedTime: string,
    readonly debounceUntil: string,
    readonly lastSummarizedAt: string | null,
    readonly retryCount: number,
    readonly summary: string | null,
    readonly title: string | null,
    readonly url: string | null,
    readonly category: string | null,
    readonly author: string | null,
  ) {}

  isStillEditing(now: Date): boolean {
    return Date.parse(this.debounceUntil) > now.getTime();
  }

  hasSummarizedVersion(lastEditedTime: string): boolean {
    return this.lastEditedTime.length > 0 && this.lastEditedTime === lastEditedTime;
  }

  canRetry(retryable: boolean, maxAttempts: number): boolean {
    return retryable && this.retryCount + 1 < maxAttempts;
  }
}

/** 最終イベントからの待機時間と、前回要約からの最短間隔を両方守る。 */
export function nextSummaryTime(
  now: Date,
  delaySeconds: number,
  minIntervalSeconds: number,
  lastSummarizedAt?: string | null,
): string {
  const debounce = now.getTime() + delaySeconds * 1000;
  const cooldown = lastSummarizedAt
    ? Date.parse(lastSummarizedAt) + minIntervalSeconds * 1000
    : Number.NaN;
  return new Date(
    Number.isFinite(cooldown) ? Math.max(debounce, cooldown) : debounce,
  ).toISOString();
}

export function belongsToDatabase(
  parentId: string | undefined,
  targetId: string | undefined,
): boolean {
  const normalize = (id: string | undefined) => id?.replace(/-/g, "").toLowerCase() ?? "";
  return !targetId || normalize(parentId) === normalize(targetId);
}
