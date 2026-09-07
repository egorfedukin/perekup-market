'use strict';
const categories = ['engine', 'chassis', 'body', 'electrics', 'tires', 'documents'];
function randomInspectionSkills(random = Math.random) {
  return Object.fromEntries(categories.map(category => [category, Math.floor(random() * 9)]));
}
function knownFaults(car) {
  const known = new Set([...(car.discovered || []), ...(car.publicDiscovered || [])]);
  return (car.defects || []).filter(defect => !defect.repaired && (known.has(defect.code) || car.serviceDiagnosed || car.saleType === 'auction'));
}
function npcFaults(car, bot) {
  return (car.defects || []).filter(defect => !defect.repaired && (bot.inspectionSkills?.[defect.category] ?? 0) >= Number(defect.skill || 0) + Number(defect.equipmentLevel || 0));
}
function saleBlockReason(car) {
  const faults = knownFaults(car);
  return faults.length ? `Сначала устраните известные неисправности: ${faults.map(defect => defect.name).join(', ')}. Продажа доступна после ремонта.` : null;
}
module.exports = { randomInspectionSkills, knownFaults, npcFaults, saleBlockReason };
