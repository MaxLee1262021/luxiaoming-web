-- Review-only patch. Prepared on 2026-11-05; not executed by Codex.
-- Select the intended existing database in your MySQL client before running.
-- MySQL 5.7 compatible. Run from one session; do not run concurrent copies.
-- Scope: add only these two nullable columns if missing; no business-row writes.

SELECT DATABASE() AS selected_database;

SET @lxm_guides_column_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'lxm_guides'
      AND COLUMN_NAME = 'targetProductSpotId'
  ),
  'SELECT ''targetProductSpotId already exists; skipped'' AS migration_status',
  'ALTER TABLE `lxm_guides` ADD COLUMN `targetProductSpotId` VARCHAR(255) NULL'
);
PREPARE lxm_guides_column_statement FROM @lxm_guides_column_sql;
EXECUTE lxm_guides_column_statement;
DEALLOCATE PREPARE lxm_guides_column_statement;

SET @lxm_guides_column_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'lxm_guides'
      AND COLUMN_NAME = 'contentHtml'
  ),
  'SELECT ''contentHtml already exists; skipped'' AS migration_status',
  'ALTER TABLE `lxm_guides` ADD COLUMN `contentHtml` TEXT NULL'
);
PREPARE lxm_guides_column_statement FROM @lxm_guides_column_sql;
EXECUTE lxm_guides_column_statement;
DEALLOCATE PREPARE lxm_guides_column_statement;

-- Read-only verification. Existing columns are not altered if their type differs.
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'lxm_guides'
  AND COLUMN_NAME IN ('targetProductSpotId', 'contentHtml')
ORDER BY ORDINAL_POSITION;
