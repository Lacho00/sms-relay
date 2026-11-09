CREATE TABLE `deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer NOT NULL,
	`destination` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`locked_until` integer,
	`last_error` text,
	`last_status_code` integer,
	`delivered_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `deliveries_status_next_attempt_idx` ON `deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `deliveries_message_destination_unique` ON `deliveries` (`message_id`,`destination`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dedup_key` text NOT NULL,
	`sender` text NOT NULL,
	`body` text NOT NULL,
	`received_at` integer NOT NULL,
	`sim` integer,
	`device` text,
	`created_at` integer NOT NULL,
	`ingest_nonce` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_dedup_key_unique` ON `messages` (`dedup_key`);--> statement-breakpoint
CREATE INDEX `messages_created_at_idx` ON `messages` (`created_at`);