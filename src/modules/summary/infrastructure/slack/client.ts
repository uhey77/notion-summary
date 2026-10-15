/**
 * Slack 投稿クライアント (spec §13)。
 *
 * - Gemini の Markdown 要約を Slack mrkdwn へ変換する。
 * - Block Kit payload (header / fields / divider / summary sections / context) を構築する。
 * - 複数チャンネルへ投稿し、チャンネルごとの成否を返す (個別失敗は他チャンネルを止めない)。
 *
 * 投稿の冪等性 (投稿済みチャンネルの除外) は呼び出し側 (consumer) が担う。
 * 本クライアントは「与えられたチャンネルへ投稿し、結果を返す」ことに徹する。
 */
import type { DeliveryResult } from "../../application/ports/services.js";
import type { DigestItem } from "../../domain/digest.js";

const SLACK_POST_URL = "https://slack.com/api/chat.postMessage";
const HEADER_TITLE_MAX = 140;
const SECTION_TEXT_MAX = 2800;
const FALLBACK_TEXT_MAX = 3000;
// ダイジェスト分割の上限。Slack の blocks(<=50) / 全体サイズに対し余裕をもたせる。
const MAX_BLOCKS_PER_MESSAGE = 45;
const MAX_TEXT_PER_MESSAGE = 28000;
const DIGEST_HEADER = "今日の更新記事";

export interface SummaryMessageInput {
  title: string;
  category: string;
  updatedAt: string;
  /** Gemini が生成した Markdown 要約本文。 */
  summaryMarkdown: string;
  url: string;
}

export interface SlackMessage {
  text: string;
  blocks: unknown[];
}

/** ダイジェスト 1 記事分の入力。 */
export type DigestItemInput = DigestItem;

export interface DigestMessageInput {
  /** 全記事数 (header 表示用。分割しても総数を出す)。 */
  count: number;
  items: DigestItemInput[];
  /** 互換性のため残す旧設定。本文の切り詰めには使用しない。 */
  itemMaxChars: number;
}

/** 1 通のダイジェストメッセージと、それが載せた記事の pageId 群。 */
export interface DigestPart {
  message: SlackMessage;
  pageIds: string[];
}

export class SlackClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly token: string,
    fetchImpl?: typeof fetch,
  ) {
    // Workers ではグローバル fetch をメソッド呼び出しすると this がずれて
    // "Illegal invocation" になるため globalThis に束縛する。
    this.fetchImpl = fetchImpl ?? fetch.bind(globalThis);
  }

  /** 1 チャンネルへ投稿する。例外は握りつぶさず結果オブジェクトへ写す (握りつぶし禁止に対応)。 */
  async postMessage(channel: string, message: SlackMessage): Promise<DeliveryResult> {
    try {
      const res = await this.fetchImpl(SLACK_POST_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ channel, text: message.text, blocks: message.blocks }),
      });
      const body = (await res.json()) as { ok?: boolean; ts?: string; error?: string };
      if (res.ok && body.ok) {
        return { channel, ok: true, ts: body.ts };
      }
      return { channel, ok: false, error: body.error ?? `http_${res.status}` };
    } catch (error) {
      return { channel, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 複数チャンネルへ順に投稿し、すべての結果を返す (個別失敗で止めない)。 */
  async postToChannels(channels: string[], message: SlackMessage): Promise<DeliveryResult[]> {
    const results: DeliveryResult[] = [];
    for (const channel of channels) {
      results.push(await this.postMessage(channel, message));
    }
    return results;
  }
}

/** 要約メッセージ (Block Kit + fallback text) を構築する。 */
export function buildSummaryMessage(input: SummaryMessageInput): SlackMessage {
  const headerTitle = truncate(`要約: ${input.title}`, HEADER_TITLE_MAX);
  const mrkdwn = markdownToMrkdwn(input.summaryMarkdown);
  const summaryChunks = splitForSection(mrkdwn, SECTION_TEXT_MAX);

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: headerTitle, emoji: true } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*カテゴリ*\n${input.category}` },
        { type: "mrkdwn", text: `*更新日時*\n${input.updatedAt}` },
      ],
    },
    { type: "divider" },
    ...summaryChunks.map((chunk) => ({
      type: "section",
      text: { type: "mrkdwn", text: chunk },
    })),
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `<${input.url}|Notion で開く>` }],
    },
  ];

  const text = truncate(`要約: ${input.title}\n${mrkdwn}`, FALLBACK_TEXT_MAX);
  return { text, blocks };
}

/**
 * 日次ダイジェストを Slack メッセージ (複数可) へ組み立てる。
 * 記事数/文字数が Slack の上限 (blocks<=50 / 全体サイズ) を超える場合は複数メッセージへ分割する。
 * 記事番号はパートをまたいで連番 (1..count)。各パートは載せた記事の pageId 群を返し、
 * 呼び出し側 (consumer) がパート単位で配信済みマークを付けられるようにする。
 */
export function buildDigestMessages(input: DigestMessageInput): DigestPart[] {
  // 本文は削らず、Slack の section 制限に合わせて分割する。
  const itemBlocks = input.items.flatMap((item, i) => {
    const summary = markdownToPlainText(item.summaryMarkdown);
    const text = `*${i + 1}. ${item.title}*\n👤 *最終更新者：${item.author}*\n${summary}\n<${item.url}|Notion で開く>`;
    const chunks = splitForSection(text, SECTION_TEXT_MAX);
    return chunks.map((text, index) => ({
      text,
      // 記事の最後の部分が送信できた時点で配信済みにする。
      pageId: index === chunks.length - 1 ? item.pageId : undefined,
    }));
  });

  // greedy パッキング: 各パートは header(1 block) + 記事 sections。
  // block 数・累積文字数のどちらかが上限を超えたら新しいパートへ。
  const groups: { texts: string[]; pageIds: string[]; chars: number }[] = [];
  for (const ib of itemBlocks) {
    const last = groups[groups.length - 1];
    if (
      last === undefined ||
      last.texts.length >= MAX_BLOCKS_PER_MESSAGE - 1 || // header 1 block 分を差し引く
      last.chars + ib.text.length > MAX_TEXT_PER_MESSAGE
    ) {
      groups.push({
        texts: [ib.text],
        pageIds: ib.pageId ? [ib.pageId] : [],
        chars: ib.text.length,
      });
    } else {
      last.texts.push(ib.text);
      if (ib.pageId) last.pageIds.push(ib.pageId);
      last.chars += ib.text.length;
    }
  }

  const total = groups.length;
  return groups.map((group, idx) => {
    const headerText =
      total > 1
        ? `${DIGEST_HEADER}: ${input.count}件 (${idx + 1}/${total})`
        : `${DIGEST_HEADER}: ${input.count}件`;
    const blocks: unknown[] = [
      {
        type: "header",
        text: { type: "plain_text", text: truncate(headerText, HEADER_TITLE_MAX), emoji: true },
      },
      ...group.texts.map((text) => ({ type: "section", text: { type: "mrkdwn", text } })),
    ];
    const fallback = truncate(
      `${headerText}\n${group.texts.map((text) => markdownToPlainText(text).replace(/<([^>|]+)\|([^>]+)>/g, "$2: $1")).join("\n\n")}`,
      FALLBACK_TEXT_MAX,
    );
    return { message: { text: fallback, blocks }, pageIds: group.pageIds };
  });
}

/** 要約の装飾を取り除き、Slack 本文と通知プレビューで読める文章にする。 */
export function markdownToPlainText(markdown: string): string {
  return markdownToMrkdwn(markdown)
    .replace(/```(?:[^\n`]*\n)?([\s\S]*?)```/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\*+([^*\n]+)\*+/g, "$1")
    .replace(/_+([^_\n]+)_+/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1");
}

/**
 * Markdown を Slack mrkdwn へ変換する (spec §13)。
 * fenced code block の内側は変換せず維持する。
 */
export function markdownToMrkdwn(markdown: string): string {
  // ```...``` を捕捉して分割。奇数インデックスが code block。
  const segments = markdown.split(/(```[\s\S]*?```)/g);
  return segments
    .map((segment, index) => (index % 2 === 1 ? segment : convertNonCode(segment)))
    .join("");
}

function convertNonCode(text: string): string {
  const converted = text
    .split("\n")
    .map((line) => {
      const heading = line.match(/^(\s*)#{1,6}\s+(.*)$/);
      if (heading) return `${heading[1]}*${heading[2]}*`;
      const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
      if (bullet) return `${bullet[1]}• ${bullet[2]}`;
      return line;
    })
    .join("\n");

  // 強調記法を Slack 形式へ。
  let result = converted.replace(/\*\*([^*]+)\*\*/g, "*$1*").replace(/__([^_]+)__/g, "_$1_");

  // `\1` `\2` のような番号プレースホルダを連番へ補正する。
  let counter = 0;
  result = result.replace(/\\\d+/g, () => {
    counter += 1;
    return String(counter);
  });

  return result;
}

/** Slack section の文字数制限に収めるため max 文字単位で分割する (改行優先)。 */
export function splitForSection(text: string, max = SECTION_TEXT_MAX): string[] {
  if (text.length <= max) return text.length > 0 ? [text] : [""];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}
