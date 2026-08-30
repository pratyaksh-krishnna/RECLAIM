CREATE TABLE "voice_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"communication_id" uuid NOT NULL,
	"mime_type" text NOT NULL,
	"audio" "bytea" NOT NULL,
	"duration_ms" integer,
	"sarvam_request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voice_messages_communication_id_unique" UNIQUE("communication_id")
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "whatsapp_consent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "voice_messages" ADD CONSTRAINT "voice_messages_communication_id_communications_id_fk" FOREIGN KEY ("communication_id") REFERENCES "public"."communications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_phone_unique" UNIQUE("phone");