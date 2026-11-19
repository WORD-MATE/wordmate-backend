CREATE TABLE `pack_copies` (
	`user_id` binary(16) NOT NULL,
	`source_pack_id` binary(16) NOT NULL,
	`copied_pack_id` binary(16) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT PRIMARY KEY(`user_id`,`source_pack_id`),
	CONSTRAINT `pack_copies_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `pack_copies_source_pack_id_packs_id_fkey` FOREIGN KEY (`source_pack_id`) REFERENCES `packs`(`id`) ON DELETE CASCADE,
	CONSTRAINT `pack_copies_copied_pack_id_packs_id_fkey` FOREIGN KEY (`copied_pack_id`) REFERENCES `packs`(`id`) ON DELETE CASCADE
);
