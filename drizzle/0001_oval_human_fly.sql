ALTER TABLE `deliveries` ADD `alerted_at` integer;--> statement-breakpoint
ALTER TABLE `deliveries` ADD `parts_sent` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `deliveries_status_alerted_idx` ON `deliveries` (`status`,`alerted_at`);
--> statement-breakpoint
UPDATE deliveries SET alerted_at = updated_at WHERE status = 'failed';
