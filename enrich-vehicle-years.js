const fs = require("fs");
const path = require("path");

const catalogFile = path.join(__dirname, "vehicle-catalog.tsv");
const outputFile = path.join(__dirname, "vehicle-production-years.json");
const userAgent = "PerekupMarketCatalog/3.0 (game catalog enrichment)";
const lines = fs.readFileSync(catalogFile, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
const headers = lines.shift().split("\t");
const modelIndex = headers.indexOf("АВТОМОБИЛЬ");
const sourceIndex = headers.indexOf("ИСТОЧНИК");
const rows = lines.map((line) => {
  const cells = line.split("\t");
  return { model: cells[modelIndex], qid: String(cells[sourceIndex] || "").match(/Q\d+/)?.[0] || "" };
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": userAgent, Accept: "application/json" } });
      if (response.ok) return response.json();
      lastError = new Error(`HTTP ${response.status}: ${url}`);
      if (response.status !== 429 && response.status < 500) throw lastError;
    } catch (error) {
      lastError = error;
    }
    await sleep(attempt * 5000);
  }
  throw lastError || new Error(`Service unavailable: ${url}`);
}

function extractYears(text) {
  const plain = String(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 1800);
  const patterns = [
    /(?:produced|manufactured|built|production|made|sold|marketed|assembled)[^.!?]{0,220}?(18\d{2}|19\d{2}|20[0-2]\d)\s*(?:–|—|-|to|until|through)\s*(18\d{2}|19\d{2}|20[0-2]\d|present)/i,
    /(?:introduced|launched|debuted)[^.!?]{0,160}?(18\d{2}|19\d{2}|20[0-2]\d)/i,
    /\b(18\d{2}|19\d{2}|20[0-2]\d)\s*(?:–|—|-|to)\s*(18\d{2}|19\d{2}|20[0-2]\d|present)\b/i,
  ];
  for (const pattern of patterns) {
    const match = plain.match(pattern);
    if (!match) continue;
    const startYear = Number(match[1]);
    const endYear = String(match[2] || "").toLowerCase() === "present" ? 2026 : Number(match[2] || startYear + 8);
    if (startYear >= 1885 && startYear <= 2026 && endYear >= startYear && endYear <= 2026) return { startYear, endYear };
  }
  return null;
}

function extractInfoboxYears(text) {
  const field = String(text || "").match(/\|\s*(?:production|model_years?|assembly_years?)\s*=\s*([^\n]{1,500})/i)?.[1] || "";
  const cleaned = field.replace(/<ref[\s\S]*?<\/ref>|<ref[^>]*\/\s*>/gi, " ").replace(/\{\{[^{}]*\}\}/g, " ");
  const matches = [...cleaned.matchAll(/\b(18\d{2}|19\d{2}|20[0-2]\d)\b/g)].map((match) => Number(match[1]));
  if (!matches.length) return null;
  const startYear = Math.min(...matches);
  const present = /present|current/i.test(cleaned);
  const endYear = present ? 2026 : Math.max(...matches, startYear);
  return startYear >= 1885 && endYear >= startYear && endYear <= 2026 ? { startYear, endYear } : null;
}

async function main() {
  const titleByQid = {};
  const qids = rows.map((row) => row.qid).filter(Boolean);
  for (let start = 0; start < qids.length; start += 50) {
    const batch = qids.slice(start, start + 50);
    const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${batch.join("|")}&props=sitelinks&sitefilter=enwiki&format=json&origin=*`;
    const payload = await fetchJson(url);
    Object.values(payload.entities || {}).forEach((entity) => { if (entity.sitelinks?.enwiki?.title) titleByQid[entity.id] = entity.sitelinks.enwiki.title; });
    await sleep(250);
  }

  const rowByTitle = new Map(rows.map((row) => [titleByQid[row.qid], row]).filter(([title]) => title));
  const titles = [...rowByTitle.keys()];
  const years = {};
  for (let start = 0; start < titles.length; start += 20) {
    const batch = titles.slice(start, start + 20);
    const params = new URLSearchParams({ action: "query", prop: "extracts", exintro: "1", explaintext: "1", redirects: "1", titles: batch.join("|"), format: "json", origin: "*" });
    const payload = await fetchJson(`https://en.wikipedia.org/w/api.php?${params}`);
    Object.values(payload.query?.pages || {}).forEach((page) => {
      const row = rowByTitle.get(page.title) || rows.find((item) => titleByQid[item.qid] === page.title);
      const result = extractYears(page.extract);
      if (row && result) years[row.model] = result;
    });
    process.stdout.write(`${Math.min(start + 20, titles.length)}/${titles.length}\n`);
    await sleep(300);
  }
  const missingTitles = titles.filter((title) => {
    const row = rowByTitle.get(title);
    return row && !years[row.model];
  });
  for (let start = 0; start < missingTitles.length; start += 10) {
    const batch = missingTitles.slice(start, start + 10);
    const params = new URLSearchParams({ action: "query", prop: "revisions", rvprop: "content", rvslots: "main", redirects: "1", titles: batch.join("|"), format: "json", origin: "*" });
    const payload = await fetchJson(`https://en.wikipedia.org/w/api.php?${params}`);
    Object.values(payload.query?.pages || {}).forEach((page) => {
      const row = rowByTitle.get(page.title) || rows.find((item) => titleByQid[item.qid] === page.title);
      const result = extractInfoboxYears(page.revisions?.[0]?.slots?.main?.["*"]);
      if (row && result) years[row.model] = result;
    });
    process.stdout.write(`Infobox ${Math.min(start + 10, missingTitles.length)}/${missingTitles.length}\n`);
    await sleep(300);
  }
  fs.writeFileSync(outputFile, `${JSON.stringify(years, null, 2)}\n`, "utf8");
  console.log(`Models: ${rows.length}; Wikipedia pages: ${titles.length}; production years found: ${Object.keys(years).length}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
