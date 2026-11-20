CREATE TABLE `word_favorites` (
	`user_id` binary(16) NOT NULL,
	`word_id` binary(16) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT PRIMARY KEY(`user_id`,`word_id`),
	CONSTRAINT `word_favorites_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `word_favorites_word_id_words_id_fkey` FOREIGN KEY (`word_id`) REFERENCES `words`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `words` ADD `meanings_text` varchar(600) DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `word_favorites_user_created_idx` ON `word_favorites` (`user_id`,`created_at`,`word_id`);--> statement-breakpoint
SET SESSION group_concat_max_len = 8192;--> statement-breakpoint
UPDATE `words` w
JOIN (
	SELECT w2.`id`, GROUP_CONCAT(jt.m ORDER BY jt.n SEPARATOR ' ') AS t
	FROM `words` w2,
		JSON_TABLE(w2.`meanings`, '$[*]' COLUMNS (n FOR ORDINALITY, m VARCHAR(100) PATH '$')) jt
	GROUP BY w2.`id`
) x ON x.`id` = w.`id`
SET w.`meanings_text` = x.t;--> statement-breakpoint
-- ngram 파서는 불용어(a, on, is …)를 "포함한" 토큰을 모두 버린다. 인덱스를 만드는 시점의 설정이 인덱스에 고정되므로 끄고 만든다
SET SESSION innodb_ft_enable_stopword = OFF;--> statement-breakpoint
ALTER TABLE `words` ADD FULLTEXT INDEX `words_search_ft` (`english`, `meanings_text`) WITH PARSER ngram;--> statement-breakpoint
SET SESSION innodb_ft_enable_stopword = ON;
