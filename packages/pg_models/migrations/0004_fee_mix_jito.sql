CREATE TABLE "epoch_fee_mix" (
	"epoch" integer PRIMARY KEY NOT NULL,
	"blocks" integer NOT NULL,
	"base_fee_lamports" bigint NOT NULL,
	"priority_fee_lamports" bigint NOT NULL,
	"tip_lamports" bigint NOT NULL,
	"tip_txs" bigint NOT NULL,
	"vote_txs" bigint NOT NULL,
	"non_vote_txs" bigint NOT NULL,
	"fee_reward_lamports" bigint NOT NULL,
	"estimated_blocks" integer NOT NULL,
	"first_slot" bigint NOT NULL,
	"last_slot" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slot_fee_mix" (
	"slot" bigint PRIMARY KEY NOT NULL,
	"epoch" integer NOT NULL,
	"base_fee_lamports" bigint NOT NULL,
	"priority_fee_lamports" bigint NOT NULL,
	"tip_lamports" bigint NOT NULL,
	"tip_txs" integer NOT NULL,
	"vote_txs" integer NOT NULL,
	"non_vote_txs" integer NOT NULL,
	"fee_reward_lamports" bigint,
	"base_fee_basis" text NOT NULL,
	"source" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "validator_mev_epochs" (
	"vote" text NOT NULL,
	"epoch" integer NOT NULL,
	"tda" text,
	"mev_commission_bps" integer,
	"tips_lamports" bigint,
	"tda_lamports" bigint,
	"root_uploaded" boolean,
	"total_funds_claimed_lamports" bigint,
	"nodes_claimed" integer,
	"max_nodes" integer,
	"validator_share_lamports" bigint,
	"validator_share_estimated" boolean,
	"validator_claim" text,
	"validator_claimed_slot" bigint,
	"expires_at" integer,
	"upload_authority" text,
	"pfda" text,
	"pf_commission_bps" integer,
	"pf_transferred_lamports" bigint,
	"pf_total_claim_lamports" bigint,
	"pf_root_uploaded" boolean,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "validator_mev_epochs_vote_epoch_pk" PRIMARY KEY("vote","epoch")
);
--> statement-breakpoint
CREATE INDEX "slot_fee_mix_epoch_idx" ON "slot_fee_mix" USING btree ("epoch");--> statement-breakpoint
CREATE INDEX "validator_mev_epochs_epoch_idx" ON "validator_mev_epochs" USING btree ("epoch");