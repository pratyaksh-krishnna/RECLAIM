ALTER TABLE "recovery_cases" ADD COLUMN "disputed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recovery_cases" ADD COLUMN "dispute_resolved_by_user_id" uuid;