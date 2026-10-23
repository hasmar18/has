export async function audit(db, userId, action, entity, entityId = null, details = {}) {
  await db.query(
    'INSERT INTO audit_log (actor_user_id, action, entity, entity_id, details) VALUES ($1, $2, $3, $4, $5::jsonb)',
    [userId, action, entity, entityId === null ? null : String(entityId), JSON.stringify(details)],
  );
}

export async function addHistory(db, bookingId, actor, actorUserId, action, details = {}) {
  await db.query(
    'INSERT INTO booking_history (booking_id, actor, actor_user_id, action, details) VALUES ($1, $2, $3, $4, $5::jsonb)',
    [bookingId, actor, actorUserId || null, action, JSON.stringify(details)],
  );
}
