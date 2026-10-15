import { ExternalServiceError, type PageSource } from "../../application/ports/services.js";
import type { PageContent, PageInfo } from "../../domain/summary.js";
/**
 * Notion REST API クライアント (spec §10)。
 *
 * - ページ情報 (title / url / last_edited_time / 親DB) の取得。
 * - 本文ブロックのページネーション + 子ブロック再帰取得 (上限つき)。
 * - 取得結果の Markdown 化と本文長の打ち切り。
 *
 * 失敗の分類:
 *   - 429 / 5xx は retryable=true (呼び出し側で Queue retry に回す)。
 *   - 4xx (404 削除済み / 403 権限不足 / 400 不正) は retryable=false。
 * fetch は注入可能 (テストでモックする)。
 */
import { type NotionBlock, blocksToMarkdown } from "./markdown.js";

const NOTION_API_BASE = "https://api.notion.com";
const TRUNCATION_NOTE = "[本文が長いため、一部のブロックは省略されています]";

export class NotionApiError extends ExternalServiceError {
  constructor(
    message: string,
    readonly status: number,
    retryable: boolean,
  ) {
    super(message, retryable);
    this.name = "NotionApiError";
  }
}

export interface NotionClientOptions {
  token: string;
  notionVersion: string;
  pageSize: number;
  maxBlockFetches: number;
  maxBlocks: number;
  maxMarkdownChars: number;
  fetchImpl?: typeof fetch;
}

interface FetchContext {
  fetches: number;
  blocks: number;
  truncated: boolean;
}

export class NotionClient implements PageSource {
  private readonly fetchImpl: typeof fetch;
  /** user id -> name の同一 invocation 内キャッシュ (最終更新者名の重複解決を避ける)。 */
  private readonly userNameCache = new Map<string, string>();

  constructor(private readonly opts: NotionClientOptions) {
    // Workers ではグローバル fetch をメソッド呼び出しすると this がずれて
    // "Illegal invocation" になるため globalThis に束縛する。
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  private async request<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${NOTION_API_BASE}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        "Notion-Version": this.opts.notionVersion,
      },
    });
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      // body はエラー詳細のみ読む。秘密情報・本文全文はログに残さない方針なので status だけ持つ。
      throw new NotionApiError(`Notion API ${res.status} for ${path}`, res.status, retryable);
    }
    return (await res.json()) as T;
  }

  /** ページ情報を取得し、要約に必要な最小情報へ整形する。 */
  async getPageInfo(pageId: string): Promise<PageInfo> {
    const page = await this.request<Record<string, unknown>>(`/v1/pages/${pageId}`);
    return {
      id: typeof page.id === "string" ? page.id : pageId,
      title: extractTitle(page),
      url: typeof page.url === "string" ? page.url : "",
      lastEditedTime: typeof page.last_edited_time === "string" ? page.last_edited_time : "",
      parentDatabaseId: extractParentDatabaseId(page),
      lastEditedById: extractLastEditedById(page),
    };
  }

  /**
   * user id から表示名を解決する (最終更新者名の表示用)。
   * ページ本体の last_edited_by は id のみ (partial user) なので Users API で名前を引く。
   * 同一 invocation 内はキャッシュし、名前が取れなければ空文字を返す。
   */
  async getUserName(userId: string): Promise<string> {
    const cached = this.userNameCache.get(userId);
    if (cached !== undefined) return cached;
    const user = await this.request<Record<string, unknown>>(`/v1/users/${userId}`);
    const name = typeof user.name === "string" ? user.name : "";
    this.userNameCache.set(userId, name);
    return name;
  }

  /** 親 DB のタイトル (カテゴリ表示用)。取得失敗・無題なら undefined。 */
  async getDatabaseTitle(databaseId: string): Promise<string | undefined> {
    const db = await this.request<Record<string, unknown>>(`/v1/databases/${databaseId}`);
    const title = richTextArrayToPlain(db.title);
    return title.length > 0 ? title : undefined;
  }

  /** ページ本文を取得し Markdown 化する。上限到達時は末尾に省略注記を付ける。 */
  async getPageContent(pageId: string): Promise<PageContent> {
    const ctx: FetchContext = { fetches: 0, blocks: 0, truncated: false };
    const tree = await this.listChildren(pageId, ctx);
    let markdown = blocksToMarkdown(tree);
    let truncated = ctx.truncated;

    if (markdown.length > this.opts.maxMarkdownChars) {
      markdown = markdown.slice(0, this.opts.maxMarkdownChars).trimEnd();
      truncated = true;
    }
    if (truncated) {
      markdown = `${markdown}\n\n${TRUNCATION_NOTE}`;
    }
    return { markdown, blockCount: ctx.blocks, truncated };
  }

  /**
   * block children をページネーションしつつ取得し、子ブロックを再帰取得する。
   * maxBlockFetches (API 呼び出し回数) / maxBlocks (総ブロック数) で打ち切る。
   */
  private async listChildren(blockId: string, ctx: FetchContext): Promise<NotionBlock[]> {
    const collected: NotionBlock[] = [];
    let cursor: string | undefined;

    do {
      if (ctx.fetches >= this.opts.maxBlockFetches) {
        ctx.truncated = true;
        break;
      }
      ctx.fetches += 1;

      const query = new URLSearchParams({ page_size: String(this.opts.pageSize) });
      if (cursor) query.set("start_cursor", cursor);
      const res = await this.request<{
        results?: NotionBlock[];
        has_more?: boolean;
        next_cursor?: string | null;
      }>(`/v1/blocks/${blockId}/children?${query.toString()}`);

      const results = Array.isArray(res.results) ? res.results : [];
      for (const block of results) {
        if (ctx.blocks >= this.opts.maxBlocks) {
          ctx.truncated = true;
          break;
        }
        ctx.blocks += 1;
        collected.push(block);
      }
      if (ctx.blocks >= this.opts.maxBlocks) {
        ctx.truncated = true;
        break;
      }
      cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
    } while (cursor);

    for (const block of collected) {
      if (!block.has_children) continue;
      if (block.type === "child_page" || block.type === "child_database") continue;
      if (ctx.fetches >= this.opts.maxBlockFetches || ctx.blocks >= this.opts.maxBlocks) {
        ctx.truncated = true;
        break;
      }
      const id = typeof block.id === "string" ? block.id : undefined;
      if (!id) continue;
      block.children = await this.listChildren(id, ctx);
    }

    return collected;
  }
}

/**
 * Notion URL または ID 文字列から page ID を抽出し、8-4-4-4-12 形式へ整形する (spec §10)。
 * 末尾の 32 桁 16 進数を採用する。抽出できなければ null。
 */
export function extractPageId(input: string): string | null {
  const withoutQuery = input.split(/[?#]/)[0].replace(/\/+$/, "");
  const compact = withoutQuery.replace(/-/g, "");
  const tail = compact.slice(-32);
  if (!/^[0-9a-fA-F]{32}$/.test(tail)) return null;
  const id = tail.toLowerCase();
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/** ページの title プロパティ (type==="title") から平文タイトルを抽出する。 */
function extractTitle(page: Record<string, unknown>): string {
  const properties = page.properties;
  if (properties && typeof properties === "object") {
    for (const value of Object.values(properties as Record<string, unknown>)) {
      if (
        value &&
        typeof value === "object" &&
        (value as Record<string, unknown>).type === "title"
      ) {
        const title = richTextArrayToPlain((value as Record<string, unknown>).title);
        if (title.length > 0) return title;
      }
    }
  }
  return "タイトルなし";
}

function extractParentDatabaseId(page: Record<string, unknown>): string | undefined {
  const parent = page.parent;
  if (parent && typeof parent === "object") {
    const p = parent as Record<string, unknown>;
    if (p.type === "database_id" && typeof p.database_id === "string") {
      return p.database_id;
    }
  }
  return undefined;
}

/** ページの created_by (partial user) から最終更新者 user id を抽出する。 */
function extractLastEditedById(page: Record<string, unknown>): string | undefined {
  const createdBy = page.last_edited_by;
  if (createdBy && typeof createdBy === "object") {
    const id = (createdBy as Record<string, unknown>).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return undefined;
}

/** rich_text 配列 (plain_text を持つ) を連結する。 */
function richTextArrayToPlain(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((rt) => {
      if (rt && typeof rt === "object" && "plain_text" in rt) {
        const pt = (rt as { plain_text?: unknown }).plain_text;
        return typeof pt === "string" ? pt : "";
      }
      return "";
    })
    .join("");
}
