/** 日本時間9時を締切とする前日24時間の更新。境界は開始を含み締切を含まない。 */
export class DigestWindow {
  private readonly cutoff: number;
  private readonly start: number;

  constructor(now: Date) {
    const cutoff = new Date(now);
    cutoff.setUTCHours(0, 0, 0, 0);
    this.cutoff = cutoff.getTime();
    this.start = this.cutoff - 24 * 60 * 60 * 1000;
  }

  classify(lastEditedTime: string): "stale" | "included" | "future" {
    const editedAt = Date.parse(lastEditedTime);
    if (!Number.isFinite(editedAt) || editedAt < this.start) return "stale";
    return editedAt < this.cutoff ? "included" : "future";
  }
}

export interface DigestItem {
  pageId: string;
  title: string;
  summaryMarkdown: string;
  url: string;
  category: string;
  author: string;
}
