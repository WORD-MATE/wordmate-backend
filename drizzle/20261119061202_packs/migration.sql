CREATE TABLE `forbidden_words` (
	`id` binary(16) PRIMARY KEY,
	`word` varchar(50) NOT NULL,
	`type` enum('FORBIDDEN','ALLOWED') NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `forbidden_words_word_type_uq` UNIQUE INDEX(`word`,`type`)
);
--> statement-breakpoint
CREATE TABLE `pack_categories` (
	`id` binary(16) PRIMARY KEY,
	`name` varchar(30) NOT NULL,
	`sort_order` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3))
);
--> statement-breakpoint
CREATE TABLE `packs` (
	`id` binary(16) PRIMARY KEY,
	`type` enum('DEFAULT','MINE') NOT NULL,
	`owner_user_id` binary(16),
	`name` varchar(30) NOT NULL,
	`description` varchar(200),
	`category_id` binary(16),
	`sort_order` int NOT NULL DEFAULT 0,
	`word_count` int NOT NULL DEFAULT 0,
	`copied_from_pack_id` binary(16),
	`share_code` char(12),
	`shared_at` datetime(3),
	`active_name_key` varchar(64) GENERATED ALWAYS AS (IF(deleted_at IS NULL AND type = 'MINE', CONCAT(HEX(owner_user_id), ':', name), NULL)) STORED,
	`deleted_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `share_code_unique` UNIQUE INDEX(`share_code`),
	CONSTRAINT `packs_active_name_uq` UNIQUE INDEX(`active_name_key`)
);
--> statement-breakpoint
CREATE INDEX `packs_type_category_idx` ON `packs` (`type`,`category_id`);--> statement-breakpoint
CREATE INDEX `packs_owner_idx` ON `packs` (`owner_user_id`,`deleted_at`,`updated_at`);--> statement-breakpoint
ALTER TABLE `packs` ADD CONSTRAINT `packs_owner_user_id_users_id_fkey` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `packs` ADD CONSTRAINT `packs_category_id_pack_categories_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `pack_categories`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `packs` ADD CONSTRAINT `packs_copied_from_pack_id_packs_id_fkey` FOREIGN KEY (`copied_from_pack_id`) REFERENCES `packs`(`id`) ON DELETE SET NULL;