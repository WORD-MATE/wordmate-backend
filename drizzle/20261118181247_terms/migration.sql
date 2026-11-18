CREATE TABLE `policies` (
	`id` binary(16) PRIMARY KEY,
	`type` enum('TERMS','PRIVACY','MARKETING') NOT NULL,
	`version` varchar(20) NOT NULL,
	`title` varchar(100) NOT NULL,
	`content` mediumtext NOT NULL,
	`required` boolean NOT NULL,
	`require_reagreement` boolean NOT NULL DEFAULT false,
	`effective_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `policies_type_version_uq` UNIQUE INDEX(`type`,`version`)
);
--> statement-breakpoint
CREATE TABLE `user_agreements` (
	`id` binary(16) PRIMARY KEY,
	`user_id` binary(16) NOT NULL,
	`policy_type` enum('TERMS','PRIVACY','MARKETING') NOT NULL,
	`version` varchar(20) NOT NULL,
	`agreed` boolean NOT NULL,
	`agreed_at` datetime(3) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `policies_type_effective_idx` ON `policies` (`type`,`effective_at`);--> statement-breakpoint
CREATE INDEX `user_agreements_user_type_idx` ON `user_agreements` (`user_id`,`policy_type`,`id`);--> statement-breakpoint
ALTER TABLE `user_agreements` ADD CONSTRAINT `user_agreements_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE;