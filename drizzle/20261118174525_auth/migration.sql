CREATE TABLE `devices` (
	`id` binary(16) PRIMARY KEY,
	`user_id` binary(16) NOT NULL,
	`platform` enum('IOS','ANDROID','WEB') NOT NULL,
	`name` varchar(100),
	`last_used_at` datetime(3) NOT NULL,
	`revoked_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3))
);
--> statement-breakpoint
CREATE TABLE `refresh_tokens` (
	`id` binary(16) PRIMARY KEY,
	`device_id` binary(16) NOT NULL,
	`token_hash` char(64) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`used_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `token_hash_unique` UNIQUE INDEX(`token_hash`)
);
--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `datagsm_id` varchar(64);--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `status` enum('ACTIVE','SUSPENDED','INACTIVE','WITHDRAWN') DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `email` varchar(320);--> statement-breakpoint
ALTER TABLE `users` ADD `student_number` varchar(10);--> statement-breakpoint
ALTER TABLE `users` ADD `grade` tinyint;--> statement-breakpoint
ALTER TABLE `users` ADD `class_no` tinyint;--> statement-breakpoint
ALTER TABLE `users` ADD `number` tinyint;--> statement-breakpoint
ALTER TABLE `users` ADD `avatar_id` varchar(32) DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `ranking_public` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `ranking_onboarded` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `total_xp` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `suspended_until` datetime(3);--> statement-breakpoint
ALTER TABLE `users` ADD `suspend_reason` varchar(200);--> statement-breakpoint
ALTER TABLE `users` ADD `last_login_at` datetime(3);--> statement-breakpoint
ALTER TABLE `users` ADD `withdrawn_at` datetime(3);--> statement-breakpoint
CREATE INDEX `devices_user_idx` ON `devices` (`user_id`);--> statement-breakpoint
CREATE INDEX `refresh_tokens_device_idx` ON `refresh_tokens` (`device_id`);--> statement-breakpoint
CREATE INDEX `users_class_idx` ON `users` (`grade`,`class_no`,`number`);--> statement-breakpoint
CREATE INDEX `users_status_idx` ON `users` (`status`);--> statement-breakpoint
CREATE INDEX `users_name_idx` ON `users` (`name`);--> statement-breakpoint
ALTER TABLE `devices` ADD CONSTRAINT `devices_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `refresh_tokens` ADD CONSTRAINT `refresh_tokens_device_id_devices_id_fkey` FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `deleted_at`;