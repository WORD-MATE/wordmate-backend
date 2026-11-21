CREATE TABLE `battle_room_participants` (
	`room_id` binary(16) NOT NULL,
	`user_id` binary(16) NOT NULL,
	`state` enum('CONNECTED','DISCONNECTED','LEFT','KICKED') NOT NULL DEFAULT 'CONNECTED',
	`is_host` boolean NOT NULL DEFAULT false,
	`active` boolean NOT NULL DEFAULT true,
	`joined_at` datetime(3) NOT NULL,
	`left_at` datetime(3),
	`active_user` binary(16) GENERATED ALWAYS AS (IF(active, user_id, NULL)) STORED,
	CONSTRAINT PRIMARY KEY(`room_id`,`user_id`),
	CONSTRAINT `battle_room_participants_active_user_uq` UNIQUE INDEX(`active_user`)
);
--> statement-breakpoint
CREATE TABLE `battle_rooms` (
	`id` binary(16) PRIMARY KEY,
	`invite_code` char(6) NOT NULL,
	`type` enum('NORMAL','CLASS','QUICK_MATCH') NOT NULL,
	`status` enum('WAITING','COUNTDOWN','IN_PROGRESS','FINISHED','EXPIRED') NOT NULL DEFAULT 'WAITING',
	`host_user_id` binary(16),
	`class_id` binary(16),
	`pack_id` binary(16) NOT NULL,
	`pack_name` varchar(30) NOT NULL,
	`question_type` enum('EN_TO_KO_CHOICE','KO_TO_EN_CHOICE','EN_TO_KO_TYPING','KO_TO_EN_TYPING') NOT NULL,
	`question_count` int NOT NULL,
	`time_limit_sec` int NOT NULL,
	`max_participants` int NOT NULL,
	`duplicate_questions` boolean NOT NULL,
	`source_battle_id` binary(16),
	`expires_at` datetime(3) NOT NULL,
	`started_at` datetime(3),
	`finished_at` datetime(3),
	`active_code` char(6) GENERATED ALWAYS AS (IF(status IN ('WAITING', 'COUNTDOWN', 'IN_PROGRESS'), invite_code, NULL)) STORED,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `battle_rooms_active_code_uq` UNIQUE INDEX(`active_code`)
);
--> statement-breakpoint
CREATE INDEX `battle_rooms_code_idx` ON `battle_rooms` (`invite_code`,`created_at`);--> statement-breakpoint
CREATE INDEX `battle_rooms_expiry_idx` ON `battle_rooms` (`status`,`expires_at`);--> statement-breakpoint
ALTER TABLE `battle_room_participants` ADD CONSTRAINT `battle_room_participants_room_id_battle_rooms_id_fkey` FOREIGN KEY (`room_id`) REFERENCES `battle_rooms`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `battle_room_participants` ADD CONSTRAINT `battle_room_participants_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `battle_rooms` ADD CONSTRAINT `battle_rooms_host_user_id_users_id_fkey` FOREIGN KEY (`host_user_id`) REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `battle_rooms` ADD CONSTRAINT `battle_rooms_class_id_classes_id_fkey` FOREIGN KEY (`class_id`) REFERENCES `classes`(`id`);--> statement-breakpoint
ALTER TABLE `battle_rooms` ADD CONSTRAINT `battle_rooms_pack_id_packs_id_fkey` FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`);