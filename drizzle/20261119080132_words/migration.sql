CREATE TABLE `words` (
	`id` binary(16) PRIMARY KEY,
	`pack_id` binary(16) NOT NULL,
	`english` varchar(50) NOT NULL,
	`english_norm` varchar(50) COLLATE utf8mb4_bin NOT NULL,
	`meanings` json NOT NULL,
	`example` varchar(300),
	`derivatives` json NOT NULL,
	`active_english_key` varchar(100) COLLATE utf8mb4_bin GENERATED ALWAYS AS (IF(deleted_at IS NULL, CONCAT(HEX(pack_id), ':', english_norm), NULL)) STORED,
	`deleted_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `words_active_english_uq` UNIQUE INDEX(`active_english_key`),
	CONSTRAINT `words_pack_id_packs_id_fkey` FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`)
);
--> statement-breakpoint
CREATE INDEX `words_pack_idx` ON `words` (`pack_id`,`deleted_at`,`id`);