CREATE TABLE "alert_deliveries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_prefs" (
	"address" text PRIMARY KEY NOT NULL,
	"rules" jsonb NOT NULL,
	"email" text,
	"telegram" text,
	"reminders" jsonb NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "launch_price_samples" (
	"mint" text NOT NULL,
	"t" timestamp with time zone NOT NULL,
	"epoch" integer NOT NULL,
	"price_sol" double precision NOT NULL,
	CONSTRAINT "launch_price_samples_mint_t_pk" PRIMARY KEY("mint","t")
);
--> statement-breakpoint
CREATE TABLE "pool_snapshots" (
	"epoch" integer PRIMARY KEY NOT NULL,
	"senior_assets" bigint NOT NULL,
	"senior_shares" bigint NOT NULL,
	"junior_assets" bigint NOT NULL,
	"junior_shares" bigint NOT NULL,
	"outstanding_principal" bigint NOT NULL,
	"cash" bigint NOT NULL,
	"senior_price_e9" bigint NOT NULL,
	"junior_price_e9" bigint NOT NULL,
	"utilization_bps" integer NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "predict_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"address" text NOT NULL,
	"side" text NOT NULL,
	"points" integer NOT NULL,
	"epoch" integer NOT NULL,
	"payout_points" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "predict_markets" (
	"id" text PRIMARY KEY NOT NULL,
	"epoch" integer NOT NULL,
	"kind" text NOT NULL,
	"threshold" bigint NOT NULL,
	"question" text NOT NULL,
	"label" text NOT NULL,
	"status" text NOT NULL,
	"outcome" text,
	"resolved_value" bigint,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "telegram_links" (
	"code" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "validator_epoch_stats" (
	"vote" text NOT NULL,
	"epoch" integer NOT NULL,
	"commission_bps" integer,
	"mev_commission_bps" integer,
	"active_stake_lamports" bigint,
	"credits" bigint,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "validator_epoch_stats_vote_epoch_pk" PRIMARY KEY("vote","epoch")
);
--> statement-breakpoint
CREATE TABLE "watchlists" (
	"address" text PRIMARY KEY NOT NULL,
	"votes" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "indexer_cursors" ADD COLUMN "signature" text;--> statement-breakpoint
ALTER TABLE "program_events" ADD COLUMN "block_time" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "program_events" ADD COLUMN "epoch" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_deliveries_dedupe_idx" ON "alert_deliveries" USING btree ("address","dedupe_key","channel");--> statement-breakpoint
CREATE INDEX "auth_nonces_expires_idx" ON "auth_nonces" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "predict_calls_market_idx" ON "predict_calls" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "predict_calls_address_epoch_idx" ON "predict_calls" USING btree ("address","epoch");--> statement-breakpoint
CREATE INDEX "predict_markets_epoch_idx" ON "predict_markets" USING btree ("epoch");--> statement-breakpoint
CREATE INDEX "sessions_address_idx" ON "sessions" USING btree ("address");--> statement-breakpoint
CREATE INDEX "validator_epoch_stats_epoch_idx" ON "validator_epoch_stats" USING btree ("epoch");--> statement-breakpoint
CREATE INDEX "program_events_kind_slot_idx" ON "program_events" USING btree ("kind","slot");