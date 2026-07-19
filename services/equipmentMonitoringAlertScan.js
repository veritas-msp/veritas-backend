import {
  getMonitoringAutomationConfig,
} from "../utils/monitoringAutomationConfig.js";
import {
  getEvaluationThresholdsFromRules,
  getOfflineAlertThresholdMinutesFromRules,
  getSupervisionAlertRules,
} from "../utils/supervisionAlertRules.js";
import { loadSupervisionEquipmentInventory } from "../utils/equipmentInventoryScan.js";
import { evaluateInventoryItem } from "./equipmentMonitoringAlertDispatcher.js";

/**
 * Scan the whole supervisable fleet and evaluate all SUPERVISION_ALERT_CRITERIA.
 */
export async function runEquipmentMonitoringAlertScan() {
  await getMonitoringAutomationConfig();
  const rules = await getSupervisionAlertRules();
  const offlineAlertThresholdMinutes = getOfflineAlertThresholdMinutesFromRules(rules);
  const inventory = await loadSupervisionEquipmentInventory();

  let evaluated = 0;
  let created = 0;
  let resolved = 0;

  for (const item of inventory) {
    evaluated += 1;
    const thresholds = getEvaluationThresholdsFromRules(item.equipmentFamily, rules);
    const result = await evaluateInventoryItem(item, {
      offlineAlertThresholdMinutes,
      thresholds,
      rules,
    });
    created += result?.created || 0;
    resolved += Array.isArray(result?.resolved) ? result.resolved.length : 0;
  }

  return { evaluated, created, resolved };
}
