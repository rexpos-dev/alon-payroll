const { query } = require('./db');

// I-record kinsa ang nag-usab, unsa, ug kanus-a
async function audit(req, action, entity, entityId, details) {
  const userId = req && req.session && req.session.user ? req.session.user.id : null;
  const text = details === undefined ? null : (typeof details === 'string' ? details : JSON.stringify(details));
  await query('INSERT INTO audit_logs (user_id, action, entity, entity_id, details) VALUES (?,?,?,?,?)',
    [userId, action, entity, entityId === null || entityId === undefined ? null : String(entityId), text]);
}

// Ang mga field nga nausab lang (para sa audit details)
function diff(before, after, fields) {
  const out = {};
  for (const f of fields) {
    const a = before ? before[f] : undefined;
    const b = after[f];
    if (String(a ?? '') !== String(b ?? '')) out[f] = { from: a ?? null, to: b ?? null };
  }
  return out;
}

module.exports = { audit, diff };
