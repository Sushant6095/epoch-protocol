CREATE TABLE "epoch_index" (
	"epoch" integer PRIMARY KEY NOT NULL,
	"value" bigint NOT NULL,
	"posted_signature" text,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indexer_cursors" (
	"name" text PRIMARY KEY NOT NULL,
	"slot" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "program_events" (
	"signature" text NOT NULL,
	"ix" integer NOT NULL,
	"slot" bigint NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "program_events_signature_ix_pk" PRIMARY KEY("signature","ix")
);
--> statement-breakpoint
CREATE TABLE "slot_fees" (
	"slot" bigint PRIMARY KEY NOT NULL,
	"epoch" integer NOT NULL,
	"leader" text NOT NULL,
	"median_cu_price" bigint NOT NULL,
	"tx_count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "validator_epochs" (
	"vote" text NOT NULL,
	"epoch" integer NOT NULL,
	"revenue_lamports" bigint NOT NULL,
	"credits" bigint NOT NULL,
	"commission_bps" integer NOT NULL,
	CONSTRAINT "validator_epochs_vote_epoch_pk" PRIMARY KEY("vote","epoch")
);
--> statement-breakpoint
CREATE TABLE "validators" (
	"vote" text PRIMARY KEY NOT NULL,
	"identity" text NOT NULL,
	"name" text,
	"onboarded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "program_events_slot_idx" ON "program_events" USING btree ("slot");--> statement-breakpoint
CREATE INDEX "slot_fees_epoch_idx" ON "slot_fees" USING btree ("epoch");