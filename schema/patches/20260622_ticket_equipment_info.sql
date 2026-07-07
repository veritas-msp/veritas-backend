-- Ticketing : matériel concerné (Veritas ou hors inventaire)
-- À exécuter avec le propriétaire de v_b_tickets (souvent postgres) si veritas_user échoue.

DO $$
BEGIN
  ALTER TABLE v_b_tickets
    ADD COLUMN IF NOT EXISTS equipment_info JSONB NOT NULL DEFAULT '{"concerned":false}'::jsonb;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Colonne equipment_info ignorée (droits insuffisants sur v_b_tickets)';
END $$;
