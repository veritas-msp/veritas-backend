-- Permet de réafficher le token d'enrôlement aux administrateurs (chiffré au repos).
ALTER TABLE v_b_rmm_enrollment_tokens
  ADD COLUMN IF NOT EXISTS token_encrypted TEXT;
