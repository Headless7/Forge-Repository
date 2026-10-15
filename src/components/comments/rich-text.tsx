import { Fragment, type ReactNode } from "react";
import { IMAGE_TOKEN } from "@/lib/description-images";
import { discordVideoLink, type DiscordVideoLink } from "@/lib/discord-links";
import { cn } from "@/lib/utils";
import { DiscordVideo } from "./discord-video";

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

/** The Discord-hosted videos linked in these lines, each once, in order: they play inline under the block. */
function discordVideosIn(lines: string[]): DiscordVideoLink[] {
  const seen = new Set<string>();
  const out: DiscordVideoLink[] = [];
  for (const line of lines) {
    for (const match of line.matchAll(INLINE)) {
      const url = match[5] ?? match[6];
      if (!url) continue;
      const link = discordVideoLink(url);
      if (link && !seen.has(link.url)) {
        seen.add(link.url);
        out.push(link);
      }
    }
  }
  return out;
}

/**
 * `renderImage`: draws a description image marker (`![name](image:id)`, see lib/description-images)
 * as its own block. Without it, markers stay as text.
 */
export function RichText({ text, mentions, className, renderImage }: { text: string; mentions?: ReadonlySet<string>; className?: string; renderImage?: (id: string, name: string, key: string) => ReactNode }) {
  let lines = text.replace(/\r\n/g, "\n").split("\n");
  // Each image marker becomes a line of its own, so it's drawn as a block between the text around it.
  if (renderImage) lines = lines.flatMap((line) => line.replace(IMAGE_TOKEN, (token) => `\n\u0000${token}\n`).split("\n"));
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let quote: string[] = [];

  const pushVideos = (source: string[], key: string) => {
    for (const [i, link] of discordVideosIn(source).entries()) blocks.push(<DiscordVideo key={`${key}-v${i}`} link={link} />);
  };
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
    pushVideos(paragraph, key);
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
    pushVideos(list, key);
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
    pushVideos(quote, key);
    quote = [];
  };

  for (const line of lines) {
    if (renderImage && line.startsWith("\u0000")) {
      flushParagraph();
      flushList();
      flushQuote();
      const [, name, id] = new RegExp(IMAGE_TOKEN.source, "i").exec(line.slice(1)) ?? [];
      if (id) blocks.push(renderImage(id.toLowerCase(), name ?? "", `img${blocks.length}`));
      continue;
    }
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

const BARE_URL = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

/** A long link as "host/first/…/last" (the full address stays in its tooltip and href). */
export function shortUrl(url: string, max = 48): string {
  try {
    const u = new URL(url);
    const host = u.host.replace(/^www\./, "");
    const full = `${host}${u.pathname === "/" ? "" : u.pathname}${u.search}`;
    if (full.length <= max) return full;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length >= 3) return `${host}/${parts[0]}/…/${parts[parts.length - 1]}`;
    return `${full.slice(0, max - 1)}…`;
  } catch {
    return url;
  }
}

/**
 * Plain text with its http(s) addresses as links (short labels for long ones) — nothing else is
 * formatted, and nothing is treated as HTML. For one-line text like checklist items.
 */
export function LinkedText({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(BARE_URL)) {
    const start = match.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const url = match[0];
    out.push(
      <a
        key={start}
        href={url}
        title={url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        onDoubleClick={(e) => e.stopPropagation()}
        className="break-all text-accent underline-offset-2 hover:underline"
      >
        {shortUrl(url)}
      </a>,
    );
    last = start + url.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
