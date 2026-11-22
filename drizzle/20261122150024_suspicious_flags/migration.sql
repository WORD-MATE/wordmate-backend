CREATE TABLE `suspicious_flags` (
	`id` binary(16) PRIMARY KEY,
	`user_id` binary(16) NOT NULL,
	`reason` enum('FAST_ANSWERS','REPEATED_OPPONENT','XP_SPIKE') NOT NULL,
	`date` date NOT NULL,
	`detail` json NOT NULL,
	`detected_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`reviewed` boolean NOT NULL DEFAULT false,
	`reviewed_by` binary(16),
	`reviewed_at` datetime(3),
	CONSTRAINT `suspicious_flags_daily_uq` UNIQUE INDEX(`user_id`,`date`,`reason`),
	CONSTRAINT `suspicious_flags_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `suspicious_flags_reviewed_by_users_id_fkey` FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
ALTER TABLE `job_runs` MODIFY COLUMN `job` enum('EXPIRE_STUDY_SESSIONS','DAILY_CLEANUP','SEASON_CLOSE','CHALLENGE_GENERATE','STUDY_REMINDER','MORNING_PUBLISH','MORNING_SENTENCE','RANK_WEEKLY_RESULT','RANK_DROP','SUSPICIOUS_DETECT') NOT NULL;--> statement-breakpoint
CREATE INDEX `study_answers_submitted_idx` ON `study_answers` (`submitted_at`);--> statement-breakpoint
CREATE INDEX `suspicious_flags_date_idx` ON `suspicious_flags` (`date`,`user_id`);--> statement-breakpoint
CREATE INDEX `xp_ledger_date_idx` ON `xp_ledger` (`date`,`user_id`);