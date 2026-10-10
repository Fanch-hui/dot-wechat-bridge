UPDATE `messages` SET `reply_id` = (
  SELECT j.id FROM jobs j JOIN json_each(j.message_ids) r
  WHERE j.kind = 'reply' AND r.value = messages.sequence ORDER BY j.sequence DESC LIMIT 1
) WHERE EXISTS (
  SELECT 1 FROM jobs j JOIN json_each(j.message_ids) r
  WHERE j.kind = 'reply' AND r.value = messages.sequence
);
--> statement-breakpoint
UPDATE `messages` SET `status` = CASE (
  SELECT state FROM jobs WHERE id = messages.reply_id
)
  WHEN 'delivered' THEN 'replied'
  WHEN 'cancelled' THEN 'skipped'
  ELSE 'reply_queued'
END WHERE reply_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `jobs` DROP COLUMN `is_final`;
