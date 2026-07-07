-- Auth clientId Mailinblack (retourné par POST /auth/api/v2.0/login ou api-keys/execute)
ALTER TABLE v_b_clients_mailinblack
  ADD COLUMN IF NOT EXISTS auth_client_id TEXT;
