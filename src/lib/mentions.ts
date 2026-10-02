export const USERNAME_PATTERN = /^[a-z0-9_]{2,24}$/;

const MENTION_RE = /(^|[^A-Za-z0-9_@/])@([A-Za-z0-9_]{2,24})\b/g;

/** Lower-cased usernames mentioned in a comment body, in order of appearance. */
export function extractMentions(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(MENTION_RE)) found.add(match[2]!.toLowerCase());
  return [...found];
}

export const REACTION_EMOJIS = ["👍", "❤️", "🔥", "😂", "👀", "✅", "🎉", "🙏"] as const;
