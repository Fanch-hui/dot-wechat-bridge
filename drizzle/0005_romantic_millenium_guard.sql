CREATE TABLE `binding_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`participant_id` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`qr_cipher` text,
	`verification_cipher` text,
	`error_code` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bindings_participant_state` ON `binding_requests` (`participant_id`,`state`);--> statement-breakpoint
CREATE TABLE `participants` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`sender` text,
	`bot_id` text,
	`binding_id` text,
	`cursor` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'unbound' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `participants_sender_unique` ON `participants` (`sender`);--> statement-breakpoint
DROP INDEX `messages_upstream_id_unique`;--> statement-breakpoint
ALTER TABLE `messages` ADD `participant_id` text DEFAULT 'personal' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `messages_participant_upstream` ON `messages` (`participant_id`,`upstream_id`);--> statement-breakpoint
CREATE INDEX `messages_participant_status_sequence` ON `messages` (`participant_id`,`status`,`sequence`);--> statement-breakpoint
ALTER TABLE `attachments` ADD `participant_id` text DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway` ADD `protocol_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `participant_id` text DEFAULT 'personal';--> statement-breakpoint
CREATE INDEX `jobs_participant_sequence` ON `jobs` (`participant_id`,`kind`,`sequence`);--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `conversation` text DEFAULT 'personal' NOT NULL;
