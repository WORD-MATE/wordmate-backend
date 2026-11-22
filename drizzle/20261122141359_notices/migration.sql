CREATE TABLE `notice_reads` (
	`user_id` binary(16) NOT NULL,
	`notice_id` binary(16) NOT NULL,
	`read_at` datetime(3) NOT NULL,
	CONSTRAINT PRIMARY KEY(`user_id`,`notice_id`)
);
--> statement-breakpoint
CREATE TABLE `notices` (
	`id` binary(16) PRIMARY KEY,
	`title` varchar(100) NOT NULL,
	`content` mediumtext NOT NULL,
	`pinned` boolean NOT NULL DEFAULT false,
	`published` boolean NOT NULL DEFAULT true,
	`created_by` binary(16),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`deleted_at` datetime(3)
);
--> statement-breakpoint
CREATE INDEX `notices_list_idx` ON `notices` (`published`,`deleted_at`,`pinned`,`id`);--> statement-breakpoint
ALTER TABLE `notice_reads` ADD CONSTRAINT `notice_reads_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `notice_reads` ADD CONSTRAINT `notice_reads_notice_id_notices_id_fkey` FOREIGN KEY (`notice_id`) REFERENCES `notices`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `notices` ADD CONSTRAINT `notices_created_by_users_id_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL;