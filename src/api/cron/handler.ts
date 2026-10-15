import type { DigestDeps } from "../../modules/summary/application/use-cases/publish-daily-digest.js";
import { runDailyDigest } from "../../modules/summary/application/use-cases/publish-daily-digest.js";
import type { SummaryDeps } from "../../modules/summary/application/use-cases/summarize-pages.js";
import { processDuePages } from "../../modules/summary/application/use-cases/summarize-pages.js";

/** 通知は日本時間9時のCronのみ。それ以外は要約を保存する。 */
export function handleScheduled(cron: string, deps: SummaryDeps & DigestDeps): Promise<void> {
  return cron === "0 0 * * *" ? runDailyDigest(deps) : processDuePages(deps);
}
