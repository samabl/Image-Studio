import React, { useMemo, useState } from "react";
import { copyText, openExternal } from "../lib/shell";

// ---------------------------------------------------------------------------
// 轻量 Markdown 渲染器
//
// 刻意不引第三方库：一是省掉 remark/unified 那一大串依赖，
// 二是全程用 React 节点渲染、绝不碰 dangerouslySetInnerHTML，
// 模型输出里的 HTML/脚本不会被执行。
// ---------------------------------------------------------------------------

const INLINE = new RegExp(
  [
    "(`[^`\\n]+`)", // 行内代码
    "(\\*\\*[^*]+\\*\\*)", // 粗体
    "(__[^_]+__)",
    "(~~[^~]+~~)", // 删除线
    "(\\*[^*\\n]+\\*)", // 斜体
    "(_[^_\\n]+_)",
    "(!?\\[[^\\]]*\\]\\([^)\\s]+\\))", // 链接 / 图片
    "(https?://[^\\s<>()]+)", // 裸链接
  ].join("|"),
  "g",
);

function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let idx = 0;
  INLINE.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = INLINE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${idx++}`;

    if (tok.startsWith("`")) {
      out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**") || tok.startsWith("__")) {
      out.push(<strong key={key}>{renderInline(tok.slice(2, -2), key)}</strong>);
    } else if (tok.startsWith("~~")) {
      out.push(<del key={key}>{tok.slice(2, -2)}</del>);
    } else if (tok.startsWith("*") || tok.startsWith("_")) {
      out.push(<em key={key}>{renderInline(tok.slice(1, -1), key)}</em>);
    } else if (tok.startsWith("![")) {
      const mm = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(tok);
      if (mm) out.push(<img key={key} src={mm[2]} alt={mm[1]} loading="lazy" />);
    } else if (tok.startsWith("[")) {
      const mm = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(tok);
      if (mm) {
        out.push(
          <a
            key={key}
            href={mm[2]}
            onClick={(e) => {
              e.preventDefault();
              void openExternal(mm[2]);
            }}
          >
            {mm[1] || mm[2]}
          </a>,
        );
      }
    } else if (tok.startsWith("http")) {
      out.push(
        <a
          key={key}
          href={tok}
          onClick={(e) => {
            e.preventDefault();
            void openExternal(tok);
          }}
        >
          {tok}
        </a>,
      );
    } else {
      out.push(tok);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <pre>
      <button
        type="button"
        className="copy-btn"
        onClick={() => {
          void copyText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          });
        }}
      >
        {copied ? "已复制" : "复制"}
      </button>
      <code className={lang ? `lang-${lang}` : undefined}>{code}</code>
    </pre>
  );
}

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "h"; level: number; text: string }
  | { kind: "code"; code: string; lang: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "hr" }
  | { kind: "table"; head: string[]; rows: string[][] };

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

function parse(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  const flushParagraph = (buf: string[]) => {
    if (buf.length) blocks.push({ kind: "p", lines: [...buf] });
    buf.length = 0;
  };
  const para: string[] = [];

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flushParagraph(para);
      const marker = fence[1];
      const lang = fence[2] ?? "";
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过收尾围栏
      blocks.push({ kind: "code", code: body.join("\n"), lang });
      continue;
    }

    if (!line.trim()) {
      flushParagraph(para);
      i += 1;
      continue;
    }

    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushParagraph(para);
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushParagraph(para);
      blocks.push({ kind: "h", level: h[1].length, text: h[2] });
      i += 1;
      continue;
    }

    // 表格：当前行含 | 且下一行是分隔行
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      flushParagraph(para);
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blocks.push({ kind: "table", head, rows });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushParagraph(para);
      const q: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        q.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push({ kind: "quote", lines: q });
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      flushParagraph(para);
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i += 1;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushParagraph(para);
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i += 1;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    para.push(line);
    i += 1;
  }
  flushParagraph(para);
  return blocks;
}

export function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parse(source), [source]);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        const key = `b${i}`;
        switch (b.kind) {
          case "h": {
            const Tag = (`h${Math.min(b.level, 4)}`) as "h1" | "h2" | "h3" | "h4";
            return <Tag key={key}>{renderInline(b.text, key)}</Tag>;
          }
          case "code":
            return <CodeBlock key={key} code={b.code} lang={b.lang} />;
          case "ul":
            return (
              <ul key={key}>
                {b.items.map((it, j) => (
                  <li key={`${key}-${j}`}>{renderInline(it, `${key}-${j}`)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={key}>
                {b.items.map((it, j) => (
                  <li key={`${key}-${j}`}>{renderInline(it, `${key}-${j}`)}</li>
                ))}
              </ol>
            );
          case "quote":
            return <blockquote key={key}>{renderInline(b.lines.join("\n"), key)}</blockquote>;
          case "hr":
            return <hr key={key} />;
          case "table":
            return (
              <table key={key}>
                <thead>
                  <tr>
                    {b.head.map((c, j) => (
                      <th key={`${key}-h${j}`}>{renderInline(c, `${key}-h${j}`)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((r, ri) => (
                    <tr key={`${key}-r${ri}`}>
                      {r.map((c, ci) => (
                        <td key={`${key}-r${ri}c${ci}`}>{renderInline(c, `${key}-r${ri}c${ci}`)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          default:
            return (
              <p key={key}>
                {b.lines.map((ln, j) => (
                  <React.Fragment key={`${key}-${j}`}>
                    {j > 0 && <br />}
                    {renderInline(ln, `${key}-${j}`)}
                  </React.Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
