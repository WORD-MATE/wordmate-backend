CREATE TABLE `battle_answers` (
	`battle_id` binary(16) NOT NULL,
	`idx` int NOT NULL,
	`user_id` binary(16) NOT NULL,
	`choice_index` int,
	`received_at` datetime(3),
	`elapsed_ms` int,
	`correct` boolean NOT NULL,
	`score` int NOT NULL,
	CONSTRAINT PRIMARY KEY(`battle_id`,`idx`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `battle_questions` (
	`battle_id` binary(16) NOT NULL,
	`idx` int NOT NULL,
	`word_id` binary(16) NOT NULL,
	`question_type` enum('EN_TO_KO_CHOICE','KO_TO_EN_CHOICE','EN_TO_KO_TYPING','KO_TO_EN_TYPING') NOT NULL,
	`prompt` varchar(1000) NOT NULL,
	`choices` json NOT NULL,
	`answer_index` int NOT NULL,
	CONSTRAINT PRIMARY KEY(`battle_id`,`idx`)
);
--> statement-breakpoint
CREATE TABLE `battles` (
	`id` binary(16) PRIMARY KEY,
	`room_id` binary(16) NOT NULL,
	`question_count` int NOT NULL,
	`time_limit_sec` int NOT NULL,
	`phase` enum('READY','QUESTION','RESULT','FINISHED') NOT NULL DEFAULT 'READY',
	`current_index` int NOT NULL DEFAULT -1,
	`question_started_at` datetime(3),
	`deadline_at` datetime(3),
	`started_at` datetime(3) NOT NULL,
	`finished_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `battles_room_uq` UNIQUE INDEX(`room_id`)
);
--> statement-breakpoint
ALTER TABLE `battle_room_participants` ADD `disconnected_at` datetime(3);--> statement-breakpoint
CREATE INDEX `battle_answers_user_idx` ON `battle_answers` (`user_id`);--> statement-breakpoint
ALTER TABLE `battle_answers` ADD CONSTRAINT `battle_answers_battle_id_battles_id_fkey` FOREIGN KEY (`battle_id`) REFERENCES `battles`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `battle_answers` ADD CONSTRAINT `battle_answers_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `battle_questions` ADD CONSTRAINT `battle_questions_battle_id_battles_id_fkey` FOREIGN KEY (`battle_id`) REFERENCES `battles`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `battle_questions` ADD CONSTRAINT `battle_questions_word_id_words_id_fkey` FOREIGN KEY (`word_id`) REFERENCES `words`(`id`);--> statement-breakpoint
ALTER TABLE `battles` ADD CONSTRAINT `battles_room_id_battle_rooms_id_fkey` FOREIGN KEY (`room_id`) REFERENCES `battle_rooms`(`id`) ON DELETE CASCADE;