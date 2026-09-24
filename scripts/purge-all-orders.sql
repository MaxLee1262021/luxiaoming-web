-- MySQL: clear all orders, order-management details, and directly related data.
-- Run the statements in order. This is a direct hard-delete script.

-- 1. Order-management detail tables
DELETE FROM `lxm_order_contacts`;
DELETE FROM `lxm_order_source`;
DELETE FROM `lxm_order_package_snapshot_tags`;
DELETE FROM `lxm_order_package_snapshot`;
DELETE FROM `lxm_order_product_snapshot_tags`;
DELETE FROM `lxm_order_product_snapshots`;
DELETE FROM `lxm_order_products`;
DELETE FROM `lxm_order_addons`;
DELETE FROM `lxm_order_status_logs`;
DELETE FROM `lxm_order_follow_records`;
DELETE FROM `lxm_order_payment_records`;
DELETE FROM `lxm_collection_values` WHERE collection_name = 'orders';

-- 2. After-sales, adjustment, and reconciliation data
DELETE FROM `lxm_after_sale_logs`;
DELETE FROM `lxm_collection_values` WHERE collection_name = 'afterSales';
DELETE FROM `lxm_afterSales`;

DELETE FROM `lxm_collection_values` WHERE collection_name = 'adjustmentRecords';
DELETE FROM `lxm_adjustmentRecords`;

DELETE FROM `lxm_reconciliation_transfer_orders`;
DELETE FROM `lxm_collection_values` WHERE collection_name = 'reconciliationTransfers';
DELETE FROM `lxm_reconciliationTransfers`;

-- 3. Delete scan records that have been converted into orders
DELETE value_row
FROM `lxm_collection_values` AS value_row
INNER JOIN `lxm_scans` AS scan
  ON value_row.collection_name = 'scans' AND value_row.record_id = scan.id
WHERE scan.orderId IS NOT NULL;

DELETE FROM `lxm_scans` WHERE orderId IS NOT NULL;

-- 4. Delete order-related file registry entries.
-- This only deletes database records; OSS objects referenced by objectKey remain.
DELETE value_row
FROM `lxm_collection_values` AS value_row
INNER JOIN `lxm_mediaFiles` AS media
  ON value_row.collection_name = 'mediaFiles' AND value_row.record_id = media.id
WHERE media.orderId IS NOT NULL
   OR LOWER(COALESCE(media.collection, '')) IN (
     'orders', 'order', 'aftersales', 'aftersale',
     'adjustmentrecords', 'adjustmentrecord',
     'reconciliationtransfers', 'reconciliationtransfer'
   );

DELETE FROM `lxm_mediaFiles`
WHERE orderId IS NOT NULL
   OR LOWER(COALESCE(collection, '')) IN (
     'orders', 'order', 'aftersales', 'aftersale',
     'adjustmentrecords', 'adjustmentrecord',
     'reconciliationtransfers', 'reconciliationtransfer'
   );

-- 5. Delete audit logs belonging to orders, after-sales, adjustments, and transfers
DELETE snapshot
FROM `lxm_log_order_exception_snapshots` AS snapshot
INNER JOIN `lxm_logs` AS log_row ON log_row.id = snapshot.log_id
WHERE LOWER(COALESCE(log_row.targetType, '')) IN (
  'order', 'orders', 'aftersale', 'aftersales',
  'adjustmentrecords', 'adjustmentrecord',
  'reconciliationtransfers', 'reconciliationtransfer'
);

DELETE value_row
FROM `lxm_collection_values` AS value_row
INNER JOIN `lxm_logs` AS log_row
  ON value_row.collection_name = 'logs' AND value_row.record_id = log_row.id
WHERE LOWER(COALESCE(log_row.targetType, '')) IN (
  'order', 'orders', 'aftersale', 'aftersales',
  'adjustmentrecords', 'adjustmentrecord',
  'reconciliationtransfers', 'reconciliationtransfer'
);

DELETE FROM `lxm_logs`
WHERE LOWER(COALESCE(targetType, '')) IN (
  'order', 'orders', 'aftersale', 'aftersales',
  'adjustmentrecords', 'adjustmentrecord',
  'reconciliationtransfers', 'reconciliationtransfer'
);

-- 6. Delete order records in the recycle bin
DELETE trash_attr
FROM `lxm_trash_source_attributes` AS trash_attr
INNER JOIN `lxm_trash` AS trash ON trash.id = trash_attr.trash_id
WHERE trash.type = '订单'
   OR LOWER(COALESCE(trash.sourceKey, '')) IN ('orders', 'order');

DELETE value_row
FROM `lxm_collection_values` AS value_row
INNER JOIN `lxm_trash` AS trash
  ON value_row.collection_name = 'trash' AND value_row.record_id = trash.id
WHERE trash.type = '订单'
   OR LOWER(COALESCE(trash.sourceKey, '')) IN ('orders', 'order');

DELETE FROM `lxm_trash`
WHERE type = '订单'
   OR LOWER(COALESCE(sourceKey, '')) IN ('orders', 'order');

-- 7. Finally delete all orders
DELETE FROM `lxm_orders`;
