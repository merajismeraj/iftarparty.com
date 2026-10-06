'use strict';

/** Append-only record of every admin action. */
async function log(db, adminId, action, entityType, entityId, detail = '') {
  await db.prepare('INSERT INTO admin_actions (admin_id, action, entity_type, entity_id, detail) VALUES (?, ?, ?, ?, ?)')
    .run(adminId, action, entityType, entityId ?? null, String(detail).slice(0, 1000));
}

module.exports = { log };
