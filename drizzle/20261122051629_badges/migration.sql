CREATE TABLE `badges` (
	`id` binary(16) PRIMARY KEY,
	`code` varchar(50) NOT NULL,
	`type` enum('ACHIEVEMENT','SEASON') NOT NULL,
	`name` varchar(50) NOT NULL,
	`description` varchar(200) NOT NULL,
	`condition_text` varchar(100) NOT NULL,
	`image_url` varchar(300) NOT NULL,
	`metric` enum('TOTAL_XP','STUDY_COUNT','STUDY_STREAK','BATTLE_WINS','MORNING_STREAK'),
	`threshold` int,
	`sort_order` int NOT NULL DEFAULT 0,
	`active` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `code_unique` UNIQUE INDEX(`code`)
);
--> statement-breakpoint
CREATE TABLE `user_badges` (
	`user_id` binary(16) NOT NULL,
	`badge_id` binary(16) NOT NULL,
	`earned_at` datetime(3) NOT NULL,
	CONSTRAINT PRIMARY KEY(`user_id`,`badge_id`)
);
--> statement-breakpoint
CREATE INDEX `user_badges_badge_idx` ON `user_badges` (`badge_id`);--> statement-breakpoint
ALTER TABLE `user_badges` ADD CONSTRAINT `user_badges_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `user_badges` ADD CONSTRAINT `user_badges_badge_id_badges_id_fkey` FOREIGN KEY (`badge_id`) REFERENCES `badges`(`id`) ON DELETE CASCADE;--> statement-breakpoint
INSERT INTO `badges` (`id`, `code`, `type`, `name`, `description`, `condition_text`, `image_url`, `metric`, `threshold`, `sort_order`) VALUES
(UNHEX('019aa9a0000070008000000000000001'), 'FIRST_STUDY', 'ACHIEVEMENT', '첫걸음', '처음으로 학습을 끝냈어요.', '학습 1회 끝내기', 'badges/first-study', 'STUDY_COUNT', 1, 1),
(UNHEX('019aa9a0000070008000000000000002'), 'STUDY_100', 'ACHIEVEMENT', '꾸준한 학습자', '학습을 100번 끝냈어요.', '학습 100회 끝내기', 'badges/study-100', 'STUDY_COUNT', 100, 2),
(UNHEX('019aa9a0000070008000000000000003'), 'STREAK_7', 'ACHIEVEMENT', '일주일 연속', '7일 연속으로 학습했어요.', '7일 연속 학습', 'badges/streak-7', 'STUDY_STREAK', 7, 3),
(UNHEX('019aa9a0000070008000000000000004'), 'STREAK_30', 'ACHIEVEMENT', '한 달 연속', '30일 연속으로 학습했어요.', '30일 연속 학습', 'badges/streak-30', 'STUDY_STREAK', 30, 4),
(UNHEX('019aa9a0000070008000000000000005'), 'XP_1000', 'ACHIEVEMENT', 'XP 1,000', '누적 XP 1,000을 모았어요.', '누적 XP 1,000', 'badges/xp-1000', 'TOTAL_XP', 1000, 5),
(UNHEX('019aa9a0000070008000000000000006'), 'XP_10000', 'ACHIEVEMENT', 'XP 10,000', '누적 XP 10,000을 모았어요.', '누적 XP 10,000', 'badges/xp-10000', 'TOTAL_XP', 10000, 6),
(UNHEX('019aa9a0000070008000000000000007'), 'FIRST_WIN', 'ACHIEVEMENT', '첫 승리', '대결에서 처음 이겼어요.', '대결 1번 이기기', 'badges/first-win', 'BATTLE_WINS', 1, 7),
(UNHEX('019aa9a0000070008000000000000008'), 'WIN_50', 'ACHIEVEMENT', '대결의 달인', '대결에서 50번 이겼어요.', '대결 50번 이기기', 'badges/win-50', 'BATTLE_WINS', 50, 8),
(UNHEX('019aa9a0000070008000000000000009'), 'MORNING_7', 'ACHIEVEMENT', '아침형 인간', '오늘의 문장을 7일 연속 풀었어요.', '오늘의 문장 7일 연속', 'badges/morning-7', 'MORNING_STREAK', 7, 9);
