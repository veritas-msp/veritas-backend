-- Required by ON CONFLICT (client_id, equipment_id, equipment_family)
-- Reference CSV installs create the table without this unique key.

DELETE FROM v_b_equipment_monitoring_alerts a
USING v_b_equipment_monitoring_alerts b
WHERE a.ctid < b.ctid
  AND a.client_id = b.client_id
  AND a.equipment_id = b.equipment_id
  AND a.equipment_family = b.equipment_family;

CREATE UNIQUE INDEX IF NOT EXISTS v_b_equipment_monitoring_alerts_client_id_equipment_id_equipment_family_uniq
  ON v_b_equipment_monitoring_alerts (client_id, equipment_id, equipment_family);
