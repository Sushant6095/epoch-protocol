CREATE TABLE "solami_usage" (
	"component" text PRIMARY KEY NOT NULL,
	"report" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
