CREATE TABLE `throttle_accounts` (
	`account` text PRIMARY KEY NOT NULL,
	`lock_until` integer NOT NULL,
	`lock_count` integer NOT NULL,
	`fails` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `throttle_ips` (
	`ip` text PRIMARY KEY NOT NULL,
	`attempts` text NOT NULL,
	`updated_at` integer NOT NULL
);
