CREATE TABLE `ranking_season_exclusions` (
	`season_id` binary(16) NOT NULL,
	`user_id` binary(16) NOT NULL,
	`reason` varchar(200) NOT NULL,
	`admin_id` binary(16),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT PRIMARY KEY(`season_id`,`user_id`),
	CONSTRAINT `ranking_season_exclusions_season_id_ranking_seasons_id_fkey` FOREIGN KEY (`season_id`) REFERENCES `ranking_seasons`(`id`) ON DELETE CASCADE,
	CONSTRAINT `ranking_season_exclusions_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `ranking_season_exclusions_admin_id_users_id_fkey` FOREIGN KEY (`admin_id`) REFERENCES `users`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
ALTER TABLE `ranking_snapshots` MODIFY COLUMN `rank` int;--> statement-breakpoint
ALTER TABLE `ranking_snapshots` ADD `position` int NOT NULL;--> statement-breakpoint
UPDATE `ranking_snapshots` s JOIN (
	SELECT `season_id`, `scope`, `user_id`,
		ROW_NUMBER() OVER (PARTITION BY `season_id`, `scope` ORDER BY `rank`, `listed`, `xp` DESC) - 1 AS `pos`
	FROM `ranking_snapshots`
) o ON o.`season_id` = s.`season_id` AND o.`scope` = s.`scope` AND o.`user_id` = s.`user_id`
SET s.`position` = o.`pos`;
