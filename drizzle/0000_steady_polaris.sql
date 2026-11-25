CREATE TABLE "admin_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"password_salt" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_accounts_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "auction_events" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"event_type" text NOT NULL,
	"actor_id" text,
	"franchise_id" text,
	"player_id" text,
	"request_id" text,
	"event_payload_json" jsonb NOT NULL,
	"state_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auction_rooms" (
	"id" text PRIMARY KEY NOT NULL,
	"room_code" text NOT NULL,
	"host_user_id" text,
	"host_session_id" text NOT NULL,
	"status" text DEFAULT 'LOBBY' NOT NULL,
	"game_mode" text DEFAULT 'MULTIPLAYER' NOT NULL,
	"ruleset_id" text NOT NULL,
	"auction_state_json" jsonb NOT NULL,
	"state_version" integer DEFAULT 1 NOT NULL,
	"going_once_sent" boolean DEFAULT false NOT NULL,
	"going_twice_sent" boolean DEFAULT false NOT NULL,
	"last_ai_bid_at" bigint DEFAULT 0 NOT NULL,
	"lot_transition_at" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auction_rooms_room_code_unique" UNIQUE("room_code")
);
--> statement-breakpoint
CREATE TABLE "custom_players" (
	"id" text PRIMARY KEY NOT NULL,
	"player_json" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guest_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"guest_identifier" text NOT NULL,
	"username" text NOT NULL,
	"favorite_franchise" text DEFAULT 'CSK' NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "guest_sessions_guest_identifier_unique" UNIQUE("guest_identifier"),
	CONSTRAINT "guest_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"bucket_key" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"request_count" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_participants" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"user_id" text,
	"session_id" text NOT NULL,
	"username" text NOT NULL,
	"franchise_id" text NOT NULL,
	"is_host" boolean DEFAULT false NOT NULL,
	"is_connected" boolean DEFAULT true NOT NULL,
	"is_ready" boolean DEFAULT false NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scheduler_leases" (
	"lease_key" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"guest_session_id" text,
	"token_hash" text NOT NULL,
	"session_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"device_info" text,
	CONSTRAINT "user_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"firebase_uid" text,
	"username" text NOT NULL,
	"normalized_email" text NOT NULL,
	"password_hash" text,
	"password_salt" text,
	"favorite_franchise" text DEFAULT 'CSK' NOT NULL,
	"avatar_color" text DEFAULT '#F59E0B' NOT NULL,
	"stats_json" jsonb DEFAULT '{"auctionsPlayed":0,"auctionsWon":0,"bestRating":0,"avgRating":0,"tournamentsWon":0}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "users_firebase_uid_unique" UNIQUE("firebase_uid"),
	CONSTRAINT "users_normalized_email_unique" UNIQUE("normalized_email")
);
--> statement-breakpoint
ALTER TABLE "auction_events" ADD CONSTRAINT "auction_events_room_id_auction_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."auction_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_rooms" ADD CONSTRAINT "auction_rooms_host_user_id_users_id_fk" FOREIGN KEY ("host_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_participants" ADD CONSTRAINT "room_participants_room_id_auction_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."auction_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_participants" ADD CONSTRAINT "room_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_guest_session_id_guest_sessions_id_fk" FOREIGN KEY ("guest_session_id") REFERENCES "public"."guest_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_admin_accounts_username" ON "admin_accounts" USING btree ("username");--> statement-breakpoint
CREATE INDEX "idx_auction_events_room_version" ON "auction_events" USING btree ("room_id","state_version");--> statement-breakpoint
CREATE INDEX "idx_auction_events_room_created" ON "auction_events" USING btree ("room_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_auction_events_room_request" ON "auction_events" USING btree ("room_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_auction_rooms_room_code" ON "auction_rooms" USING btree ("room_code");--> statement-breakpoint
CREATE INDEX "idx_auction_rooms_status" ON "auction_rooms" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_auction_rooms_expires_at" ON "auction_rooms" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_custom_players_updated_at" ON "custom_players" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_guest_sessions_token_hash" ON "guest_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_guest_sessions_expires_at" ON "guest_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_rate_limit_buckets_expires_at" ON "rate_limit_buckets" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_room_participants_room_session" ON "room_participants" USING btree ("room_id","session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_room_participants_room_franchise" ON "room_participants" USING btree ("room_id","franchise_id");--> statement-breakpoint
CREATE INDEX "idx_room_participants_room_id" ON "room_participants" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "idx_room_participants_session_id" ON "room_participants" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_sessions_token_hash" ON "user_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_user_sessions_user_id" ON "user_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_sessions_expires_at" ON "user_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_normalized_email" ON "users" USING btree ("normalized_email");--> statement-breakpoint
CREATE INDEX "idx_users_firebase_uid" ON "users" USING btree ("firebase_uid");