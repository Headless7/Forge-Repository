import { env } from "../env";

/**
 * Direct messages need only the bot token: people connect their Discord account through "Sign in
 * with Discord" (Account → Security), and the bot messages them. Kept apart from services/discord so
 * `notify` can check it without loading the feeds code.
 */
export function discordDmsConfigured(): boolean {
  return Boolean(env.DISCORD_BOT_TOKEN);
}
