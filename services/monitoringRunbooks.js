import { getMonitoringRunbooks } from "../utils/monitoringAutomationConfig.js";
import { getCriterionLabel } from "./monitoringTicketAssignment.js";

export async function resolveRunbookForCriterion(criterionKey) {
  const runbooks = await getMonitoringRunbooks();
  return (Array.isArray(runbooks) ? runbooks : []).find(
    (rb) => rb.enabled !== false && rb.criterionKey === criterionKey
  ) || null;
}

export function buildRunbookComment(runbook, { criterionKey, equipmentName, aiNotes = null }) {
  if (!runbook) return null;

  const lines = [
    "📋 Runbook de surveillance",
    "",
    runbook.title || getCriterionLabel(criterionKey),
    "",
  ];

  if (aiNotes) {
    lines.push(`Contexte IA : ${aiNotes}`);
    lines.push("");
  }

  const checklist = Array.isArray(runbook.checklist) ? runbook.checklist : [];
  if (checklist.length) {
    lines.push("Checklist :");
    checklist.forEach((step, index) => {
      lines.push(`${index + 1}. ${step}`);
    });
    lines.push("");
  }

  const docLinks = Array.isArray(runbook.docLinks) ? runbook.docLinks.filter((l) => l?.url) : [];
  if (docLinks.length) {
    lines.push("Documentation :");
    docLinks.forEach((link) => {
      lines.push(`- ${link.label || link.url}: ${link.url}`);
    });
    lines.push("");
  }

  if (equipmentName) {
    lines.push(`Équipement : ${equipmentName}`);
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
