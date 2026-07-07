BEGIN;

ALTER TABLE v_b_ticket_categories
ADD COLUMN IF NOT EXISTS section TEXT NOT NULL DEFAULT 'Non classée';

UPDATE v_b_ticket_categories
SET section = 'Non classée'
WHERE COALESCE(TRIM(section), '') = '';

INSERT INTO v_b_ticket_categories (id, section, name, description, enabled)
VALUES
  ('itil-cat-infra-system-incident', 'Infogérance (gestion des infrastructures)', 'Incident système', 'Serveur down, service indisponible', TRUE),
  ('itil-cat-infra-performance', 'Infogérance (gestion des infrastructures)', 'Problème de performance', 'CPU, RAM, lenteur', TRUE),
  ('itil-cat-infra-backup', 'Infogérance (gestion des infrastructures)', 'Gestion des sauvegardes', 'Échec, restauration', TRUE),
  ('itil-cat-infra-patch', 'Infogérance (gestion des infrastructures)', 'Mise à jour / patch management', 'Suivi et déploiement des patchs', TRUE),
  ('itil-cat-infra-monitoring', 'Infogérance (gestion des infrastructures)', 'Supervision / alerting', 'Alertes et supervision', TRUE),
  ('itil-cat-infra-iam', 'Infogérance (gestion des infrastructures)', 'Gestion des comptes et accès', 'AD, LDAP, droits', TRUE),
  ('itil-cat-infra-network', 'Infogérance (gestion des infrastructures)', 'Réseau', 'Switch, firewall, VPN', TRUE),
  ('itil-cat-infra-security', 'Infogérance (gestion des infrastructures)', 'Sécurité', 'Incident, vulnérabilité, audit', TRUE),
  ('itil-cat-infra-maintenance', 'Infogérance (gestion des infrastructures)', 'Maintenance planifiée', 'Maintenance et interventions prévues', TRUE),
  ('itil-cat-infra-cmdb', 'Infogérance (gestion des infrastructures)', 'Gestion des configurations', 'CMDB et inventaire', TRUE),

  ('itil-cat-hosting-provisioning', 'Hébergement (infra & cloud)', 'Provisioning', 'Création VM, serveur, espace', TRUE),
  ('itil-cat-hosting-resources', 'Hébergement (infra & cloud)', 'Gestion des ressources', 'CPU, RAM, stockage', TRUE),
  ('itil-cat-hosting-access', 'Hébergement (infra & cloud)', 'Problème d’accès', 'SSH, RDP, FTP, panel web', TRUE),
  ('itil-cat-hosting-platform', 'Hébergement (infra & cloud)', 'Incident plateforme', 'Hyperviseur, cluster', TRUE),
  ('itil-cat-hosting-dns', 'Hébergement (infra & cloud)', 'DNS / nom de domaine', 'Gestion DNS et domaines', TRUE),
  ('itil-cat-hosting-ssl', 'Hébergement (infra & cloud)', 'Certificats SSL', 'Création, renouvellement SSL', TRUE),
  ('itil-cat-hosting-backup', 'Hébergement (infra & cloud)', 'Sauvegardes hébergées', 'Backup côté hébergement', TRUE),
  ('itil-cat-hosting-scaling', 'Hébergement (infra & cloud)', 'Scalabilité / montée en charge', 'Capacité et scaling', TRUE),
  ('itil-cat-hosting-billing', 'Hébergement (infra & cloud)', 'Facturation / quota dépassé', 'Facturation, dépassement quota', TRUE),
  ('itil-cat-hosting-migration', 'Hébergement (infra & cloud)', 'Migration', 'Migration serveur ou données', TRUE),

  ('itil-cat-support-request', 'Assistance (support utilisateurs)', 'Demande utilisateur', 'Nouveau matériel, logiciel', TRUE),
  ('itil-cat-support-workstation', 'Assistance (support utilisateurs)', 'Incident poste de travail', 'Incident poste utilisateur', TRUE),
  ('itil-cat-support-app', 'Assistance (support utilisateurs)', 'Problème applicatif', 'Bug ou problème applicatif', TRUE),
  ('itil-cat-support-password', 'Assistance (support utilisateurs)', 'Réinitialisation mot de passe', 'Reset mot de passe', TRUE),
  ('itil-cat-support-rights', 'Assistance (support utilisateurs)', 'Accès refusé / droits insuffisants', 'Gestion des droits', TRUE),
  ('itil-cat-support-install', 'Assistance (support utilisateurs)', 'Installation logiciel', 'Installation et déploiement logiciel', TRUE),
  ('itil-cat-support-office', 'Assistance (support utilisateurs)', 'Support bureautique', 'Office, mail', TRUE),
  ('itil-cat-support-network', 'Assistance (support utilisateurs)', 'Problème réseau utilisateur', 'WiFi, LAN utilisateur', TRUE),
  ('itil-cat-support-training', 'Assistance (support utilisateurs)', 'Formation / accompagnement', 'Accompagnement utilisateur', TRUE),
  ('itil-cat-support-evolution', 'Assistance (support utilisateurs)', 'Demande d’évolution', 'Demande d’amélioration', TRUE)
ON CONFLICT (id) DO NOTHING;

COMMIT;
