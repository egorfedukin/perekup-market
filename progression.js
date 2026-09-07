"use strict";

const prerequisites = { engineRepair: "mechanics", chassisRepair: "mechanics", tireService: "mechanics", negotiation: "appraisal", tuning: "bodywork", propertyManagement: "propertyAppraisal" };
function requiredSkillLevel(level) { return Math.min(3, Math.floor(level / 2) + 1); }
function workplaceBenefits(player) {
  const result = { repair: 0, parts: 0, negotiation: 0, sales: 0 };
  const roles = { workshop: "repair", parts: "parts", negotiation: "negotiation", showroom: "sales", premium_showroom: "sales" };
  for (const asset of player?.ownedAssets || []) {
    const role = roles[asset.propertyRole];
    if (!role || asset.rentalStatus !== "workplace") continue;
    result[role] += .025 * (1 + (asset.workplaceLevel || 0)) * Math.max(0, Math.min(100, asset.maintenance ?? 100)) / 100;
  }
  for (const key of Object.keys(result)) result[key] = Math.min(.15, result[key]);
  return result;
}
function npcProfile(bot) {
  const profiles = {
    specialist: { interests: ["sport", "utility"], riskTolerance: 80, maxAge: 30, patience: 3 },
    endBuyer: { interests: ["comfort", "utility"], riskTolerance: 25, maxAge: 12, patience: 2 },
    budget: { interests: ["utility"], riskTolerance: 60, maxAge: 24, patience: 2 },
    dealer: { interests: ["utility", "comfort"], riskTolerance: 70, maxAge: 18, patience: 3 },
    collector: { interests: ["classic"], riskTolerance: 35, maxAge: 100, patience: 2 }
  };
  return { ...profiles[bot.type], budget: bot.budget, name: bot.name, type: bot.type };
}
function npcFit(car, bot, upgrades, year = new Date().getFullYear()) {
  const profile = npcProfile(bot);
  const repairs = (car.defects || []).filter(d => d.repaired);
  const reliability = repairs.length ? repairs.reduce((sum, d) => sum + (d.repairReliability ?? 88), 0) / repairs.length : 100;
  const risk = (100 - reliability) / 100 * (1 - profile.riskTolerance / 100);
  const agePenalty = Math.min(.14, Math.max(0, year - car.year - profile.maxAge) * .006);
  const tuning = upgrades.filter(u => (car.upgrades || []).includes(u.key)).reduce((sum, u) => sum + (profile.interests.includes(u.profile) ? .025 : u.profile === "sport" ? -.045 : -.008), 0);
  return { profile, reliability, multiplier: Math.max(.5, 1 + Math.min(.1, tuning) - risk - agePenalty) };
}
function negotiate({ amount, current, ceiling, skill = 0, office = 0, relationship = 0, attempts = 0, patience = 2 }) {
  const limit = Math.min(ceiling, Math.round(current * (1.035 + skill * .009 + office + Math.max(-10, Math.min(10, relationship)) * .002)));
  return { accepted: amount <= limit, limit, exhausted: attempts + 1 >= patience, relationshipDelta: amount <= limit ? 1 : amount > ceiling * 1.15 ? -2 : -1 };
}
module.exports = { prerequisites, requiredSkillLevel, workplaceBenefits, npcProfile, npcFit, negotiate };
