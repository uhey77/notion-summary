import { nextSummaryTime } from "../../domain/page-summary.js";
import type { UpdateOptions } from "../options.js";
import type { JobRepository, PageRepository } from "../ports/repositories.js";

export interface UpdateDeps {
  config: UpdateOptions;
  repository: PageRepository & JobRepository;
  now: () => Date;
  uuid: () => string;
}

/** 受理済みのページ更新を記録する。HTTPや署名、Notion APIには依存しない。 */
export async function recordPageUpdate(
  event: { pageId: string; eventType: string },
  deps: UpdateDeps,
): Promise<string> {
  const now = deps.now();
  const nowIso = now.toISOString();
  const jobId = deps.uuid();
  const existing = await deps.repository.getPageState(event.pageId);
  const debounceUntil = nextSummaryTime(
    now,
    deps.config.summaryDelaySeconds,
    deps.config.summaryMinIntervalSeconds,
    existing?.lastSummarizedAt,
  );
  await deps.repository.upsertPageState({ pageId: event.pageId, debounceUntil, now: nowIso });
  await deps.repository.insertJob({
    id: jobId,
    pageId: event.pageId,
    eventType: event.eventType,
    payloadLastEditedTime: null,
    status: "queued",
    queuedAt: nowIso,
    now: nowIso,
  });
  return jobId;
}
