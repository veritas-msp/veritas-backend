-- -------------------------------------------------------
-- Permissions: v_b_ticket_automation_config (tickets)
-- -------------------------------------------------------
-- Accorde les droits a l'utilisateur applicatif pour
-- lire et modifier les templates/macros tickets.

DO $$
DECLARE
    app_user VARCHAR(255);
BEGIN
    -- Recuperer l'utilisateur DB applicatif depuis v_b_settings si present
    SELECT value INTO app_user
    FROM v_b_settings
    WHERE key = 'db_user'
    LIMIT 1;

    -- Fallback par defaut
    IF app_user IS NULL OR app_user = '' THEN
        app_user := 'veritas_user';
        RAISE NOTICE 'Utilisateur non trouve, fallback sur veritas_user';
    ELSE
        RAISE NOTICE 'Utilisateur detecte: %', app_user;
    END IF;

    EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_ticket_automation_config TO %I',
        app_user
    );

    RAISE NOTICE 'Permissions accordees a % sur v_b_ticket_automation_config', app_user;

EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Erreur attribution permissions (utilisateur detecte): %', SQLERRM;
        BEGIN
            EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE v_b_ticket_automation_config TO veritas_user';
            RAISE NOTICE 'Permissions accordees a veritas_user (fallback)';
        EXCEPTION
            WHEN OTHERS THEN
                RAISE WARNING 'Echec attribution permissions fallback: %', SQLERRM;
        END;
END $$;

-- Verification possible:
-- SELECT grantee, privilege_type
-- FROM information_schema.role_table_grants
-- WHERE table_name = 'v_b_ticket_automation_config';
