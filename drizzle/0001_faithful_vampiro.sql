CREATE TABLE `wm_account_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `wm_account_sessions_expiry` ON `wm_account_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `wm_accounts` (
	`user_id` text PRIMARY KEY NOT NULL,
	`login_id` text NOT NULL,
	`password_hash` text NOT NULL,
	`salt` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wm_accounts_login_id_unique` ON `wm_accounts` (`login_id`);