CREATE TABLE `users` (
	`id` binary(16) PRIMARY KEY,
	`datagsm_id` varchar(64) NOT NULL,
	`name` varchar(50) NOT NULL,
	`role` enum('STUDENT','TEACHER') NOT NULL,
	`is_admin` boolean NOT NULL DEFAULT false,
	`status` enum('ACTIVE','SUSPENDED','WITHDRAWN') NOT NULL DEFAULT 'ACTIVE',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`deleted_at` datetime(3),
	CONSTRAINT `datagsm_id_unique` UNIQUE INDEX(`datagsm_id`)
);
