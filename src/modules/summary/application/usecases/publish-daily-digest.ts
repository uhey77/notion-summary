import { DigestWindow } from "../../domain/digest.js";
import type { PageSummary } from "../../domain/page-summary.js";
import type { DigestOptions } from "../options.js";
import type { Logger } from "../ports/logger.js";
import type { AppStateStore, PageRepository } from "../ports/repositories.js";
import type { DigestPublisher, PreparedDigestPart } from "../ports/services.js";

export interface DigestDeps {
  config: DigestOptions;
  repository: PageRepository & AppStateStore;
  publisher: DigestPublisher;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  logger: Logger;
}

/**
 * ダイジェストフェーズ (9:00 JST の Cron 1 回分)。
 * summarized なページを集約し、1 通 (上限超過時は複数) の Slack メッセージにまとめて投稿する。
 * 投稿成功したパート単位で completed にし、全パート成功で last_digest_time を更新する。
 * 失敗したパートは summarized のまま残し、翌日のダイジェストで再送する (二重投稿を避ける)。
 */
export async function runDailyDigest(deps: DigestDeps): Promise<void> {
  const nowIso = deps.now().toISOString();
  const window = new DigestWindow(new Date(nowIso));
  const pages: PageSummary[] = [];
  for (const page of await deps.repository.getSummarizedPages()) {
    const eligibility = window.classify(page.lastEditedTime);
    if (eligibility === "stale") {
      await deps.repository.markPageStatus({ pageId: page.pageId, status: "skipped", now: nowIso });
      deps.logger.info("digest: stale update excluded", { page_id: page.pageId });
    } else if (eligibility === "included") {
      pages.push(page);
    }
  }
  if (pages.length === 0) {
    await deps.repository.setAppState("last_digest_time", nowIso, nowIso);
    deps.logger.info("digest: nothing to post");
    return;
  }

  const channels = deps.config.slackChannelIds;
  if (channels.length === 0) {
    // 設定不備。summarized のまま残し、設定後の次回で投稿する。
    deps.logger.error("no slack channel configured for digest");
    return;
  }

  // 上限超過時は複数メッセージへ自動分割。各 part は載せた pageIds を持つ。
  const parts = deps.publisher.prepare({
    count: pages.length,
    itemMaxChars: deps.config.digestItemMaxChars,
    items: pages.map((p) => ({
      pageId: p.pageId,
      title: p.title ?? "(無題)",
      summaryMarkdown: p.summary ?? "",
      url: p.url ?? "",
      category: p.category ?? "未分類",
      author: p.author ?? "不明",
    })),
  });

  let allDelivered = true;
  for (const part of parts) {
    const ok = await postPartWithRetry(deps, channels, part, deps.config.digestMaxRetries);
    if (!ok) {
      // 実行内リトライも全滅 → 残りは翌日に回す (既配信パートは completed 済みで再送されない)。
      deps.logger.warn("digest part failed after retries", { page_ids: part.pageIds });
      allDelivered = false;
      break;
    }
    for (const id of part.pageIds) {
      await deps.repository.markPageStatus({ pageId: id, status: "completed", now: nowIso });
    }
  }

  if (allDelivered) await deps.repository.setAppState("last_digest_time", nowIso, nowIso);
  deps.logger.info("digest posted", { parts: parts.length, all_delivered: allDelivered });
}

/** Slack 投稿を retries 回まで再試行する (全チャンネル ok で成功)。試行間は短い backoff。 */
async function postPartWithRetry(
  deps: DigestDeps,
  channels: string[],
  part: PreparedDigestPart,
  retries: number,
): Promise<boolean> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const results = await part.post(channels);
    if (results.length > 0 && results.every((r) => r.ok)) return true;
    if (attempt < retries) {
      deps.logger.warn("digest post retry", { attempt: attempt + 1 });
      await deps.sleep(500 * (attempt + 1)); // 0.5s, 1.0s ...
    }
  }
  return false;
}
