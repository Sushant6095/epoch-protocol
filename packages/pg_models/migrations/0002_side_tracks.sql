CREATE TABLE "epoch_stakes" (
	"epoch" integer NOT NULL,
	"identity" text NOT NULL,
	"stake_lamports" bigint NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "epoch_stakes_epoch_identity_pk" PRIMARY KEY("epoch","identity")
);
--> statement-breakpoint
CREATE TABLE "fee_index_live" (
	"epoch" integer PRIMARY KEY NOT NULL,
	"estimate" bigint,
	"leaders" integer NOT NULL,
	"slots_with_fees" integer NOT NULL,
	"priced_txs" bigint NOT NULL,
	"first_slot" bigint,
	"processed_slot" bigint,
	"watermark_slot" bigint,
	"tip_slot" bigint,
	"stake_epoch" integer,
	"source" text NOT NULL,
	"endpoint" text,
	"status" text NOT NULL,
	"stride" integer DEFAULT 1 NOT NULL,
	"last_slot_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "launch_fee_events" (
	"signature" text NOT NULL,
	"ix" integer NOT NULL,
	"mint" text NOT NULL,
	"pool" text NOT NULL,
	"kind" text NOT NULL,
	"owner" text,
	"slot" bigint NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"sol_lamports" bigint NOT NULL,
	"token_amount" numeric(20, 0) NOT NULL,
	CONSTRAINT "launch_fee_events_signature_ix_pk" PRIMARY KEY("signature","ix")
);
--> statement-breakpoint
CREATE TABLE "launch_trades" (
	"signature" text NOT NULL,
	"ix" integer NOT NULL,
	"mint" text NOT NULL,
	"pool" text NOT NULL,
	"venue" text NOT NULL,
	"side" text NOT NULL,
	"trader" text,
	"slot" bigint NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"sol_lamports" bigint NOT NULL,
	"token_amount" numeric(20, 0) NOT NULL,
	"fee_amount" numeric(20, 0) NOT NULL,
	"fee_in_token" boolean NOT NULL,
	"price_sol" double precision NOT NULL,
	"post_price_sol" double precision NOT NULL,
	"quote_reserve_lamports" bigint,
	CONSTRAINT "launch_trades_signature_ix_pk" PRIMARY KEY("signature","ix")
);
--> statement-breakpoint
CREATE TABLE "live_slots" (
	"slot" bigint PRIMARY KEY NOT NULL,
	"epoch" integer NOT NULL,
	"leader" text NOT NULL,
	"block_time" timestamp with time zone,
	"median_cu_price" bigint,
	"p25_cu_price" bigint,
	"p75_cu_price" bigint,
	"p90_cu_price" bigint,
	"priced_txs" integer NOT NULL,
	"unpriced_txs" integer NOT NULL,
	"leader_paid_txs" integer NOT NULL,
	"failed_txs" integer NOT NULL,
	"source" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "panta_markets" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"epoch" integer NOT NULL,
	"threshold" bigint NOT NULL,
	"question" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"resolution_rule" text NOT NULL,
	"sources_of_truth" jsonb NOT NULL,
	"image_url" text,
	"status" text NOT NULL,
	"start_time" timestamp with time zone,
	"end_time" timestamp with time zone,
	"resolution_time" timestamp with time zone,
	"create_id" text,
	"create_expires_at" timestamp with time zone,
	"expected_event_pda" text,
	"market_id" text,
	"create_signature" text,
	"signed_tx" text,
	"last_valid_block_height" bigint,
	"quoted_usdc_base" bigint,
	"liquidity_usdc_base" bigint,
	"platform_usdc_base" bigint,
	"paid_usdc_base" bigint,
	"creator_fees_claimed_usdc_base" bigint DEFAULT 0 NOT NULL,
	"last_creator_fee_signature" text,
	"creator_fees_checked_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"signed_at" timestamp with time zone,
	"registered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "panta_trades" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"wallet" text NOT NULL,
	"market_id" text NOT NULL,
	"side" text,
	"amount_usdc" text,
	"amount_usdc_base" bigint,
	"fee_usdc" text,
	"expected_shares" text,
	"quote_id" text,
	"order_id" text,
	"message_hash" text NOT NULL,
	"last_valid_block_height" bigint,
	"signature" text,
	"status" text NOT NULL,
	"report_status" text DEFAULT 'pending' NOT NULL,
	"report_error" text,
	"report_attempts" integer DEFAULT 0 NOT NULL,
	"summary" text NOT NULL,
	"consent_at" timestamp with time zone NOT NULL,
	"session_address" text,
	"country" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"reported_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "launch_fee_events_mint_time_idx" ON "launch_fee_events" USING btree ("mint","block_time");--> statement-breakpoint
CREATE INDEX "launch_trades_mint_time_idx" ON "launch_trades" USING btree ("mint","block_time");--> statement-breakpoint
CREATE INDEX "launch_trades_mint_slot_idx" ON "launch_trades" USING btree ("mint","slot");--> statement-breakpoint
CREATE INDEX "live_slots_epoch_idx" ON "live_slots" USING btree ("epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "panta_markets_epoch_threshold_idx" ON "panta_markets" USING btree ("epoch","threshold");--> statement-breakpoint
CREATE UNIQUE INDEX "panta_markets_market_id_idx" ON "panta_markets" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "panta_markets_status_idx" ON "panta_markets" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "panta_trades_signature_idx" ON "panta_trades" USING btree ("signature");--> statement-breakpoint
CREATE INDEX "panta_trades_wallet_idx" ON "panta_trades" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "panta_trades_status_idx" ON "panta_trades" USING btree ("status","report_status");--> statement-breakpoint
CREATE INDEX "panta_trades_market_idx" ON "panta_trades" USING btree ("market_id");