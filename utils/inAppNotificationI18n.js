const ALLOWED_LOCALES = ["fr", "en", "de", "it", "es"];
export function normalizeNotificationLocale(locale, fallback = "en") {
  const code = String(locale || fallback).trim().toLowerCase().slice(0, 2);
  if (ALLOWED_LOCALES.includes(code)) return code;
  const safeFallback = ALLOWED_LOCALES.includes(fallback) ? fallback : "en";
  return safeFallback;
}
const TEST_NOTIFICATION_SAMPLES = {
  fr: {
    ticket_commented: {
      type: "ticket_commented",
      title: "[Test] Nouveau commentaire sur #123 · Demande support",
      body: "Notification de test : un agent a commenté un ticket qui vous est assigné."
    },
    ticket_assigned: {
      type: "ticket_assigned",
      title: "[Test] Assignation sur #123 · Demande support",
      body: "Notification de test : vous avez été assigné à ce ticket."
    },
    ticket_resolved: {
      type: "ticket_resolved",
      title: "[Test] #123 · Demande support résolu",
      body: "Notification de test : le ticket a été marqué comme résolu."
    },
    ticket_created: {
      type: "ticket_created",
      title: "[Test] Nouveau ticket #123 · Demande support",
      body: "Notification de test : un ticket vous a été assigné à la création."
    },
    ticket_updated: {
      type: "ticket_updated",
      title: "[Test] #123 · Demande support mis à jour",
      body: "Notification de test : le ticket a été modifié."
    },
    ticket_satisfaction: {
      type: "ticket_satisfaction",
      title: "[Test] Retour client sur #123 · Demande support",
      body: "Notification de test : le client a laissé une note de satisfaction."
    }
  },
  en: {
    ticket_commented: {
      type: "ticket_commented",
      title: "[Test] New comment on #123 · Support request",
      body: "Test notification: an agent commented on a ticket assigned to you."
    },
    ticket_assigned: {
      type: "ticket_assigned",
      title: "[Test] Assignment on #123 · Support request",
      body: "Test notification: you have been assigned to this ticket."
    },
    ticket_resolved: {
      type: "ticket_resolved",
      title: "[Test] #123 · Support request resolved",
      body: "Test notification: the ticket has been marked as resolved."
    },
    ticket_created: {
      type: "ticket_created",
      title: "[Test] New ticket #123 · Support request",
      body: "Test notification: a ticket was assigned to you on creation."
    },
    ticket_updated: {
      type: "ticket_updated",
      title: "[Test] #123 · Support request updated",
      body: "Test notification: the ticket was updated."
    },
    ticket_satisfaction: {
      type: "ticket_satisfaction",
      title: "[Test] Customer feedback on #123 · Support request",
      body: "Test notification: the customer left a satisfaction rating."
    }
  },
  de: {
    ticket_commented: {
      type: "ticket_commented",
      title: "[Test] Neuer Kommentar zu #123 · Supportanfrage",
      body: "Test-Benachrichtigung: Ein Agent hat ein Ihnen zugewiesenes Ticket kommentiert."
    },
    ticket_assigned: {
      type: "ticket_assigned",
      title: "[Test] Zuweisung zu #123 · Supportanfrage",
      body: "Test-Benachrichtigung: Sie wurden diesem Ticket zugewiesen."
    },
    ticket_resolved: {
      type: "ticket_resolved",
      title: "[Test] #123 · Supportanfrage gelöst",
      body: "Test-Benachrichtigung: Das Ticket wurde als gelöst markiert."
    },
    ticket_created: {
      type: "ticket_created",
      title: "[Test] Neues Ticket #123 · Supportanfrage",
      body: "Test-Benachrichtigung: Ihnen wurde bei der Erstellung ein Ticket zugewiesen."
    },
    ticket_updated: {
      type: "ticket_updated",
      title: "[Test] #123 · Supportanfrage aktualisiert",
      body: "Test-Benachrichtigung: Das Ticket wurde geändert."
    },
    ticket_satisfaction: {
      type: "ticket_satisfaction",
      title: "[Test] Kundenfeedback zu #123 · Supportanfrage",
      body: "Test-Benachrichtigung: Der Kunde hat eine Zufriedenheitsbewertung hinterlassen."
    }
  },
  it: {
    ticket_commented: {
      type: "ticket_commented",
      title: "[Test] Nuovo commento su #123 · Richiesta supporto",
      body: "Notifica di test: un agente ha commentato un ticket a te assegnato."
    },
    ticket_assigned: {
      type: "ticket_assigned",
      title: "[Test] Assegnazione su #123 · Richiesta supporto",
      body: "Notifica di test: sei stato assegnato a questo ticket."
    },
    ticket_resolved: {
      type: "ticket_resolved",
      title: "[Test] #123 · Richiesta supporto risolto",
      body: "Notifica di test: il ticket è stato contrassegnato come risolto."
    },
    ticket_created: {
      type: "ticket_created",
      title: "[Test] Nuovo ticket #123 · Richiesta supporto",
      body: "Notifica di test: ti è stato assegnato un ticket alla creazione."
    },
    ticket_updated: {
      type: "ticket_updated",
      title: "[Test] #123 · Richiesta supporto aggiornato",
      body: "Notifica di test: il ticket è stato modificato."
    },
    ticket_satisfaction: {
      type: "ticket_satisfaction",
      title: "[Test] Feedback cliente su #123 · Richiesta supporto",
      body: "Notifica di test: il cliente ha lasciato una valutazione di soddisfazione."
    }
  },
  es: {
    ticket_commented: {
      type: "ticket_commented",
      title: "[Test] Nuevo comentario en #123 · Solicitud de soporte",
      body: "Notificación de prueba: un agente comentó un ticket que tiene asignado."
    },
    ticket_assigned: {
      type: "ticket_assigned",
      title: "[Test] Asignación en #123 · Solicitud de soporte",
      body: "Notificación de prueba: ha sido asignado a este ticket."
    },
    ticket_resolved: {
      type: "ticket_resolved",
      title: "[Test] #123 · Solicitud de soporte resuelto",
      body: "Notificación de prueba: el ticket se marcó como resuelto."
    },
    ticket_created: {
      type: "ticket_created",
      title: "[Test] Nuevo ticket #123 · Solicitud de soporte",
      body: "Notificación de prueba: se le asignó un ticket al crearlo."
    },
    ticket_updated: {
      type: "ticket_updated",
      title: "[Test] #123 · Solicitud de soporte actualizado",
      body: "Notificación de prueba: el ticket fue modificado."
    },
    ticket_satisfaction: {
      type: "ticket_satisfaction",
      title: "[Test] Opinión del cliente en #123 · Solicitud de soporte",
      body: "Notificación de prueba: el cliente dejó una valoración de satisfacción."
    }
  }
};
export function getTestNotificationSample(type = "ticket_commented", locale = "en") {
  const safeLocale = normalizeNotificationLocale(locale);
  const catalog = TEST_NOTIFICATION_SAMPLES[safeLocale] || TEST_NOTIFICATION_SAMPLES.en;
  const safeType = catalog[type] ? type : "ticket_commented";
  return catalog[safeType];
}
