ALTER TABLE `machines` ADD `daemon_state` text;
--> statement-breakpoint
ALTER TABLE `machines` ADD `daemon_enabled` integer DEFAULT false;
