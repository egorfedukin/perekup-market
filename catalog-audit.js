'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { vehicleName, vehicleRule } = require('./vehicle-rules');

// Evaluate the production catalog builder without starting HTTP or opening player storage.
const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const start = source.indexOf('const realVehicleSeeds =');
const end = source.indexOf('let marketStatsCache =');
assert.ok(start > 0 && end > start);
const result = vm.runInNewContext(source.slice(start, end) + '\n({ vehicleModels, catalog })', {
  fs, path, crypto: require('node:crypto'), __dirname, vehicleName, vehicleRule
});
const { vehicleModels, catalog } = result;
const examples = {
  'Lada Grantahybrid': 'LADA Granta Hybrid',
  'Lada 2151classic': 'LADA 2151 Classic',
  'BMW 2activetourer': 'BMW 2 Active Tourer',
  'Mercedes-Benz mercedes benz a class hatchback': 'Mercedes-Benz A-Class Hatchback',
  'Evolute i sky': 'Evolute i-SKY',
  'Acura Rdx': 'Acura RDX'
};
for (const [raw, expected] of Object.entries(examples)) assert.equal(vehicleName(raw), expected);
for (const model of vehicleModels) {
  assert.equal(vehicleName(vehicleName(model.model)), vehicleName(model.model), `Stable name: ${model.model}`);
  assert.ok(Number.isFinite(model.currentBase) && model.currentBase >= 60000 && model.currentBase <= 2000000000, model.model);
  assert.ok(model.startYear <= model.endYear && model.endYear <= 2026, model.model);
}
for (const car of catalog) {
  assert.ok(Number.isInteger(car.base) && car.base >= 60000 && car.base <= 2000000000, car.model);
  const rule = vehicleRule(car.model);
  if (rule.startYear) assert.ok(car.year >= rule.startYear && car.year <= rule.endYear, car.model);
  if (rule.collectible === false) assert.equal(car.collectible, false);
}
const review = vehicleModels.filter(model => Object.keys(vehicleRule(model.model)).length).map(model => {
  const values = catalog.filter(car => car.model === model.model);
  return { model: vehicleName(model.model), startYear: model.startYear, endYear: model.endYear, collectible: model.collectible,
    minBase: Math.min(...values.map(car => car.base)), maxBase: Math.max(...values.map(car => car.base)) };
});
const report = { models: vehicleModels.length, variants: catalog.length, renamed: vehicleModels.filter(model => model.model !== vehicleName(model.model)).length, reviewedRules: review,
  limitation: 'Gameplay price anchors; no live market-price feed. Unreviewed production metadata remains approximate.' };
if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
