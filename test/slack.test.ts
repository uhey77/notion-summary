import { describe, expect, it } from "vitest";
import {
  SlackClient,
  buildDigestMessages,
  buildSummaryMessage,
  markdownToMrkdwn,
  markdownToPlainText,
  splitForSection,
} from "../src/modules/summary/infrastructure/slack/client.js";
import { createFetchMock } from "./helpers/fetchMock.js";

describe("markdownToMrkdwn", () => {
  it("見出しを太字に、箇条書きを • にする", () => {
    expect(markdownToMrkdwn("# 見出し\n- 項目1\n* 項目2")).toBe("*見出し*\n• 項目1\n• 項目2");
  });

  it("**bold** と __italic__ を Slack 形式へ", () => {
    expect(markdownToMrkdwn("**太字** と __斜体__")).toBe("*太字* と _斜体_");
  });

  it("code block の内側は変換しない", () => {
    const md = "- 項目\n```\n- これは変換されない\n# これも\n```";
    const out = markdownToMrkdwn(md);
    expect(out).toContain("• 項目"); // code block 外の箇条書きは変換される
    expect(out).toContain("- これは変換されない"); // code block 内は維持
    expect(out).toContain("# これも");
  });

  it("リンクと取り消し線をSlack形式へ変換し、インラインコードを維持する", () => {
    expect(
      markdownToMrkdwn(
        "- [資料](https://example.com/doc) と ~~旧版~~\n- `**literal**` と `foo__bar__baz`",
      ),
    ).toBe("• <https://example.com/doc|資料> と ~旧版~\n• `**literal**` と `foo__bar__baz`");
  });

  it("Slack形式の箇条書き・強調・リンクをそのまま維持する", () => {
    const text = "• *要点* と _補足_\n1. 次の手順\n<https://example.com|資料>";
    expect(markdownToMrkdwn(text)).toBe(text);
  });

  it("\\1 \\2 の番号プレースホルダを連番へ補正する", () => {
    expect(markdownToMrkdwn("\\1 最初\n\\2 次")).toBe("1 最初\n2 次");
  });
});

describe("splitForSection", () => {
  it("max 以下はそのまま1要素", () => {
    expect(splitForSection("short", 2800)).toEqual(["short"]);
  });

  it("長文を max 文字以内に分割する", () => {
    const text = `${"a".repeat(3000)}\n${"b".repeat(2000)}`;
    const chunks = splitForSection(text, 2800);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(2800);
    }
  });
});

describe("buildSummaryMessage", () => {
  const input = {
    title: "テストページ",
    category: "研究ノート",
    updatedAt: "2026-06-06 19:00",
    summaryMarkdown: "- 要点1\n- 要点2",
    url: "https://notion.so/page",
  };

  it("header / fields / divider / section / context を含む", () => {
    const { blocks, text } = buildSummaryMessage(input);
    const types = (blocks as Array<{ type: string }>).map((b) => b.type);
    expect(types[0]).toBe("header");
    expect(types).toContain("section");
    expect(types).toContain("divider");
    expect(types[types.length - 1]).toBe("context");
    expect(text).toContain("要約: テストページ");
  });

  it("header タイトルは最大140文字に切り詰める", () => {
    const { blocks } = buildSummaryMessage({ ...input, title: "あ".repeat(200) });
    const header = (blocks as Array<{ type: string; text?: { text: string } }>)[0];
    expect(header.text?.text.length).toBe(140);
  });

  it("長い要約は複数 section に分割される", () => {
    const { blocks } = buildSummaryMessage({ ...input, summaryMarkdown: "x".repeat(6000) });
    const sectionCount = (blocks as Array<{ type: string }>).filter(
      (b) => b.type === "section",
    ).length;
    // fields section 1 + summary sections 複数
    expect(sectionCount).toBeGreaterThan(2);
  });
});

describe("buildDigestMessages", () => {
  const items = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      pageId: `p${i}`,
      title: `記事${i}`,
      summaryMarkdown: `- 要点${i}`,
      url: `https://notion.so/p${i}`,
      category: "cat",
      author: `著者${i}`,
    }));

  it("タイトルリンクと最終更新者を同じ行に表示し、記事間に区切り線を入れる", () => {
    const parts = buildDigestMessages({ count: 2, items: items(2), itemMaxChars: 700 });
    expect(parts).toHaveLength(1);
    const rendered = JSON.stringify(parts[0].message.blocks);
    expect(rendered).not.toContain("今日の更新記事");
    expect(parts[0].message.text).toMatch(/^1\. 記事0: https:\/\/notion.so\/p0/);
    expect(rendered).toContain("*1. <https://notion.so/p0|記事0>*");
    expect(rendered).toContain("*2. <https://notion.so/p1|記事1>*");
    expect(rendered).not.toContain("Notion で開く");
    expect((parts[0].message.blocks as Array<{ type: string }>).map((b) => b.type)).toEqual([
      "section",
      "divider",
      "section",
    ]);
    const firstSection = parts[0].message.blocks[0] as { text: { text: string } };
    expect(firstSection.text.text).toBe("*1. <https://notion.so/p0|記事0>* by 著者0\n\n• 要点0");
    expect(rendered).not.toContain("最終更新者：");
    expect(rendered).not.toContain("👤");
    expect(parts[0].message.text).toContain("記事0: https://notion.so/p0 by 著者0");
    expect(parts[0].pageIds).toEqual(["p0", "p1"]);
  });

  it("区切り線を含めてブロック上限内に分割し、各パートの前後に線を置かない", () => {
    const parts = buildDigestMessages({ count: 50, items: items(50), itemMaxChars: 700 });
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      const types = (part.message.blocks as Array<{ type: string }>).map((b) => b.type);
      expect(types.length).toBeLessThanOrEqual(45);
      expect(types[0]).toBe("section");
      expect(types).not.toContain("header");
      expect(part.message.text).not.toContain("今日の更新記事");
      expect(types.at(-1)).toBe("section");
      expect(types.filter((type) => type === "divider")).toHaveLength(part.pageIds.length - 1);
    }
    expect(parts.flatMap((part) => part.pageIds)).toEqual(items(50).map((item) => item.pageId));
    expect(JSON.stringify(parts.at(-1)?.message.blocks)).toContain(
      "*50. <https://notion.so/p49|記事49>*",
    );
  });

  it("タイトル内の山括弧とアンパサンドをリンクの表示文字として扱う", () => {
    const [part] = buildDigestMessages({
      count: 1,
      items: [{ ...items(1)[0], title: "比較 <A & B>" }],
      itemMaxChars: 700,
    });
    expect(JSON.stringify(part.message.blocks)).toContain(
      "<https://notion.so/p0|比較 &lt;A &amp; B&gt;>",
    );
  });

  it("旧itemMaxCharsを超えても全文を表示する", () => {
    const long = [
      {
        pageId: "p",
        title: "t",
        summaryMarkdown: "x".repeat(500),
        url: "u",
        category: "c",
        author: "a",
      },
    ];
    const parts = buildDigestMessages({ count: 1, items: long, itemMaxChars: 50 });
    const section = (
      parts[0].message.blocks as Array<{ type: string; text?: { text: string } }>
    ).find((b) => b.type === "section");
    expect(section?.text?.text).toContain("x".repeat(500));
  });

  it("上限超過で見出しを付けずに複数パートに分割し、pageIds を網羅する", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      pageId: `p${i}`,
      title: `記事${i}`,
      summaryMarkdown: "x".repeat(3000),
      url: "u",
      category: "c",
      author: "a",
    }));
    const parts = buildDigestMessages({ count: 11, items: many, itemMaxChars: 3000 });
    expect(parts.length).toBeGreaterThan(1);
    const allIds = parts.flatMap((p) => p.pageIds).sort();
    expect(allIds).toEqual(many.map((m) => m.pageId).sort());
    for (const part of parts) {
      expect(part.message.blocks).not.toContainEqual(expect.objectContaining({ type: "header" }));
      expect(part.message.text).not.toContain("今日の更新記事");
    }
  });
});

describe("SlackClient.postToChannels", () => {
  const message = { text: "t", blocks: [] };

  it("全チャンネル成功で ts を返す", async () => {
    const fetchImpl = createFetchMock([
      {
        match: (u) => u.includes("chat.postMessage"),
        responses: [{ body: { ok: true, ts: "111.1" } }, { body: { ok: true, ts: "222.2" } }],
      },
    ]);
    const client = new SlackClient("token", fetchImpl);
    const results = await client.postToChannels(["C1", "C2"], message);
    expect(results).toEqual([
      { channel: "C1", ok: true, ts: "111.1" },
      { channel: "C2", ok: true, ts: "222.2" },
    ]);
  });

  it("個別失敗でも他チャンネルへ継続する (エラーを握りつぶさない)", async () => {
    const fetchImpl = createFetchMock([
      {
        match: (u) => u.includes("chat.postMessage"),
        responses: [
          { body: { ok: false, error: "channel_not_found" } },
          { body: { ok: true, ts: "222.2" } },
        ],
      },
    ]);
    const client = new SlackClient("token", fetchImpl);
    const results = await client.postToChannels(["C1", "C2"], message);
    expect(results[0]).toEqual({ channel: "C1", ok: false, error: "channel_not_found" });
    expect(results[1]).toEqual({ channel: "C2", ok: true, ts: "222.2" });
  });
});

describe("digest plain text", () => {
  it("日本語の強調記号を除去し、箇条書きを維持する", () => {
    expect(markdownToPlainText("## 要点\n- **Slack**と*Notion*を導入する。")).toBe(
      "要点\n• SlackとNotionを導入する。",
    );
  });

  it("本文はSlackの書式を維持し、プレビューのみ装飾を除去する", () => {
    const [part] = buildDigestMessages({
      count: 1,
      itemMaxChars: 200,
      items: [
        {
          pageId: "p",
          title: "オンボーディング",
          author: "田辺",
          category: "c",
          summaryMarkdown:
            "- **Slack**は*コミュニケーション*に使う。\n- `npm run test`で確認する。\n- [資料](https://example.com/doc)を参照する。",
          url: "https://notion.so/p",
        },
      ],
    });
    const section = part.message.blocks[0] as { text: { type: string; text: string } };
    expect(section.text.type).toBe("mrkdwn");
    expect(section.text.text).toContain("• *Slack*は*コミュニケーション*に使う。");
    expect(section.text.text).toContain("• `npm run test`で確認する。");
    expect(section.text.text).toContain("• <https://example.com/doc|資料>を参照する。");
    expect(JSON.stringify(part.message.blocks)).toContain("<https://notion.so/p|オンボーディング>");
    expect(part.message.text).not.toContain("*");
    expect(part.message.text).not.toContain("`");
    expect(part.message.text).toContain("• Slackはコミュニケーションに使う。");
    expect(part.message.text).toContain("資料: https://example.com/doc");
    expect(part.message.text).toContain("オンボーディング: https://notion.so/p");
  });
});

it("長い記事を削らず分割し、最後のパートでのみ配信済みにする", () => {
  const summary = `${"あ".repeat(31000)}最後の要点。`;
  const parts = buildDigestMessages({
    count: 1,
    itemMaxChars: 200,
    items: [
      {
        pageId: "long",
        title: "長文",
        summaryMarkdown: summary,
        url: "https://notion.so/long",
        category: "c",
        author: "更新者",
      },
    ],
  });
  const sections = parts
    .flatMap((p) => p.message.blocks as Array<{ type: string; text?: { text: string } }>)
    .filter((b) => b.type === "section");
  const rendered = sections.map((b) => b.text?.text).join("");
  expect(rendered).toContain(summary);
  expect(rendered).toContain("<https://notion.so/long|長文>");
  expect(
    parts
      .flatMap((part) => part.message.blocks as Array<{ type: string }>)
      .some((block) => block.type === "divider"),
  ).toBe(false);
  expect(sections.every((b) => (b.text?.text.length ?? 0) <= 2800)).toBe(true);
  expect(parts.length).toBeGreaterThan(1);
  expect(parts.slice(0, -1).flatMap((p) => p.pageIds)).toEqual([]);
  expect(parts.at(-1)?.pageIds).toEqual(["long"]);
});
