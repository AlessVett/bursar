CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer NOT NULL,
	`provider_account_uid` text,
	`identification_hash` text NOT NULL,
	`iban` text,
	`masked_identifier` text,
	`last4` text,
	`product` text,
	`details` text,
	`nickname` text,
	`currency` text NOT NULL,
	`cash_account_type` text,
	`status` text DEFAULT 'active' NOT NULL,
	`last_synced_at` integer,
	`last_sync_error_code` text,
	`last_sync_error_at` integer,
	`rate_limited_until` integer,
	`bg_fetch_day` text,
	`bg_fetch_count` integer DEFAULT 0 NOT NULL,
	`last_scheduled_sync_day` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`removed_at` integer,
	FOREIGN KEY (`connection_id`) REFERENCES `bank_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `accounts_connection_idx` ON `accounts` (`connection_id`);--> statement-breakpoint
CREATE INDEX `accounts_identification_idx` ON `accounts` (`identification_hash`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target` text,
	`details` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_log_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE TABLE `backup_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`set_id` text,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`target` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`size_bytes` integer,
	`error_message` text
);
--> statement-breakpoint
CREATE TABLE `balances` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`balance_type` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`reference_date` text NOT NULL,
	`as_of` integer NOT NULL,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `balances_account_type_day_uq` ON `balances` (`account_id`,`balance_type`,`reference_date`);--> statement-breakpoint
CREATE TABLE `bank_auth_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`state_hash` text NOT NULL,
	`purpose` text NOT NULL,
	`connection_id` integer,
	`aspsp_name` text NOT NULL,
	`aspsp_country` text NOT NULL,
	`valid_until` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	FOREIGN KEY (`connection_id`) REFERENCES `bank_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bank_auth_requests_state_hash_unique` ON `bank_auth_requests` (`state_hash`);--> statement-breakpoint
CREATE TABLE `bank_connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`aspsp_name` text NOT NULL,
	`aspsp_country` text NOT NULL,
	`aspsp_logo_url` text,
	`psu_type` text DEFAULT 'personal' NOT NULL,
	`provider_session_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`valid_until` integer NOT NULL,
	`last_error_code` text,
	`last_error_message` text,
	`last_error_at` integer,
	`status_checked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`renewed_at` integer,
	`removed_at` integer
);
--> statement-breakpoint
CREATE INDEX `bank_connections_status_idx` ON `bank_connections` (`status`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`params` text NOT NULL,
	`link` text,
	`created_at` integer NOT NULL,
	`read_at` integer,
	`email_status` text NOT NULL,
	`email_sent_at` integer,
	`email_error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_dedupe_key_unique` ON `notifications` (`dedupe_key`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`skip_reason` text,
	`with_psu_headers` integer DEFAULT false NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`fetched` integer DEFAULT 0 NOT NULL,
	`inserted` integer DEFAULT 0 NOT NULL,
	`updated` integer DEFAULT 0 NOT NULL,
	`removed` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`error_message` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sync_runs_account_idx` ON `sync_runs` (`account_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`provider_reference` text,
	`fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`booking_date` text,
	`value_date` text,
	`transaction_date` text,
	`sort_date` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`counterparty` text,
	`counterparty_account` text,
	`remittance` text,
	`bank_code` text,
	`merchant_category_code` text,
	`balance_after_minor` integer,
	`search_text` text NOT NULL,
	`raw_json` text NOT NULL,
	`missing_count` integer DEFAULT 0 NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_account_fingerprint_uq` ON `transactions` (`account_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `transactions_account_reference_idx` ON `transactions` (`account_id`,`provider_reference`);--> statement-breakpoint
CREATE INDEX `transactions_account_date_idx` ON `transactions` (`account_id`,`sort_date`);--> statement-breakpoint
CREATE INDEX `transactions_date_idx` ON `transactions` (`sort_date`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `dedupe_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_dedupe_active_uq` ON `jobs` (`dedupe_key`) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');