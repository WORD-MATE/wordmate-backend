CREATE TABLE `faqs` (
	`id` binary(16) PRIMARY KEY,
	`category` enum('ACCOUNT','STUDY','BATTLE_RANKING','OTHER') NOT NULL,
	`question` varchar(200) NOT NULL,
	`answer` mediumtext NOT NULL,
	`sort_order` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3))
);
--> statement-breakpoint
CREATE INDEX `faqs_category_idx` ON `faqs` (`category`,`sort_order`);