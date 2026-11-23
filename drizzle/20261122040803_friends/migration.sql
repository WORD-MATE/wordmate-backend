CREATE TABLE `friend_requests` (
	`id` binary(16) PRIMARY KEY,
	`requester_id` binary(16) NOT NULL,
	`receiver_id` binary(16) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `friend_requests_pair_uq` UNIQUE INDEX(`requester_id`,`receiver_id`)
);
--> statement-breakpoint
CREATE TABLE `friendships` (
	`user_id` binary(16) NOT NULL,
	`friend_id` binary(16) NOT NULL,
	`since` datetime(3) NOT NULL,
	CONSTRAINT PRIMARY KEY(`user_id`,`friend_id`)
);
--> statement-breakpoint
CREATE INDEX `friend_requests_receiver_idx` ON `friend_requests` (`receiver_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `friend_requests` ADD CONSTRAINT `friend_requests_requester_id_users_id_fkey` FOREIGN KEY (`requester_id`) REFERENCES `users`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `friend_requests` ADD CONSTRAINT `friend_requests_receiver_id_users_id_fkey` FOREIGN KEY (`receiver_id`) REFERENCES `users`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `friendships` ADD CONSTRAINT `friendships_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `friendships` ADD CONSTRAINT `friendships_friend_id_users_id_fkey` FOREIGN KEY (`friend_id`) REFERENCES `users`(`id`) ON DELETE CASCADE;