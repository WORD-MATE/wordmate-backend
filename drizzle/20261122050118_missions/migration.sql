CREATE TABLE `missions` (
	`id` binary(16) PRIMARY KEY,
	`code` varchar(50) NOT NULL,
	`period` enum('DAILY','WEEKLY') NOT NULL,
	`metric` enum('STUDY_COMPLETE','WORDS_STUDIED','BATTLE_FINISH','BATTLE_WIN','MORNING_COMPLETE','XP_EARNED') NOT NULL,
	`title` varchar(100) NOT NULL,
	`target` int NOT NULL,
	`reward_xp` int NOT NULL,
	`sort_order` int NOT NULL DEFAULT 0,
	`active` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `code_unique` UNIQUE INDEX(`code`)
);
--> statement-breakpoint
CREATE TABLE `user_missions` (
	`user_id` binary(16) NOT NULL,
	`mission_id` binary(16) NOT NULL,
	`period_key` date NOT NULL,
	`progress` int NOT NULL DEFAULT 0,
	`claimed_at` datetime(3),
	CONSTRAINT PRIMARY KEY(`user_id`,`mission_id`,`period_key`)
);
--> statement-breakpoint
CREATE INDEX `missions_metric_idx` ON `missions` (`metric`,`active`);--> statement-breakpoint
CREATE INDEX `user_missions_period_idx` ON `user_missions` (`period_key`);--> statement-breakpoint
ALTER TABLE `user_missions` ADD CONSTRAINT `user_missions_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `user_missions` ADD CONSTRAINT `user_missions_mission_id_missions_id_fkey` FOREIGN KEY (`mission_id`) REFERENCES `missions`(`id`) ON DELETE CASCADE;--> statement-breakpoint
INSERT INTO `missions` (`id`, `code`, `period`, `metric`, `title`, `target`, `reward_xp`, `sort_order`) VALUES
(UNHEX('019aa8f2000070008000000000000001'), 'DAILY_STUDY', 'DAILY', 'STUDY_COMPLETE', '학습 1회 끝내기', 1, 10, 1),
(UNHEX('019aa8f2000070008000000000000002'), 'DAILY_WORDS', 'DAILY', 'WORDS_STUDIED', '단어 20개 학습하기', 20, 10, 2),
(UNHEX('019aa8f2000070008000000000000003'), 'DAILY_BATTLE', 'DAILY', 'BATTLE_FINISH', '대결 1번 끝까지 하기', 1, 10, 3),
(UNHEX('019aa8f2000070008000000000000004'), 'DAILY_MORNING', 'DAILY', 'MORNING_COMPLETE', '오늘의 문장 퀴즈 풀기', 1, 5, 4),
(UNHEX('019aa8f2000070008000000000000005'), 'WEEKLY_STUDY', 'WEEKLY', 'STUDY_COMPLETE', '학습 5회 끝내기', 5, 30, 1),
(UNHEX('019aa8f2000070008000000000000006'), 'WEEKLY_WIN', 'WEEKLY', 'BATTLE_WIN', '대결 3번 이기기', 3, 30, 2),
(UNHEX('019aa8f2000070008000000000000007'), 'WEEKLY_XP', 'WEEKLY', 'XP_EARNED', 'XP 300 모으기', 300, 50, 3);
