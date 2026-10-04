CREATE TABLE "discord_dm_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"notification_id" uuid,
	"kind" text DEFAULT 'NOTIFICATION' NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error" text,
	"message_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discord_dm_recipients" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"discord_user_id" text NOT NULL,
	"channel_id" text,
	"welcomed_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"paused_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discord_dm_deliveries" ADD CONSTRAINT "discord_dm_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_dm_deliveries" ADD CONSTRAINT "discord_dm_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_dm_recipients" ADD CONSTRAINT "discord_dm_recipients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discord_dm_deliveries_user_key_uq" ON "discord_dm_deliveries" USING btree ("user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "discord_dm_deliveries_due_idx" ON "discord_dm_deliveries" USING btree ("status","next_attempt_at");