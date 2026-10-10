CREATE TABLE `conversation` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`state` text NOT NULL,
	`consumer_id` text,
	`lease_hash` text,
	`lease_cipher` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`wake_attempts` integer DEFAULT 0 NOT NULL,
	`wake_deadline` integer DEFAULT 0 NOT NULL,
	`last_activity` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gateway` (
	`id` text PRIMARY KEY NOT NULL,
	`gateway_id` text NOT NULL,
	`lease_hash` text NOT NULL,
	`lease_until` integer NOT NULL,
	`cursor` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`purpose` text NOT NULL,
	`session_id` text,
	`subscription_id` text,
	`payload_cipher` text NOT NULL,
	`message_ids` text,
	`state` text DEFAULT 'ready' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`available_at` integer NOT NULL,
	`claim_hash` text,
	`claim_until` integer DEFAULT 0 NOT NULL,
	`gateway_id` text,
	`http_status` integer,
	`error_code` text,
	`response_challenge` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_id_unique` ON `jobs` (`id`);--> statement-breakpoint
CREATE INDEX `jobs_ready_sequence` ON `jobs` (`state`,`available_at`,`sequence`);--> statement-breakpoint
CREATE TABLE `messages` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`upstream_id` text NOT NULL,
	`sender` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`text` text NOT NULL,
	`kind` text NOT NULL,
	`context_cipher` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reply_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_upstream_id_unique` ON `messages` (`upstream_id`);--> statement-breakpoint
CREATE INDEX `messages_status_sequence` ON `messages` (`status`,`sequence`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`url_cipher` text NOT NULL,
	`secret_cipher` text NOT NULL,
	`secret_hash` text NOT NULL,
	`old_secret_cipher` text,
	`rotation_until` integer DEFAULT 0 NOT NULL,
	`expires_at` integer,
	`state` text NOT NULL,
	`verified_until` integer DEFAULT 0 NOT NULL,
	`verification_job` text
);
