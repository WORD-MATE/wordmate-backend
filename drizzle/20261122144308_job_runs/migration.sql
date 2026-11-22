CREATE TABLE `job_runs` (
	`id` binary(16) PRIMARY KEY,
	`job` enum('EXPIRE_STUDY_SESSIONS','DAILY_CLEANUP','SEASON_CLOSE','CHALLENGE_GENERATE','STUDY_REMINDER','MORNING_PUBLISH','MORNING_SENTENCE','RANK_WEEKLY_RESULT','RANK_DROP') NOT NULL,
	`status` enum('RUNNING','SUCCEEDED','FAILED') NOT NULL,
	`trigger` enum('SCHEDULE','MANUAL') NOT NULL,
	`started_at` datetime(3) NOT NULL,
	`finished_at` datetime(3),
	`error` varchar(1000),
	`result` json
);
--> statement-breakpoint
CREATE INDEX `job_runs_job_idx` ON `job_runs` (`job`,`id`);--> statement-breakpoint
CREATE INDEX `job_runs_started_idx` ON `job_runs` (`started_at`);