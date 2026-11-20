ALTER TABLE `user_word_progress` ADD `review_stage` tinyint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_word_progress` ADD `next_review_on` date;--> statement-breakpoint
ALTER TABLE `user_word_progress` ADD `last_reviewed_on` date;--> statement-breakpoint
CREATE INDEX `user_word_progress_review_idx` ON `user_word_progress` (`user_id`,`next_review_on`);--> statement-breakpoint
-- 이미 공부한 단어도 복습 일정에 넣는다: 마지막으로 공부한 날(KST) 다음 날
UPDATE `user_word_progress` SET `next_review_on` = DATE(DATE_ADD(`last_studied_at`, INTERVAL 9 HOUR)) + INTERVAL 1 DAY;
