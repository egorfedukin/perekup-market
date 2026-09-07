"use strict";
function acquisitionPrice({ value, restorationValue, repairCost, kind, unit = .5 }) {
  const ranges = { urgent: [.78, .86], project: [.72, .83], fair: [.90, 1.02], optimistic: [1.06, 1.16] };
  const [low, high] = ranges[kind] || ranges.fair;
  let price = value * (low + Math.max(0, Math.min(1, unit)) * (high - low));
  // Restoration projects leave room for workshop expenses, but not every listing is a bargain.
  if (kind === "project" || kind === "urgent") price = Math.min(price, Math.max(value * .72, restorationValue * .9 - repairCost));
  return Math.min(2000000000, Math.max(1000, Math.round(price / 1000) * 1000));
}
function buyerPrice({ value, fit, type, unknownCount, lied, relationship = 0, repaired = false, classic = false }) {
  const base = { specialist: 1.04, endBuyer: 1.08, budget: 1.01, dealer: .92, collector: classic ? 1.13 : .98 }[type] || 1;
  return Math.min(2000000000, Math.max(1000, Math.round(value * Math.max(.65, base * fit + (repaired ? .035 : 0) - Math.min(.045, unknownCount * .009) - (lied ? .07 : 0) + Math.max(-10, Math.min(10, relationship)) * .003) / 1000) * 1000));
}
module.exports = { acquisitionPrice, buyerPrice };
