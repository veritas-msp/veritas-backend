-- Numéro client distinct du nom (raison sociale)
ALTER TABLE v_b_clients
  ADD COLUMN IF NOT EXISTS client_number VARCHAR(32);

CREATE INDEX IF NOT EXISTS idx_v_b_clients_client_number
  ON v_b_clients (client_number);

-- Reprise des numéros déjà préfixés dans name (ex. "31-ACME")
UPDATE v_b_clients
SET client_number = (regexp_match(trim(name), '^(\d{2,})'))[1]
WHERE client_number IS NULL
  AND trim(name) ~ '^\d{2,}';
