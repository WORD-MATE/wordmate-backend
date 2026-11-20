ALTER TABLE `devices` ADD `push_type` enum('APNS','FCM','WEBPUSH');--> statement-breakpoint
ALTER TABLE `devices` ADD `push_token` varchar(512);--> statement-breakpoint
ALTER TABLE `devices` ADD `webpush_endpoint` varchar(700);--> statement-breakpoint
ALTER TABLE `devices` ADD `webpush_p256dh` varchar(255);--> statement-breakpoint
ALTER TABLE `devices` ADD `webpush_auth` varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX `push_token_unique` ON `devices` (`push_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `webpush_endpoint_unique` ON `devices` (`webpush_endpoint`);--> statement-breakpoint
CREATE INDEX `devices_user_revoked_idx` ON `devices` (`user_id`,`revoked_at`);--> statement-breakpoint
DROP INDEX `devices_user_idx` ON `devices`;
