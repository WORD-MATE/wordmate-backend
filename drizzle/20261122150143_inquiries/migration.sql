CREATE TABLE `inquiries` (
	`id` binary(16) PRIMARY KEY,
	`user_id` binary(16) NOT NULL,
	`type` enum('ACCOUNT','STUDY','BATTLE_RANKING','BUG','OTHER') NOT NULL,
	`title` varchar(50) NOT NULL,
	`content` varchar(1000) NOT NULL,
	`status` enum('RECEIVED','ANSWERED') NOT NULL DEFAULT 'RECEIVED',
	`platform` enum('IOS','ANDROID','WEB') NOT NULL,
	`app_version` varchar(32) NOT NULL,
	`answer_content` varchar(2000),
	`answered_by` binary(16),
	`answered_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3))
);
--> statement-breakpoint
CREATE TABLE `inquiry_images` (
	`id` binary(16) PRIMARY KEY,
	`inquiry_id` binary(16) NOT NULL,
	`storage_key` varchar(255) NOT NULL,
	`mime` varchar(32) NOT NULL,
	`size` int NOT NULL,
	`sort_order` tinyint NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3))
);
--> statement-breakpoint
CREATE INDEX `inquiries_user_idx` ON `inquiries` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `inquiries_status_idx` ON `inquiries` (`status`,`type`,`id`);--> statement-breakpoint
CREATE INDEX `inquiry_images_inquiry_idx` ON `inquiry_images` (`inquiry_id`,`sort_order`);--> statement-breakpoint
ALTER TABLE `inquiries` ADD CONSTRAINT `inquiries_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `inquiries` ADD CONSTRAINT `inquiries_answered_by_users_id_fkey` FOREIGN KEY (`answered_by`) REFERENCES `users`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `inquiry_images` ADD CONSTRAINT `inquiry_images_inquiry_id_inquiries_id_fkey` FOREIGN KEY (`inquiry_id`) REFERENCES `inquiries`(`id`) ON DELETE CASCADE;