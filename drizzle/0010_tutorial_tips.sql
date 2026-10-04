CREATE TABLE "tutorial_progress" (
	"user_id" uuid NOT NULL,
	"tip_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tutorial_progress_user_id_tip_id_pk" PRIMARY KEY("user_id","tip_id")
);
--> statement-breakpoint
CREATE TABLE "tutorial_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"tips_enabled" boolean DEFAULT true NOT NULL,
	"reset_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tutorial_progress" ADD CONSTRAINT "tutorial_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutorial_settings" ADD CONSTRAINT "tutorial_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;