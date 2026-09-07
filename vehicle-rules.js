'use strict';
const { vehicleName } = require('./public/vehicle-names');

// Gameplay anchors, not a live appraisal feed. Explicit rules override imported make-wide defaults.
const profiles = [
  [/^Volkswagen ID[. -]?Buzz\b/i, 2022, 2026, 6500000],
  [/^Volkswagen ID[. -]?3\b/i, 2019, 2026, 3000000], [/^Volkswagen ID[. -]?[45]\b/i, 2020, 2026, 4200000],
  [/^Volkswagen ID[. -]?6\b/i, 2021, 2026, 4600000], [/^Volkswagen ID[. -]?7\b/i, 2023, 2026, 5000000],
  [/^Kia EV[- ]?6\b/i, 2021, 2026, 5200000], [/^Kia EV[- ]?9\b/i, 2023, 2026, 8500000],
  [/^Mazda EZ[- ]?60\b/i, 2025, 2026, 4000000], [/^Mazda EZ[- ]?6\b/i, 2024, 2026, 3200000],
  [/^Hyundai Staria\b/i, 2021, 2026, 5500000],
  [/^Haval Dargo X\b/i, 2023, 2026, 3700000], [/^Haval Dargo\b/i, 2020, 2026, 3300000],
  [/^Haval Jolion\b/i, 2020, 2026, 2500000], [/^Haval F7\b/i, 2018, 2026, 3200000],
  [/^Chery Tiggo 4\b/i, 2017, 2026, 2200000], [/^Chery Tiggo 7\b/i, 2016, 2026, 2800000],
  [/^Chery Tiggo 8\b/i, 2018, 2026, 3500000], [/^Chery Arrizo 8\b/i, 2022, 2026, 3200000],
  [/^BAIC Beijing BJ90\b/i, 2015, 2026, 9000000],
  [/^Avatr 07\b/i, 2024, 2026, 4800000], [/^Avatr 11\b/i, 2022, 2026, 6200000], [/^Avatr 12\b/i, 2023, 2026, 6500000],
  [/^Evolute i-PRO\b/i, 2022, 2026, 2300000], [/^Evolute i-JOY\b/i, 2022, 2026, 2800000],
  [/^Evolute i-SKY\b/i, 2023, 2026, 3400000], [/^Evolute i-SPACE\b/i, 2023, 2026, 3300000],
  [/^Evolute i-JET\b/i, 2024, 2026, 5000000], [/^Evolute i-VAN\b/i, 2022, 2026, 3000000],
  [/^LADA X Kross 5\b/i, 2023, 2024, 1900000], [/^LADA Granta\b/i, 2011, 2026, 1000000],
  [/^LADA Vesta\b/i, 2015, 2026, 1700000], [/^LADA Largus\b/i, 2012, 2026, 1400000],
  [/^BMW 1 Series.*\(E87\)/i, 2004, 2011, 4300000], [/^BMW 1 Series.*\(F20\)/i, 2011, 2019, 4600000],
  [/^BMW 1 Series.*\(F40\)/i, 2019, 2024, 4500000], [/^BMW 1 Series.*\(F70\)/i, 2024, 2026, 5000000],
  [/^BMW 3 Series.*\(E46\)/i, 1998, 2006, 4300000], [/^BMW 3 Series.*\(E9[0123]\)/i, 2005, 2013, 5100000],
  [/^BMW 3 Series.*\(F3[014]\)/i, 2011, 2019, 5800000], [/^BMW 3 Series.*\(G2[01]\)/i, 2018, 2026, 6800000],
  [/^Jaguar S-Type\b/i, 1999, 2008, 5500000], [/^Jaguar X-Type\b/i, 2001, 2009, 4300000]
];
const brandStartYears = { Avatr: 2022, Evolute: 2022, Zeekr: 2021, Xiaomi: 2024, Aito: 2021, Voyah: 2021, Nio: 2016, Xpeng: 2016, Omoda: 2022, Jaecoo: 2023, Exeed: 2017, Tank: 2021, Li: 2019 };
function vehicleRule(model) {
  const name = vehicleName(model);
  const match = profiles.find(([pattern]) => pattern.test(name));
  const rule = match ? { startYear: match[1], endYear: match[2], referencePrice: match[3] } : {};
  if (/^BMW 1 Series.*F40|^Jaguar [SX]-Type/i.test(name)) rule.collectible = false;
  const make = name.split(' ')[0];
  if (!rule.startYear && brandStartYears[make]) Object.assign(rule, { startYear: brandStartYears[make], endYear: 2026 });
  const modernYears = { 'Li Auto L6': 2024, 'Li Auto L7': 2023, 'Li Auto L9': 2022, 'Zeekr 007': 2023, 'Zeekr 009': 2022, 'Zeekr 7X': 2024, 'Zeekr 8X': 2026, 'Zeekr 9X': 2025, 'Zeekr X': 2023, 'Tank 300': 2020, 'Tank 400': 2023, 'Tank 500': 2021, 'Tank 700': 2024, 'Omoda C7': 2025, 'Omoda S5': 2023, 'Omoda S5 GT': 2023 };
  if (modernYears[name]) rule.startYear = modernYears[name];
  return rule;
}
module.exports = { vehicleRule, vehicleName };
