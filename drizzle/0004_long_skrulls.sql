CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`upstream_id` text NOT NULL,
	`item_index` integer NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `attachments_upstream` ON `attachments` (`upstream_id`,`item_index`);--> statement-breakpoint
ALTER TABLE `messages` ADD `attachments_json` text DEFAULT '[]' NOT NULL;