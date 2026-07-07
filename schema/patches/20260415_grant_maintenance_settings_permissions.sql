
-- ───────────────────────────────────────────────
-- 🔐 Permissions : v_b_settings_system (maintenance)
-- ───────────────────────────────────────────────
-- Cette migration accorde les droits nécessaires à l'utilisateur applicatif
-- pour lire et modifier la configuration de maintenance.

DO $$
DECLARE
    app_user VARCHAR(255);
BEGIN
    -- Récupérer l'utilisateur DB applicatif depuis v_b_settings si présent
    SELECT value INTO app_user
    FROM v_b_settings
    WHERE key = 'db_user'
    LIMIT 1;

    -- Fallback par défaut
    IF app_user IS NULL OR app_user = '' THEN
        app_user := 'veritas_user';
        RAISE NOTICE 'Utilisateur non trouvé, fallback sur veritas_user';
    ELSE
        RAISE NOTICE 'Utilisateur détecté: %', app_user;
    END IF;

    -- Droits nécessaires pour GET /status et POST /toggle
    EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_settings_system TO %I',
        app_user
    );

    RAISE NOTICE 'Permissions accordées à % sur v_b_settings_system', app_user;

EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Erreur attribution permissions (utilisateur détecté): %', SQLERRM;
        BEGIN
            EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_settings_system TO veritas_user';
            RAISE NOTICE 'Permissions accordées à veritas_user (fallback)';
        EXCEPTION
            WHEN OTHERS THEN
                RAISE WARNING 'Échec attribution permissions fallback: %', SQLERRM;
        END;
END $$;

-- Vérification possible:
-- SELECT grantee, privilege_type
-- FROM information_schema.role_table_grants
-- WHERE table_name = 'v_b_settings_system';
