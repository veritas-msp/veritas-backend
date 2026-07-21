import { ALLOWED_LOCALES } from "./generalSettings.js";
const CATALOG_ENTRIES = [{
  category: "intervention",
  displayOrder: 10,
  labels: {
    fr: "À distance",
    en: "Remote",
    de: "Remote",
    it: "Da remoto",
    es: "A distancia"
  }
}, {
  category: "intervention",
  displayOrder: 20,
  labels: {
    fr: "Sur site",
    en: "On-site",
    de: "Vor Ort",
    it: "In sede",
    es: "In situ"
  }
}, {
  category: "intervention",
  displayOrder: 30,
  labels: {
    fr: "En atelier",
    en: "In workshop",
    de: "In der Werkstatt",
    it: "In laboratorio",
    es: "En taller"
  }
}, {
  category: "intervention",
  displayOrder: 40,
  labels: {
    fr: "Commerce",
    en: "Sales",
    de: "Vertrieb",
    it: "Commerciale",
    es: "Comercial"
  }
}, {
  category: "action",
  displayOrder: 10,
  labels: {
    fr: "Branchement",
    en: "Connection",
    de: "Anschluss",
    it: "Collegamento",
    es: "Conexión"
  }
}, {
  category: "action",
  displayOrder: 20,
  labels: {
    fr: "Configuration",
    en: "Configuration",
    de: "Konfiguration",
    it: "Configurazione",
    es: "Configuración"
  }
}, {
  category: "action",
  displayOrder: 30,
  labels: {
    fr: "Mise à jour",
    en: "Update",
    de: "Update",
    it: "Aggiornamento",
    es: "Actualización"
  }
}, {
  category: "action",
  displayOrder: 40,
  labels: {
    fr: "Demande de devis",
    en: "Quote request",
    de: "Angebotsanfrage",
    it: "Richiesta di preventivo",
    es: "Solicitud de presupuesto"
  }
}, {
  category: "action",
  displayOrder: 50,
  labels: {
    fr: "Remplacement de matériel",
    en: "Hardware replacement",
    de: "Hardware-Austausch",
    it: "Sostituzione hardware",
    es: "Sustitución de hardware"
  }
}, {
  category: "action",
  displayOrder: 60,
  labels: {
    fr: "Remplacement d'une pièce",
    en: "Part replacement",
    de: "Teileaustausch",
    it: "Sostituzione componente",
    es: "Sustitución de pieza"
  }
}, {
  category: "action",
  displayOrder: 70,
  labels: {
    fr: "Réparation",
    en: "Repair",
    de: "Reparatur",
    it: "Riparazione",
    es: "Reparación"
  }
}, {
  category: "action",
  displayOrder: 80,
  labels: {
    fr: "Diagnostic",
    en: "Diagnostics",
    de: "Diagnose",
    it: "Diagnostica",
    es: "Diagnóstico"
  }
}, {
  category: "action",
  displayOrder: 90,
  labels: {
    fr: "Installation",
    en: "Installation",
    de: "Installation",
    it: "Installazione",
    es: "Instalación"
  }
}, {
  category: "action",
  displayOrder: 100,
  labels: {
    fr: "Désinstallation",
    en: "Uninstallation",
    de: "Deinstallation",
    it: "Disinstallazione",
    es: "Desinstalación"
  }
}, {
  category: "action",
  displayOrder: 110,
  labels: {
    fr: "Migration de données",
    en: "Data migration",
    de: "Datenmigration",
    it: "Migrazione dati",
    es: "Migración de datos"
  }
}, {
  category: "action",
  displayOrder: 120,
  labels: {
    fr: "Sauvegarde / restauration",
    en: "Backup / restore",
    de: "Backup / Wiederherstellung",
    it: "Backup / ripristino",
    es: "Copia de seguridad / restauración"
  }
}, {
  category: "action",
  displayOrder: 130,
  labels: {
    fr: "Nettoyage / maintenance",
    en: "Cleaning / maintenance",
    de: "Reinigung / Wartung",
    it: "Pulizia / manutenzione",
    es: "Limpieza / mantenimiento"
  }
}, {
  category: "action",
  displayOrder: 140,
  labels: {
    fr: "Formation utilisateur",
    en: "User training",
    de: "Benutzerschulung",
    it: "Formazione utente",
    es: "Formación de usuario"
  }
}, {
  category: "action",
  displayOrder: 150,
  labels: {
    fr: "Paramétrage logiciel",
    en: "Software setup",
    de: "Software-Einrichtung",
    it: "Configurazione software",
    es: "Configuración de software"
  }
}, {
  category: "action",
  displayOrder: 160,
  labels: {
    fr: "Paramétrage réseau",
    en: "Network setup",
    de: "Netzwerk-Einrichtung",
    it: "Configurazione rete",
    es: "Configuración de red"
  }
}, {
  category: "action",
  displayOrder: 170,
  labels: {
    fr: "Création de compte",
    en: "Account creation",
    de: "Kontoerstellung",
    it: "Creazione account",
    es: "Creación de cuenta"
  }
}, {
  category: "action",
  displayOrder: 180,
  labels: {
    fr: "Réinitialisation mot de passe",
    en: "Password reset",
    de: "Passwort zurücksetzen",
    it: "Reimpostazione password",
    es: "Restablecimiento de contraseña"
  }
}, {
  category: "action",
  displayOrder: 190,
  labels: {
    fr: "Restauration de service",
    en: "Service restoration",
    de: "Dienstwiederherstellung",
    it: "Ripristino servizio",
    es: "Restauración del servicio"
  }
}, {
  category: "action",
  displayOrder: 200,
  labels: {
    fr: "Analyse de logs",
    en: "Log analysis",
    de: "Log-Analyse",
    it: "Analisi log",
    es: "Análisis de logs"
  }
}, {
  category: "action",
  displayOrder: 210,
  labels: {
    fr: "Mise en conformité",
    en: "Compliance alignment",
    de: "Compliance-Herstellung",
    it: "Adeguamento conformità",
    es: "Adecuación de cumplimiento"
  }
}, {
  category: "action",
  displayOrder: 220,
  labels: {
    fr: "Audit",
    en: "Audit",
    de: "Audit",
    it: "Audit",
    es: "Auditoría"
  }
}, {
  category: "action",
  displayOrder: 230,
  labels: {
    fr: "Conseil / recommandation",
    en: "Advice / recommendation",
    de: "Beratung / Empfehlung",
    it: "Consulenza / raccomandazione",
    es: "Asesoramiento / recomendación"
  }
}, {
  category: "action",
  displayOrder: 240,
  labels: {
    fr: "Livraison matériel",
    en: "Hardware delivery",
    de: "Hardware-Lieferung",
    it: "Consegna hardware",
    es: "Entrega de hardware"
  }
}, {
  category: "action",
  displayOrder: 250,
  labels: {
    fr: "Récupération matériel",
    en: "Hardware pickup",
    de: "Hardware-Abholung",
    it: "Ritiro hardware",
    es: "Recogida de hardware"
  }
}, {
  category: "action",
  displayOrder: 260,
  labels: {
    fr: "Test et validation",
    en: "Testing and validation",
    de: "Test und Validierung",
    it: "Test e validazione",
    es: "Prueba y validación"
  }
}, {
  category: "action",
  displayOrder: 270,
  labels: {
    fr: "Escalade fournisseur",
    en: "Vendor escalation",
    de: "Hersteller-Eskalation",
    it: "Escalation fornitore",
    es: "Escalada a proveedor"
  }
}, {
  category: "action",
  displayOrder: 280,
  labels: {
    fr: "Intervention annulée (client absent)",
    en: "Cancelled intervention (client absent)",
    de: "Einsatz abgesagt (Kunde abwesend)",
    it: "Intervento annullato (cliente assente)",
    es: "Intervención cancelada (cliente ausente)"
  }
}, {
  category: "action",
  displayOrder: 290,
  labels: {
    fr: "Accès refusé",
    en: "Access denied",
    de: "Zugriff verweigert",
    it: "Accesso negato",
    es: "Acceso denegado"
  }
}];
export function normalizeSolutionCatalogLocale(locale) {
  const code = String(locale || "fr").slice(0, 2).toLowerCase();
  return ALLOWED_LOCALES.includes(code) ? code : "fr";
}
export function getSolutionCatalogDefaults(locale = "fr") {
  const code = normalizeSolutionCatalogLocale(locale);
  return CATALOG_ENTRIES.map(({
    category,
    displayOrder,
    labels
  }) => ({
    category,
    displayOrder,
    label: labels[code] || labels.fr
  }));
}
