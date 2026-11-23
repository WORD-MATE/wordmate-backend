-- 지금까지 XP를 줄 때 total_xp를 올리지 않았으므로 원장에서 채운다
UPDATE `users` u
LEFT JOIN (
	SELECT `user_id`, SUM(`amount`) AS total FROM `xp_ledger` GROUP BY `user_id`
) x ON x.`user_id` = u.`id`
SET u.`total_xp` = COALESCE(x.total, 0);
