CREATE TABLE `withdrawn_suspensions` (
	`datagsm_id` varchar(64) PRIMARY KEY,
	`suspended_until` datetime(3),
	`reason` varchar(200) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3))
);
