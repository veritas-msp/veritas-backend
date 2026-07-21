import { pool } from "../database/db.js";
export async function recordMonitoringEvent({
  source,
  eventType,
  clientId = null,
  equipmentId = null,
  equipmentFamily = null,
  criterionKey = null,
  payload = {},
  status = "processed",
  ticketId = null,
  incidentGroupId = null
}) {
  const result = await pool.query(`INSERT INTO v_b_monitoring_events
       (source, event_type, client_id, equipment_id, equipment_family, criterion_key,
        payload, status, ticket_id, incident_group_id, processed_at, created_at)
     VALUES ($1, $2, $3, $4::uuid, $5, $6, $7::jsonb, $8, $9::uuid, $10::uuid, NOW(), NOW())
     RETURNING *`, [source, eventType, clientId, equipmentId, equipmentFamily, criterionKey, JSON.stringify(payload || {}), status, ticketId, incidentGroupId]);
  return result.rows[0];
}
export async function listMonitoringEvents({
  clientId = null,
  status = null,
  limit = 100,
  offset = 0
} = {}) {
  const where = [];
  const values = [];
  let index = 1;
  if (clientId != null) {
    where.push(`client_id = $${index}`);
    values.push(Number(clientId));
    index += 1;
  }
  if (status) {
    where.push(`status = $${index}`);
    values.push(status);
    index += 1;
  }
  values.push(Math.min(500, Math.max(1, limit)));
  values.push(Math.max(0, offset));
  const result = await pool.query(`SELECT * FROM v_b_monitoring_events
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY created_at DESC
     LIMIT $${index} OFFSET $${index + 1}`, values);
  return result.rows;
}
export async function ingestExternalMonitoringEvent(body = {}) {
  const {
    source = "external",
    eventType = "alert",
    clientId,
    equipmentId,
    equipmentFamily,
    criterionKey,
    payload = {}
  } = body;
  if (!clientId || !criterionKey) {
    const error = new Error("clientId and criterionKey are required");
    error.statusCode = 400;
    throw error;
  }
  return recordMonitoringEvent({
    source,
    eventType,
    clientId,
    equipmentId,
    equipmentFamily,
    criterionKey,
    payload,
    status: "pending"
  });
}
