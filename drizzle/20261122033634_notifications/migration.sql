CREATE TABLE `notification_settings` (
	`user_id` binary(16) PRIMARY KEY,
	`study_reminder` boolean NOT NULL,
	`morning_sentence` boolean NOT NULL,
	`battle` boolean NOT NULL,
	`ranking` boolean NOT NULL,
	`notice` boolean NOT NULL,
	`marketing` boolean NOT NULL,
	`reminder_time` char(5),
	`reminder_weekdays` json NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3))
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` binary(16) PRIMARY KEY,
	`user_id` binary(16) NOT NULL,
	`type` enum('BATTLE_INVITE','BATTLE_RESULT','RANK_DROP','RANK_WEEKLY_RESULT','STUDY_REMINDER','MORNING_SENTENCE','NOTICE','MARKETING','INQUIRY_ANSWERED','FRIEND_REQUEST','FRIEND_ACCEPTED','BADGE_EARNED','SANCTION','REPORT_RESULT','NEW_DEVICE_LOGIN','ADMIN_ALERT') NOT NULL,
	`title` varchar(100) NOT NULL,
	`body` varchar(500) NOT NULL,
	`route` varchar(200),
	`read_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3))
);
--> statement-breakpoint
CREATE INDEX `notifications_user_id_idx` ON `notifications` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `notifications_user_read_idx` ON `notifications` (`user_id`,`read_at`);--> statement-breakpoint
CREATE INDEX `notifications_created_idx` ON `notifications` (`created_at`);--> statement-breakpoint
ALTER TABLE `notification_settings` ADD CONSTRAINT `notification_settings_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE;