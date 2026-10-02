import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Lightweight, XSS-safe formatting for comments and descriptions. Input is never
 * treated as HTML: the text is tokenised into React elements, and only http(s)
 * links are produced.
 *
 * Supported: **bold**, *italic* / _italic_, `code`, [label](https://…), bare URLs,
 * @mentions, "- " bullet lists, "> " quotes and line breaks.
 */
const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])|((?<![\w@])@[a-zA-Z0-9_]{2,24})|(\*[^*\n]+\*|(?<!\w)_[^_\n]+_(?!\w))/g;

function inline(text: string, mentions: ReadonlySet<string> | undefined, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const key = `${keyPrefix}-${i++}`;
    const [whole, code, bold, , linkText, linkUrl, url, mention, italic] = match;
    if (code) {
      out.push(
        <code key={key} className="rounded bg-surface-4 px-1 py-px font-mono text-[0.92em]">
          {code.slice(1, -1)}
        </code>,
      );
    } else if (bold) {
      out.push(<strong key={key}>{bold.slice(2, -2)}</strong>);
    } else if (linkText && linkUrl) {
      out.push(
        <a key={key} href={linkUrl} target="_blank" rel="noopener noreferrer nofollow" className="text-accent underline-offset-2 hover:underline">
          {linkText}
        </a>,
      );
    } else if (url) {
      out.push(
        <a key={key} href={url} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-accent underline-offset-2 hover:underline">
          {url}
        </a>,
      );
    } else if (mention) {
      const known = !mentions || mentions.has(mention.slice(1).toLowerCase());
      out.push(
        <span key={key} className={cn(known && "rounded bg-accent-soft px-0.5 font-medium text-accent")}>
          {mention}
        </span>,
      );
    } else if (italic) {
      out.push(<em key={key}>{italic.slice(1, -1)}</em>);
    } else {
      out.push(whole);
    }
    last = start + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function RichText({ text, mentions, className }: { text: string; mentions?: ReadonlySet<string>; className?: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let quote: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const key = `p${blocks.length}`;
    blocks.push(
      <p key={key}>
        {paragraph.map((line, i) => (
          <Fragment key={i}>
            {i > 0 ? <br /> : null}
            {inline(line, mentions, `${key}-${i}`)}
          </Fragment>
        ))}
      </p>,
    );
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    const key = `ul${blocks.length}`;
    blocks.push(
      <ul key={key} className="list-disc space-y-0.5 pl-5">
        {list.map((item, i) => (
          <li key={i}>{inline(item, mentions, `${key}-${i}`)}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  const flushQuote = () => {
    if (!quote.length) return;
    const key = `q${blocks.length}`;
    blocks.push(
      <blockquote key={key} className="border-l-2 border-border-strong pl-3 text-fg-muted">
        {quote.map((line, i) => (
          <Fragment key={i}>
            {i > 0 ? <br /> : null}
            {inline(line, mentions, `${key}-${i}`)}
          </Fragment>
        ))}
      </blockquote>,
    );
    quote = [];
  };

  for (const line of lines) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const quoted = /^\s*>\s?(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      flushQuote();
      list.push(bullet[1]!);
    } else if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1]!);
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
      flushQuote();
    } else {
      flushList();
      flushQuote();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  flushQuote();

  return <div className={cn("space-y-2 break-words text-[13px] leading-relaxed", className)}>{blocks}</div>;
}
