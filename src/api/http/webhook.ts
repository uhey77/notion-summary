/**
 * POST /notion/webhook ハンドラ (軽量構成 / spec §6 + 計画 §4-A)。
 *
 * Webhook は「素早く受理して記録するだけ」に徹する (Notion API を叩かない)。
 * 重い処理 (ページ取得・DBフィルタ・要約・Slack) はすべて Cron 側 (consumer) で行う。
 * これにより Notion の配信タイムアウトによる Canceled や D1 競合を避ける。
 *
 * 順序:
 *   1. raw body を 1 回だけ読む (request.json() は使わない)。
 *   2. JSON parse。
 *   3. verification_token を含めば初回ハンドシェイクとして 200 (署名検証不要)。
 *   4. それ以外は署名必須。NOTION_WEBHOOK_TOKEN 未設定なら fail-closed で 500。
 *   5. 対象イベント/ページ判定 → D1 に debounce 状態を記録 (pending) + 履歴。
 */
import type { UpdateOptions } from "../../modules/summary/application/options.js";
import type { Logger } from "../../modules/summary/application/ports/logger.js";
import {
  type UpdateDeps,
  recordPageUpdate,
} from "../../modules/summary/application/use-cases/record-page-update.js";
import { messageOf } from "../../modules/summary/application/use-cases/support.js";
import { verifyNotionSignature } from "./signature.js";

interface WebhookConfig extends UpdateOptions {
  notionWebhookToken?: string;
  notionEventTypes: string[];
}

export interface WebhookDeps extends UpdateDeps {
  config: WebhookConfig;
  logger: Logger;
}

export async function handleWebhook(request: Request, deps: WebhookDeps): Promise<Response> {
  const { config, logger } = deps;

  // 1. raw body を 1 回だけ読む。
  const raw = await request.text();

  // 2. JSON parse。
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  // 3. 初回検証ハンドシェイク。
  if (typeof payload.verification_token === "string") {
    // setup 時に verification_token を回収するための意図的なログ (API キーではない)。
    logger.info("notion verification handshake", {
      verification_token: payload.verification_token,
    });
    return json({ ok: true }, 200);
  }

  // 4. 署名必須。未設定なら fail-closed。
  if (!config.notionWebhookToken) {
    logger.error("NOTION_WEBHOOK_TOKEN is not configured; rejecting webhook");
    return json({ error: "webhook_not_configured" }, 500);
  }
  const signatureValid = await verifyNotionSignature(
    config.notionWebhookToken,
    raw,
    request.headers.get("X-Notion-Signature"),
  );
  if (!signatureValid) {
    return json({ error: "invalid signature" }, 401);
  }

  // 5. 対象イベント/ページ判定 (Notion API は叩かない)。
  const eventType = typeof payload.type === "string" ? payload.type : "";
  if (!config.notionEventTypes.includes(eventType)) {
    return json({ ok: true, skipped: "event_type" }, 200);
  }

  const entity = asObject(payload.entity);
  if (entity?.type !== "page") {
    return json({ ok: true, skipped: "non_page" }, 200);
  }
  const pageId = typeof entity.id === "string" ? entity.id : "";
  if (!pageId) {
    return json({ ok: true, skipped: "no_page_id" }, 200);
  }

  let jobId: string;
  try {
    jobId = await recordPageUpdate({ pageId, eventType }, deps);
  } catch (error) {
    logger.error("db update failed", { page_id: pageId, error: messageOf(error) });
    return json({ error: "db_error" }, 500);
  }

  logger.info("webhook accepted", { job_id: jobId, page_id: pageId, event_type: eventType });
  return json({ ok: true }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}
