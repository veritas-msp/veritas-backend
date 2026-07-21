import { getMonitoringRunbooks } from "../utils/monitoringAutomationConfig.js";
import { getCriterionLabel } from "./monitoringTicketAssignment.js";
export async function resolveRunbookForCriterion(criterionKey) {
  const runbooks = await getMonitoringRunbooks();
  return (Array.isArray(runbooks) ? runbooks : []).find(rb => rb.enabled !== false && rb.criterionKey === criterionKey) || null;
}
export function buildRunbookComment(runbook, {
  criterionKey,
  equipmentName,
  aiNotes = null,
  locale = "en"
}) {
  if (!runbook) return null;
  const code = String(locale || "en").toLowerCase().slice(0, 2);
  const labels = {
    en: {
      header: "📋 Monitoring runbook",
      aiContext: "AI context",
      checklist: "Checklist",
      docs: "Documentation",
      equipment: "Equipment"
    },
    de: {
      header: "📋 Überwachungs-Runbook",
      aiContext: "KI-Kontext",
      checklist: "Checkliste",
      docs: "Dokumentation",
      equipment: "Gerät"
    },
    it: {
      header: "📋 Runbook di monitoraggio",
      aiContext: "Contesto IA",
      checklist: "Checklist",
      docs: "Documentazione",
      equipment: "Apparecchiatura"
    },
    es: {
      header: "📋 Runbook de supervisión",
      aiContext: "Contexto IA",
      checklist: "Checklist",
      docs: "Documentación",
      equipment: "Equipo"
    },
    fr: {
      header: "📋 Runbook de surveillance",
      aiContext: "Contexte IA",
      checklist: "Checklist",
      docs: "Documentation",
      equipment: "Équipement"
    }
  }[code] || {
    header: "📋 Monitoring runbook",
    aiContext: "AI context",
    checklist: "Checklist",
    docs: "Documentation",
    equipment: "Equipment"
  };
  const lines = [labels.header, "", runbook.title || getCriterionLabel(criterionKey), ""];
  if (aiNotes) {
    lines.push(`${labels.aiContext} : ${aiNotes}`);
    lines.push("");
  }
  const checklist = Array.isArray(runbook.checklist) ? runbook.checklist : [];
  if (checklist.length) {
    lines.push(`${labels.checklist} :`);
    checklist.forEach((step, index) => {
      lines.push(`${index + 1}. ${step}`);
    });
    lines.push("");
  }
  const docLinks = Array.isArray(runbook.docLinks) ? runbook.docLinks.filter(l => l?.url) : [];
  if (docLinks.length) {
    lines.push(`${labels.docs} :`);
    docLinks.forEach(link => {
      lines.push(`- ${link.label || link.url}: ${link.url}`);
    });
    lines.push("");
  }
  if (equipmentName) {
    lines.push(`${labels.equipment} : ${equipmentName}`);
  }
  return lines.join("\n");
}
export function resolveRunbookTicketPriority(runbook, fallback = "normal") {
  const p = String(runbook?.priority || "").toLowerCase();
  if (["low", "normal", "high", "urgent"].includes(p)) return p;
  return fallback;
}
export function resolveRunbookTags(runbook) {
  return Array.isArray(runbook?.tags) ? runbook.tags.filter(Boolean) : [];
}
