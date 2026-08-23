const $ = (selector) => document.querySelector(selector);
const money = (value) => `${new Intl.NumberFormat("ru-RU").format(value)} ₽`;
const number = (value) => new Intl.NumberFormat("ru-RU").format(value);
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));

const categoryNames = { engine: "Двигатель", chassis: "Ходовая", body: "Кузов", electrics: "Электрика", tires: "Шины и колёса", documents: "Документы и VIN" };
const severityNames = { 1: "незначительно", 2: "серьёзно", 3: "критично" };
const vehicleClassNames = { classic: "Классика", hatch: "Хэтчбек", sedan: "Седан", suv: "Кроссовер / SUV", coupe: "Купе", van: "Фургон", electric: "Электромобиль", premium: "Премиум", wagon: "Универсал", pickup: "Пикап", roadster: "Родстер" };
const supporterTierNames = { bronze: "Бронза", silver: "Серебро", gold: "Золото", platinum: "Платина", founder: "Партнёр" };
const carPhotoCache = new Map();
const CAR_PHOTO_CACHE_KEY = "perekup-commons-photos-v3";
let storedCarPhotos = {};
try { storedCarPhotos = JSON.parse(localStorage.getItem(CAR_PHOTO_CACHE_KEY) || "{}"); } catch { storedCarPhotos = {}; }
let token = localStorage.getItem("perekup-token") || "";
let state = { player: null, market: [], leaderboard: [], skillInfo: {}, equipmentInfo: {}, marketStats: {}, inspectionCategories: [], inspectionRequirements: {}, chatMessages: [] };
let marketFilters = { query: "", min: null, max: null, saleType: "all", className: "all", condition: "all", priceBand: "all", sort: "new", fresh: false };
let marketVisibleCount = 24;
let modalCarId = null;
let modalMode = null;
let lastCheckResult = null;
let events = null;
let toastTimer = null;
const pendingActions = new Set();
let adminState = null;
let shownRewardId = null;
let shownNotificationId = null;
let partsMode = "needs";
let partsFilters = { component: "all", quality: "all", query: "" };
let partsCarFilter = "all";
let auctionFilters = { condition: "all", max: null, seller: "all", sort: "ending" };
let assetFilters = { type: "all", category: "all", min: null, max: null, sort: "deal" };
let assetMode = "all";
const renderSignatures = { market: "", auctions: "" };
let modalContentSignature = "";
let activeChallenge = null;
let renderTimer = null;

function photoTokens(value) {
  return String(value).toLocaleLowerCase("en-US").replace(/[^a-z0-9а-яё]+/giu, " ").trim().split(/\s+/).filter((token) => token.length > 1);
}

function photoCandidateScore(page, query) {
  const title = String(page.title || "").replace(/^File:/i, "").toLocaleLowerCase("en-US");
  const metadata = page.imageinfo?.[0]?.extmetadata || {};
  const description = `${metadata.ImageDescription?.value || ""} ${metadata.ObjectName?.value || ""}`.replace(/<[^>]+>/g, " ").toLocaleLowerCase("en-US");
  const haystack = `${title} ${description}`;
  const tokens = photoTokens(query);
  const blocked = /\b(logo|badge|emblem|interior|cabin|cockpit|dashboard|instrument|cluster|console|steering|seat|upholstery|trunk|boot|engine|motor|wheel|rim|drawing|diagram|render|concept|toy|model car|police|emergency|ambulance|fire truck|military|security|rosgvard|росгвард|полици|мигалк|wreck|accident|cutaway|brochure|салон|панель|сиденье|двигател)\b/i;
  const info = page.imageinfo?.[0];
  const width = Number(info?.width || 0); const height = Number(info?.height || 0);
  if (width < 500 || height < 300 || width / Math.max(1, height) < 1.12) return -1;
  if (!page.imageinfo?.[0]?.thumburl || blocked.test(haystack) || !tokens.length) return -1;
  const matched = tokens.filter((token) => haystack.includes(token));
  if (!title.includes(tokens[0]) || matched.length < Math.min(2, tokens.length)) return -1;
  let score = matched.length * 4 + (tokens.every((token) => title.includes(token)) ? 10 : 0);
  if (/image\/jpeg|image\/webp/i.test(page.imageinfo[0].mime || "")) score += 3;
  if (/\b(front|rear|side|sedan|hatchback|suv|coupe|wagon|car|automobile)\b/i.test(haystack)) score += 2;
  return score;
}

async function resolveCarPhoto(query) {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) return null;
  if (Object.prototype.hasOwnProperty.call(storedCarPhotos, normalizedQuery)) return storedCarPhotos[normalizedQuery];
  if (carPhotoCache.has(normalizedQuery)) return carPhotoCache.get(normalizedQuery);
  const task = (async () => {
    try {
      const params = new URLSearchParams({
        action: "query", generator: "search", gsrnamespace: "6", gsrsearch: `intitle:\"${normalizedQuery}\" filetype:bitmap`, gsrlimit: "12",
        prop: "imageinfo", iiprop: "url|extmetadata|mime|size", iiurlwidth: "900", origin: "*", format: "json"
      });
      const response = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`);
      if (!response.ok) throw new Error("Wikimedia Commons unavailable");
      const payload = await response.json();
      const usedUrls = new Set(Object.values(storedCarPhotos).filter(Boolean).map((photo) => photo?.url).filter(Boolean));
      const candidates = Object.values(payload.query?.pages || {}).map((page) => ({ page, score: photoCandidateScore(page, normalizedQuery) })).filter((item) => item.score >= 8 && !usedUrls.has(item.page.imageinfo?.[0]?.thumburl)).sort((a, b) => b.score - a.score);
      const selected = candidates[0]?.page;
      if (!selected) return null;
      const info = selected.imageinfo[0];
      const metadata = info.extmetadata || {};
      return {
        url: info.thumburl,
        source: info.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(selected.title.replace(/ /g, "_"))}`,
        author: String(metadata.Artist?.value || "").replace(/<[^>]+>/g, " ").trim(),
        license: metadata.LicenseShortName?.value || "Wikimedia Commons"
      };
    } catch { return undefined; }
  })();
  carPhotoCache.set(normalizedQuery, task);
  const result = await task;
  if (result !== undefined) {
    storedCarPhotos[normalizedQuery] = result;
    try { localStorage.setItem(CAR_PHOTO_CACHE_KEY, JSON.stringify(storedCarPhotos)); } catch { /* Cache is optional. */ }
  }
  return result;
}

function hydrateCarPhotos(root = document) {
  root.querySelectorAll("img[data-car-photo]:not([data-photo-loading])").forEach((image) => {
    image.dataset.photoLoading = "true";
    const load = async () => {
      const art = image.closest(".car-art");
      const directUrl = image.dataset.photoUrl;
      const photo = directUrl ? { url: directUrl, source: image.dataset.photoSource || directUrl, license: "Источник фото" } : await resolveCarPhoto(image.dataset.carPhoto);
      if (!photo) { image.hidden = true; art?.classList.add("photo-failed"); return; }
      image.onload = () => {
        art?.classList.add("photo-loaded");
        const credit = art?.querySelector(".photo-credit");
        if (credit) { credit.href = photo.source; credit.textContent = photo.license || "Wikimedia Commons"; credit.hidden = false; }
      };
      image.onerror = () => { image.hidden = true; art?.classList.add("photo-failed"); };
      image.src = photo.url;
    };
    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { observer.disconnect(); load(); } }, { rootMargin: "240px" });
      observer.observe(image);
    } else load();
  });
}

function loadExternalScript(id, src, attributes = {}) {
  if (document.getElementById(id)) return;
  const script = document.createElement("script");
  script.id = id; script.src = src; script.async = true;
  Object.entries(attributes).forEach(([key, value]) => script.setAttribute(key, value));
  document.head.append(script);
}

function initAds() {
  const ads = window.PEREKUP_CONFIG?.ads || {};
  const placements = [["ad-market", ads.marketSlot], ["ad-garage", ads.garageSlot]].filter(([, blockId]) => blockId);
  if (!ads.provider || !placements.length) return;
  if (ads.provider === "yandex") {
    window.yaContextCb = window.yaContextCb || [];
    loadExternalScript("yandex-ad-script", "https://yandex.ru/ads/system/context.js");
    placements.forEach(([containerId, blockId]) => {
      const container = document.getElementById(containerId);
      if (!container) return;
      const renderId = `${containerId}-network`;
      container.hidden = false;
      container.innerHTML = `<span class="ad-label">Реклама</span><div id="${renderId}" class="ad-network"></div>`;
      window.yaContextCb.push(() => window.Ya?.Context?.AdvManager?.render({ blockId, renderTo: renderId }));
    });
  }
  if (ads.provider === "adsense" && /^ca-pub-\d+$/.test(ads.adsenseClient || "")) {
    loadExternalScript("adsense-script", `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(ads.adsenseClient)}`, { crossorigin: "anonymous" });
    placements.forEach(([containerId, slot]) => {
      const container = document.getElementById(containerId);
      if (!container) return;
      container.hidden = false;
      container.innerHTML = `<span class="ad-label">Реклама</span><ins class="adsbygoogle ad-network" style="display:block" data-ad-client="${escapeHtml(ads.adsenseClient)}" data-ad-slot="${escapeHtml(slot)}" data-ad-format="auto" data-full-width-responsive="true"></ins>`;
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    });
  }
}

function carArt(car, extraClass = "") {
  const query = car.photoQuery || car.model;
  const cached = car.photoUrl ? { url: car.photoUrl, source: car.photoSource || car.photoUrl, license: "Источник фото" } : storedCarPhotos[query];
  const ready = cached && cached.url;
  const unavailable = cached === null;
  return `<div class="car-art vehicle-${escapeHtml(car.className)} ${extraClass} ${ready ? "photo-loaded" : unavailable ? "photo-failed" : ""}" style="--car-color:${escapeHtml(car.color)}">
    <img class="car-photo" data-car-photo="${escapeHtml(query)}" data-photo-url="${escapeHtml(car.photoUrl || "")}" data-photo-source="${escapeHtml(car.photoSource || "")}" ${unavailable ? 'data-photo-loading="true"' : ""} ${ready ? `src="${escapeHtml(cached.url)}"` : ""} ${unavailable ? "hidden" : ""} alt="${escapeHtml(car.model)}, ${car.year}" loading="lazy" referrerpolicy="no-referrer">
    <span class="photo-placeholder"><b>${escapeHtml(car.make || car.model.split(" ")[0])}</b><small>Фото модели не найдено</small></span>
    <a class="photo-credit" data-photo-source href="${ready ? escapeHtml(cached.source) : "#"}" target="_blank" rel="noopener noreferrer" ${ready ? "" : "hidden"}>${ready ? escapeHtml(cached.license || "Wikimedia Commons") : "Wikimedia Commons"}</a>
    <span class="car-year">${car.year}</span><span class="seller-label">${escapeHtml(car.seller || "Гараж")}</span>
  </div>`;
}

function conditionLabel(value) {
  if (value >= 72) return ["Хорошее", ""];
  if (value >= 52) return ["Есть нюансы", "mid"];
  return ["Требует внимания", "low"];
}

function repairChallengeFor(defect) {
  const scenarios = {
    engine: [
      ["Остудить узел", "Снять кожух", "Заменить деталь", "Проверить запуск"],
      ["Слить жидкость", "Открутить крепёж", "Установить замену", "Проверить герметичность"]
    ],
    chassis: [
      ["Поднять автомобиль", "Снять колесо", "Заменить узел", "Затянуть крепёж"],
      ["Зафиксировать машину", "Ослабить крепёж", "Установить деталь", "Проверить люфт"]
    ],
    electrics: [
      ["Снять клемму", "Найти цепь", "Заменить элемент", "Проверить питание"],
      ["Отключить питание", "Разъединить разъём", "Установить деталь", "Стереть ошибку"]
    ],
    body: [
      ["Очистить участок", "Снять повреждённое", "Восстановить форму", "Защитить покрытие"]
    ],
    tires: [
      ["Ослабить болты", "Поднять автомобиль", "Заменить колесо", "Затянуть крест-накрест"]
    ],
    documents: [
      ["Сверить VIN", "Проверить документы", "Запросить историю", "Зафиксировать результат"]
    ]
  };
  const variants = scenarios[defect?.category] || scenarios.engine;
  return variants[Math.abs(String(defect?.code || "repair").split("").reduce((sum, char) => sum + char.charCodeAt(0), 0)) % variants.length];
}

function timingChallenge({ title, task, rounds = 1, mode = "timing", actions = null }) {
  if (activeChallenge) return Promise.reject(new Error("Завершите текущее действие"));
  const root = $("#skill-challenge");
  let round = 0;
  let scores = [];
  let frame = 0;
  let startedAt = 0;
  let target = 35;
  let targetWidth = 18;
  return new Promise((resolve) => {
    const finish = () => {
      cancelAnimationFrame(frame);
      const score = Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length);
      root.innerHTML = `<div class="challenge-panel challenge-result"><p class="eyebrow">Работа завершена</p><h2>${escapeHtml(title)}</h2><strong class="challenge-score ${score >= 80 ? "great" : score < 45 ? "poor" : ""}">${score}%</strong><p>${score >= 88 ? "Точная работа. Получен бонус к результату." : score >= 65 ? "Хороший результат без лишних потерь." : "Результат принят, но точность можно улучшить."}</p><button class="primary-button" data-challenge-done>Продолжить</button></div>`;
      root.querySelector("[data-challenge-done]").onclick = () => { root.hidden = true; root.innerHTML = ""; activeChallenge = null; resolve(score); };
    };
    const completeRound = (score) => {
      scores.push(Math.max(0, Math.min(100, Math.round(score))));
      setTimeout(round < rounds ? renderRound : finish, 380);
    };
    const renderRound = () => {
      round += 1;
      if (mode === "sequence" || mode === "repair") {
        const baseSequence = actions || ["Масло", "Фильтр", "Момент", "Проверка"];
        const sequence = baseSequence.slice().sort(() => Math.random() - 0.5);
        let next = 0;
        root.innerHTML = `<div class="challenge-panel"><div class="challenge-head"><div><p class="eyebrow">${escapeHtml(task)} · этап ${round}/${rounds}</p><h2>${escapeHtml(title)}</h2></div><button class="icon-button" data-challenge-cancel aria-label="Отменить">×</button></div><p class="challenge-instruction">${mode === "repair" ? "Выберите действия в правильном порядке: подготовить, снять, установить, проверить." : "Нажмите этапы в правильном порядке."}</p><div class="sequence-grid">${sequence.map((item, index) => `<button class="sequence-step" data-sequence-index="${index}">${escapeHtml(item)}</button>`).join("")}</div><div class="challenge-progress">${Array.from({ length: rounds }, (_, index) => `<i class="${index < scores.length ? "done" : index === scores.length ? "active" : ""}"></i>`).join("")}</div></div>`;
        root.hidden = false;
        root.querySelector("[data-challenge-cancel]").onclick = () => { root.hidden = true; root.innerHTML = ""; activeChallenge = null; resolve(null); };
        root.querySelectorAll("[data-sequence-index]").forEach((button) => button.onclick = () => {
          const expected = baseSequence[next];
          if (button.textContent === expected) { button.classList.add("hit"); next += 1; if (next === 4) completeRound(100); }
          else { button.classList.add("miss"); completeRound(35); }
        });
        return;
      }
      if (mode === "choice") {
        const target = Math.floor(Math.random() * 3);
        const options = ["Сбить 12%", "Сбить 5%", "Взять без торга"];
        root.innerHTML = `<div class="challenge-panel"><div class="challenge-head"><div><p class="eyebrow">${escapeHtml(task)} · этап ${round}/${rounds}</p><h2>${escapeHtml(title)}</h2></div><button class="icon-button" data-challenge-cancel aria-label="Отменить">×</button></div><p class="challenge-instruction">Выберите тактику, которая лучше подходит к настроению продавца.</p><div class="choice-grid">${options.map((item, index) => `<button class="choice-card" data-choice-index="${index}"><strong>${escapeHtml(item)}</strong><small>${index === 0 ? "Риск отказа выше" : index === 1 ? "Баланс цены и сделки" : "Сделка закрывается быстро"}</small></button>`).join("")}</div><div class="challenge-progress">${Array.from({ length: rounds }, (_, index) => `<i class="${index < scores.length ? "done" : index === scores.length ? "active" : ""}"></i>`).join("")}</div></div>`;
        root.hidden = false;
        root.querySelector("[data-challenge-cancel]").onclick = () => { root.hidden = true; root.innerHTML = ""; activeChallenge = null; resolve(null); };
        root.querySelectorAll("[data-choice-index]").forEach((button) => button.onclick = () => completeRound(Number(button.dataset.choiceIndex) === target ? 100 : 58));
        return;
      }
      if (mode === "risk") {
        const target = Math.floor(Math.random() * 3);
        const options = ["Сохранить деньги", "Вложиться сбалансированно", "Пойти ва-банк"];
        root.innerHTML = `<div class="challenge-panel"><div class="challenge-head"><div><p class="eyebrow">${escapeHtml(task)} · этап ${round}/${rounds}</p><h2>${escapeHtml(title)}</h2></div><button class="icon-button" data-challenge-cancel aria-label="Отменить">×</button></div><p class="challenge-instruction">Рынок меняется. Выберите уровень риска под текущую ситуацию.</p><div class="risk-grid">${options.map((item, index) => `<button class="risk-card risk-${index}" data-risk-index="${index}"><strong>${escapeHtml(item)}</strong><small>${index === 0 ? "Надёжно, но медленно" : index === 1 ? "Доход и запас прочности" : "Большая награда, большой риск"}</small></button>`).join("")}</div><div class="challenge-progress">${Array.from({ length: rounds }, (_, index) => `<i class="${index < scores.length ? "done" : index === scores.length ? "active" : ""}"></i>`).join("")}</div></div>`;
        root.hidden = false;
        root.querySelector("[data-challenge-cancel]").onclick = () => { root.hidden = true; root.innerHTML = ""; activeChallenge = null; resolve(null); };
        root.querySelectorAll("[data-risk-index]").forEach((button) => button.onclick = () => completeRound(Number(button.dataset.riskIndex) === target ? 100 : 48));
        return;
      }
      target = 18 + Math.random() * 58;
      targetWidth = Math.max(10, 22 - round * 2);
      root.innerHTML = `<div class="challenge-panel"><div class="challenge-head"><div><p class="eyebrow">${escapeHtml(task)} · этап ${round}/${rounds}</p><h2>${escapeHtml(title)}</h2></div><button class="icon-button" data-challenge-cancel aria-label="Отменить">×</button></div><p class="challenge-instruction">Остановите маркер внутри зеленой зоны. Центр дает максимальную точность.</p><div class="timing-track"><i class="timing-target" style="left:${target}%;width:${targetWidth}%"></i><b class="timing-marker"></b></div><div class="challenge-progress">${Array.from({ length: rounds }, (_, index) => `<i class="${index < scores.length ? "done" : index === scores.length ? "active" : ""}"></i>`).join("")}</div><button class="challenge-action" data-challenge-lock>Зафиксировать</button></div>`;
      root.hidden = false;
      const marker = root.querySelector(".timing-marker");
      startedAt = performance.now();
      const animate = (now) => {
        const position = (Math.sin((now - startedAt) / 430 - Math.PI / 2) + 1) * 50;
        marker.style.left = `${position}%`;
        marker.dataset.position = position;
        frame = requestAnimationFrame(animate);
      };
      frame = requestAnimationFrame(animate);
      root.querySelector("[data-challenge-cancel]").onclick = () => { cancelAnimationFrame(frame); root.hidden = true; root.innerHTML = ""; activeChallenge = null; resolve(null); };
      root.querySelector("[data-challenge-lock]").onclick = () => {
        cancelAnimationFrame(frame);
        const position = Number(marker.dataset.position || 0);
        const center = target + targetWidth / 2;
        const distance = Math.abs(position - center);
        const score = Math.max(0, Math.round(100 - distance * 5));
        marker.classList.add(score >= 70 ? "hit" : "miss");
        completeRound(score);
      };
    };
    activeChallenge = { title };
    renderRound();
  });
}

function auctionTime(end) {
  const seconds = Math.max(0, Math.ceil((end - Date.now()) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function updateAuctionTimers() {
  document.querySelectorAll("[data-auction-end]").forEach((element) => {
    element.textContent = auctionTime(Number(element.dataset.auctionEnd));
  });
  document.querySelectorAll("[data-container-end]").forEach((element) => { element.textContent = auctionTime(Number(element.dataset.containerEnd)); });
  document.querySelectorAll("[data-group-job-end]").forEach((element) => { element.textContent = auctionTime(Number(element.dataset.groupJobEnd)); });
}

function updateMarketRotationTimer() {
  const label = $("#rotation-label");
  if (!label || !state.marketRotation) return;
  const seconds = Math.max(0, Math.ceil((state.marketRotation.nextAt - Date.now()) / 1000));
  label.textContent = `Новый завоз: ${state.marketRotation.replaceCount} авто через ${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function priceBand(car) {
  const stats = state.marketStats[car.model];
  if (!stats) return "fair";
  if (car.price < stats.normalLow) return "below";
  if (car.price > stats.normalHigh) return "above";
  return "fair";
}

function pricePosition(car) {
  const stats = state.marketStats[car.model];
  if (!stats || !stats.dealAverage) return ["Нет данных", "normal"];
  if (car.price < stats.normalLow) return ["Ниже рынка", ""];
  if (car.price > stats.normalHigh) return ["Выше рынка", "high"];
  return ["В рынке", "normal"];
}

function renderMarketStats() {
  const rows = Object.values(state.marketStats || {}).filter((stats) => stats.listings > 0);
  $("#market-stats-list").innerHTML = rows.map((stats) => `<div class="market-stat-row">
    <strong>${escapeHtml(stats.model)}<small>${stats.year} год · объявлений ${stats.listings}</small></strong>
    <span>${money(stats.askingAverage)}<small>от ${money(stats.askingMin)} до ${money(stats.askingMax)}</small></span>
    <span>${money(stats.marketPrice)} <b class="market-trend ${stats.trend > 0 ? "up" : stats.trend < 0 ? "down" : ""}">${stats.trend > 0 ? "+" : ""}${stats.trend}%</b><small>последняя сделка двигает индекс</small></span>
    <span>${money(stats.normalLow)} — ${money(stats.normalHigh)}</span>
  </div>`).join("");
}

function renderActivities() {
  const grid = $("#activity-grid");
  if (!grid || !state.player?.activities) return;
  const activities = state.player.activities;
  const catalog = activities.catalog || {};
  const completed = activities.completed || {};
  const keys = Object.keys(catalog).filter((key) => key !== "catalog");
  $("#activity-streak").textContent = `Сегодня: ${keys.filter((key) => completed[key]).length}/${keys.length} · серия ${activities.streak || 0}`;
  grid.innerHTML = keys.map((key) => {
    const item = catalog[key];
    const result = completed[key];
    const mixedReady = key !== "portfolio" || (state.player.garage?.length > 0 && state.player.ownedAssets?.some((asset) => asset.type === "property") && state.player.ownedAssets?.some((asset) => asset.type === "item"));
    return `<article class="activity-card ${result ? "completed" : ""}"><div class="activity-card-top"><span class="activity-index">${key === "portfolio" ? "04" : key === "workshop" ? "03" : key === "negotiate" ? "02" : "01"}</span><span class="activity-reward">+${money(item.reward)} · ${item.xp} XP</span></div><h4>${escapeHtml(item.name)}</h4><p>${escapeHtml(item.description)}</p>${key === "portfolio" ? `<small class="activity-requirement ${mixedReady ? "ready" : ""}">${mixedReady ? "Авто + вещь + недвижимость собраны" : "Нужны: авто, вещь и недвижимость"}</small>` : ""}<button class="primary-button" data-activity="${escapeHtml(key)}" ${result || !mixedReady ? "disabled" : ""}>${result ? `Выполнено · ${result.score}%` : "Начать мини-игру"}</button></article>`;
  }).join("");
}

function showToast(message, error = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = `toast visible${error ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = "toast"; }, 3200);
}

async function request(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Не удалось выполнить действие");
  return data;
}

function renderMarket() {
  const regularMarket = state.market.filter((car) => car.saleType !== "auction");
  $("#market-count").textContent = regularMarket.length;
  const classes = [...new Set(regularMarket.map((car) => car.className).filter(Boolean))].sort();
  const classSelect = $("#class-filter");
  if (classSelect && classSelect.options.length !== classes.length + 1) {
    classSelect.innerHTML = '<option value="all">Все классы</option>' + classes.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(vehicleClassNames[name] || name)}</option>`).join("");
    classSelect.value = marketFilters.className;
  }
  const query = marketFilters.query.trim().toLocaleLowerCase("ru-RU");
  const conditionMatches = (car) => marketFilters.condition === "all" || (marketFilters.condition === "good" && car.condition >= 72) || (marketFilters.condition === "medium" && car.condition >= 52 && car.condition < 72) || (marketFilters.condition === "low" && car.condition < 52);
  const visible = state.market.filter((car) => car.saleType !== "auction" && (!query || `${car.model} ${car.seller}`.toLocaleLowerCase("ru-RU").includes(query)) && (!marketFilters.min || car.price >= marketFilters.min) && (!marketFilters.max || car.price <= marketFilters.max) && (marketFilters.saleType === "all" || car.saleType === marketFilters.saleType) && (marketFilters.className === "all" || car.className === marketFilters.className) && conditionMatches(car) && (marketFilters.priceBand === "all" || priceBand(car) === marketFilters.priceBand) && (!marketFilters.fresh || Date.now() - (car.listedAt || 0) <= 120000));
  if (marketFilters.sort === "new") visible.sort((a, b) => (b.listedAt || 0) - (a.listedAt || 0));
  if (marketFilters.sort === "deal") visible.sort((a, b) => (a.price / (state.marketStats[a.model]?.marketPrice || a.price)) - (b.price / (state.marketStats[b.model]?.marketPrice || b.price)));
  if (marketFilters.sort === "priceAsc") visible.sort((a, b) => a.price - b.price);
  if (marketFilters.sort === "priceDesc") visible.sort((a, b) => b.price - a.price);
  const belowMarket = regularMarket.filter((car) => priceBand(car) === "below").length;
  $("#market-kpi-listings").textContent = number(regularMarket.length);
  $("#market-kpi-deals").textContent = number(belowMarket);
  $("#market-kpi-auctions").textContent = number(state.market.filter((car) => car.saleType === "auction").length);
  $("#market-kpi-models").textContent = number(new Set(regularMarket.map((car) => car.model)).size);
  const shown = visible.slice(0, marketVisibleCount);
  $("#filter-result").textContent = `Найдено ${visible.length} · показано ${shown.length}`;
  const marketMarkup = shown.map((car) => {
    const [label, className] = conditionLabel(car.condition);
    const [priceLabel, priceClass] = pricePosition(car);
    const own = car.sellerId === state.player.id;
    const auction = car.saleType === "auction";
    const marketPrice = state.marketStats[car.model]?.marketPrice || car.price;
    const difference = marketPrice ? Math.round((car.price / marketPrice - 1) * 100) : 0;
    return `<button class="car-card" data-open-market="${car.id}" ${own ? 'title="Ваше объявление"' : ""}>
      ${carArt(car)}
      <div class="car-info">
        <h3>${escapeHtml(car.model)}</h3>
        <div class="car-meta"><span>${number(car.mileage)} км</span><span>${own ? "Ваше объявление" : escapeHtml(car.seller)}</span></div>
        <div class="car-price-row"><strong>${money(car.price)}</strong><span class="condition ${className}">${label}</span></div>
        <span class="price-signal ${priceClass}">${priceLabel}${difference ? ` · ${difference > 0 ? "+" : ""}${difference}%` : ""}</span>
        ${car.marketTag ? `<span class="market-tag">${escapeHtml(car.marketTag)}</span>` : ""}
        ${auction ? `<div class="auction-note"><span>${car.bidCount ? `Ставок: ${car.bidCount}` : "Стартовая цена"}</span><span class="auction-timer" data-auction-end="${car.auctionEnd}">${auctionTime(car.auctionEnd)}</span></div>` : car.offerCount ? `<div class="offer-note">Предложений: ${car.offerCount}</div>` : ""}
      </div>
    </button>`;
  }).join("") || '<div class="empty-filter">По выбранным параметрам машин нет. Измените или сбросьте фильтры.</div>';
  const marketSignature = shown.map((car) => `${car.id}:${car.price}:${car.condition}:${car.offerCount}:${car.bidCount}`).join("|") + `/${visible.length}`;
  if (renderSignatures.market !== marketSignature) { $("#market-grid").innerHTML = marketMarkup; renderSignatures.market = marketSignature; }
  $("#market-load-more-wrap").hidden = shown.length >= visible.length;
  $("#market-load-more-label").textContent = `Показано ${shown.length} из ${visible.length}`;
}

function rewardModal(reward) {
  const car = reward.car;
  const result = car.estimatedValue - reward.paid;
  const marketDifference = car.marketPrice ? Math.round((car.estimatedValue / car.marketPrice - 1) * 100) : 0;
  return `<div class="reward-hero rarity-${escapeHtml(car.rarity.toLocaleLowerCase("ru-RU"))}">
    ${carArt(car, "modal-car-art reward-car-art")}
    <div class="reward-title"><p class="eyebrow">${escapeHtml(reward.containerName)} · контейнер открыт</p><span class="rarity-badge">${escapeHtml(car.rarity)}</span><h2 id="modal-title">${escapeHtml(car.model)}</h2><p>${car.year} год · ${escapeHtml(car.color)} · ${number(car.mileage)} км</p></div>
  </div><div class="modal-body reward-body">
    <div class="reward-stats">
      <div><span>Состояние</span><strong>${car.condition}%</strong></div><div><span>Класс</span><strong>${escapeHtml(vehicleClassNames[car.className] || car.className)}</strong></div>
      <div><span>Ваша ставка</span><strong>${money(reward.paid)}</strong></div><div><span>Оценка сейчас</span><strong>${money(car.estimatedValue)}</strong></div>
      <div><span>Индекс модели</span><strong>${money(car.marketPrice)}</strong></div><div><span>Потенциал сделки</span><strong class="${result >= 0 ? "reward-positive" : "reward-negative"}">${result >= 0 ? "+" : "−"}${money(Math.abs(result))}</strong></div>
    </div>
    <div class="reward-market-note"><strong>${marketDifference > 0 ? `Оценка на ${marketDifference}% выше индекса` : marketDifference < 0 ? `Оценка на ${Math.abs(marketDifference)}% ниже индекса` : "Оценка совпадает с индексом"}</strong><span>${car.defectCount ? `Есть риск скрытых неисправностей: ${car.defectCount}. Точные узлы откроются после осмотра.` : "По первичной оценке серьёзных скрытых неисправностей нет."}</span></div>
    <button class="primary-button reward-claim" data-claim-reward="${reward.id}">Забрать в гараж</button>
  </div>`;
}

function maybeOpenContainerReward() {
  const reward = state.player.containerRewards?.[0];
  if (!reward || !$("#car-modal").hidden || shownRewardId === reward.id) return;
  shownRewardId = reward.id;
  openModal(rewardModal(reward), reward.car.id, "reward");
}

function renderProgression() {
  const player = state.player;
  const levelBase = player.levelStartXp || 0;
  const needed = Math.max(1, player.nextLevelXp - levelBase);
  const progress = player.level >= 30 ? 100 : Math.round(((player.xp - levelBase) / needed) * 100);
  $("#level-number").textContent = player.level;
  $("#profile-level").textContent = `${player.level} уровень`;
  $("#xp-label").textContent = player.level >= 30 ? `${player.xp} XP · максимум` : `${player.xp} / ${player.nextLevelXp} XP`;
  $("#xp-progress").style.width = `${progress}%`;
  $("#skill-points").textContent = player.skillPoints;

  $("#skills-grid").innerHTML = Object.entries(state.skillInfo).map(([key, info]) => {
    const level = player.skills[key];
    const maxLevel = info.maxLevel || 5;
    return `<div class="upgrade-item">
      <div class="upgrade-top"><strong>${escapeHtml(info.name)}</strong><span class="upgrade-level">${level}/${maxLevel}</span></div>
      <p>${escapeHtml(info.description)}</p>
      <button data-skill="${key}" ${level >= maxLevel || player.skillPoints < 1 ? "disabled" : ""}>${level >= maxLevel ? "Мастер" : "Повысить · 1 очко"}</button>
    </div>`;
  }).join("");

  $("#equipment-grid").innerHTML = Object.entries(state.equipmentInfo).map(([key, info]) => {
    const level = player.equipment[key];
    const price = level < 3 ? info.prices[level + 1] : 0;
    return `<div class="upgrade-item">
      <div class="upgrade-top"><strong>${escapeHtml(info.name)}</strong><span class="upgrade-level">${level}/3</span></div>
      <p>${escapeHtml(info.description || (level ? `Оборудование ${level} класса` : "Оборудование отсутствует"))}</p>
      <button data-equipment="${key}" ${level >= 3 || player.cash < price ? "disabled" : ""}>${level >= 3 ? "Максимум" : `Улучшить · ${money(price)}`}</button>
    </div>`;
  }).join("");
}

function renderGarage() {
  const garage = state.player.garage;
  $("#garage-count").textContent = `${garage.length}/${state.player.garageCapacity}`;
  $("#garage-capacity").textContent = `${state.player.garageCapacity} мест`;
  $("#part-stock-count").textContent = `${number((state.player.partInventory || []).length)} деталей`;
  $("#training-count").textContent = `${state.player.training?.completed || 0} заданий`;
  $("#garage-value").textContent = money(garage.reduce((sum, car) => sum + car.invested, 0));
  $("#empty-garage").hidden = garage.length > 0;
  $("#garage-grid").innerHTML = garage.map((car) => {
    const open = car.defects.filter((defect) => !defect.repaired);
    const checked = car.inspection?.checked || 0;
    return `<article class="garage-car">
      ${carArt(car)}
      <div class="garage-main"><h3>${escapeHtml(car.model)}</h3><p>${car.year} год · ${number(car.mileage)} км<br>Вложено ${money(car.invested)}</p></div>
      <div class="garage-status">
        <div class="status-line"><span>Состояние</span><strong>${car.condition}%</strong></div>
        <div class="status-bar"><i style="width:${car.condition}%"></i></div>
        <p class="defect-count">Проверено узлов: ${checked}/${state.inspectionCategories.length} · уверенность ${car.inspection?.confidence || 0}% · найдено проблем: ${open.length}</p>
      </div>
      <div class="garage-actions">
        <button class="secondary-button" data-open-garage="${car.id}">Осмотр и ремонт</button>
        <button class="primary-button" data-list-car="${car.id}">Выставить на рынок</button>
        <button class="secondary-button" data-dismantle="${car.id}">Разобрать на детали</button>
        ${state.player.group ? `<button class="secondary-button" data-group-deposit-car="${car.id}">В общий гараж</button>` : ""}
      </div>
    </article>`;
  }).join("");
  renderProgression();
}

function partQualityName(part) {
  return state.partQualities?.[part.quality]?.name || part.quality || "Деталь";
}

function partComponentName(component) {
  return state.partComponents?.[component] || ({ engine: "Двигатель", chassis: "Ходовая", body: "Кузов", electrics: "Электрика", tires: "Шины" }[component] || "Узел");
}

function partsForNeed(need) {
  return (state.player.partInventory || []).filter((part) => part.partKey === need.defect.partKey && part.compatibleModel === need.carModel);
}

function renderParts() {
  const inventory = state.player.partInventory || [];
  const needs = state.partNeeds || [];
  const market = state.partsMarket || [];
  const garage = state.player.garage || [];
  if (partsCarFilter !== "all" && !garage.some((car) => car.id === partsCarFilter)) partsCarFilter = "all";
  const stockValue = inventory.reduce((sum, part) => sum + part.estimatedValue, 0);
  const exactStock = needs.filter((need) => partsForNeed(need).length).length;
  $("#parts-summary").innerHTML = `<div><span>Требуется для ремонта</span><strong>${needs.length}</strong><small>${exactStock} уже есть на складе</small></div><div><span>Деталей на складе</span><strong>${inventory.length}</strong><small>Оценка ${money(stockValue)}</small></div><div><span>Лотов на бирже</span><strong>${market.length}</strong><small>Игроки, магазины и разборки</small></div><div><span>Установлено на авто</span><strong>${state.player.garage.reduce((sum, car) => sum + (car.installedParts?.length || 0), 0)}</strong><small>Влияет на ликвидность машин</small></div>`;
  $("#parts-needs-count").textContent = needs.length;
  $("#parts-stock-tab-count").textContent = inventory.length;
  $("#parts-market-count").textContent = market.length;
  document.querySelectorAll("[data-parts-mode]").forEach((button) => button.classList.toggle("active", button.dataset.partsMode === partsMode));
  $("#parts-needs-panel").hidden = partsMode !== "needs";
  $("#parts-stock-panel").hidden = partsMode !== "stock";
  $("#parts-market-panel-view").hidden = partsMode !== "market";

  $("#parts-car-switcher").innerHTML = `<button class="${partsCarFilter === "all" ? "active" : ""}" data-parts-car="all"><strong>Все машины</strong><span>${garage.length} в гараже · ${needs.length} деталей</span></button>${garage.map((car) => {
    const carNeeds = needs.filter((need) => need.carId === car.id).length;
    const status = carNeeds ? `${carNeeds} ${carNeeds === 1 ? "деталь" : carNeeds < 5 ? "детали" : "деталей"}` : car.serviceDiagnosed ? "детали не требуются" : "нужен осмотр";
    return `<button class="${partsCarFilter === car.id ? "active" : ""}" data-parts-car="${car.id}"><strong>${escapeHtml(car.model)}</strong><span>${car.year} · ${status}</span></button>`;
  }).join("")}`;

  const visibleNeeds = partsCarFilter === "all" ? needs : needs.filter((need) => need.carId === partsCarFilter);
  const selectedCar = garage.find((car) => car.id === partsCarFilter);

  $("#parts-needs-list").innerHTML = visibleNeeds.map((need) => {
    const defect = need.defect;
    const stock = partsForNeed(need);
    const choiceId = `part-choice-${need.carId}-${defect.code}`;
    const canSelf = state.player.skills[defect.repairSkill] >= defect.repairSkillLevel && state.player.equipment[defect.repairEquipment] >= defect.repairEquipmentLevel;
    const skillName = state.skillInfo[defect.repairSkill]?.name || "Профессия";
    const equipmentName = state.equipmentInfo[defect.repairEquipment]?.name || "Оборудование";
    const selfRequirement = `${skillName} ${state.player.skills[defect.repairSkill] || 0}/${defect.repairSkillLevel} · ${equipmentName} ${state.player.equipment[defect.repairEquipment] || 0}/${defect.repairEquipmentLevel}`;
    return `<article class="part-need-row"><div class="part-need-car"><span>${need.carYear}</span><strong>${escapeHtml(need.carModel)}</strong><small>${escapeHtml(partComponentName(defect.partComponent))}</small></div><div class="part-need-info"><span class="part-sku">${escapeHtml(defect.partKey)}</span><h3>${escapeHtml(defect.partName)}</h3><p>${escapeHtml(defect.name)}</p><small>${stock.length ? `На складе найдено: ${stock.length}` : "Подходящей детали на складе нет"}</small></div><div class="part-need-action">${stock.length ? `<select id="${choiceId}" data-part-select="${need.carId}:${defect.code}">${stock.map((part) => `<option value="${part.id}">${escapeHtml(part.brand)} · ${partQualityName(part)} · ресурс ${part.conditionPct}%</option>`).join("")}</select><div class="install-actions"><button class="secondary-button" data-repair="${need.carId}" data-defect="${defect.code}" data-repair-mode="workshop">Сервис, работа · ${money(defect.serviceLaborCost)}</button><button class="secondary-button" data-repair="${need.carId}" data-defect="${defect.code}" data-repair-mode="assisted">Мастер с вашей деталью · ${money(defect.assistedRepairCost)}</button><button class="primary-button" data-repair="${need.carId}" data-defect="${defect.code}" data-repair-mode="self" ${canSelf ? "" : "disabled"}>Установить самому · ${money(defect.selfRepairCost)}</button></div>${canSelf ? '<small class="repair-readiness ready">Самостоятельная установка доступна</small>' : `<button class="repair-readiness" data-open-development>Не хватает для самостоятельной установки: ${escapeHtml(selfRequirement)} · прокачать</button>`}` : `<div class="quality-offers">${need.offers.map((offer) => `<button data-order-part="${need.carId}" data-defect="${defect.code}" data-quality="${offer.quality}" ${state.player.availableCash < offer.price ? "disabled" : ""}><span>${escapeHtml(offer.name)}</span><strong>${money(offer.price)}</strong><small>Надёжность ${offer.reliability}%${offer.warrantyKm ? ` · гарантия ${number(offer.warrantyKm)} км` : " · без гарантии"}</small></button>`).join("")}</div><button class="secondary-button service-with-part" data-repair="${need.carId}" data-defect="${defect.code}" data-repair-mode="workshop">Сервис под ключ · ${money(defect.serviceRepairCost)}</button>${canSelf ? '<small class="repair-readiness ready">Купите деталь: после этого можно установить самому или нанять мастера</small>' : `<button class="repair-readiness" data-open-development>Не хватает для самостоятельной установки: ${escapeHtml(selfRequirement)} · деталь можно поставить с мастером без навыка</button>`}`}</div></article>`;
  }).join("") || (selectedCar ? `<div class="parts-empty"><strong>${selectedCar.serviceDiagnosed ? "Для найденных поломок детали не нужны" : "Сначала проверьте автомобиль"}</strong><span>${selectedCar.serviceDiagnosed ? `У ${escapeHtml(selectedCar.model)} нет обнаруженных физических неисправностей, требующих покупки детали.` : `После осмотра ${escapeHtml(selectedCar.model)} здесь появятся точные артикулы совместимых деталей.`}</span><button class="primary-button" data-open-garage-car="${selectedCar.id}">${selectedCar.serviceDiagnosed ? "Открыть автомобиль" : "Перейти к осмотру"}</button></div>` : '<div class="parts-empty"><strong>Список покупок пуст</strong><span>Выберите машину выше или проведите диагностику: для каждой обнаруженной физической поломки появится точная деталь.</span></div>');

  $("#parts-inventory-list").innerHTML = inventory.map((part) => {
    const matches = needs.filter((need) => need.defect.partKey === part.partKey && need.carModel === part.compatibleModel).length;
    return `<article class="inventory-part"><div class="part-card-head"><span class="quality-tag quality-${part.quality}">${escapeHtml(partQualityName(part))}</span><span class="part-sku">${escapeHtml(part.partKey)}</span></div><h3>${escapeHtml(part.name)}</h3><p>${escapeHtml(part.brand)} · для ${escapeHtml(part.compatibleModel)} (${escapeHtml(part.generation)})</p><div class="part-metrics"><span>Ресурс<strong>${part.conditionPct}%</strong></span><span>Надёжность<strong>${part.reliability}%</strong></span><span>Оценка<strong>${money(part.estimatedValue)}</strong></span></div><small>${matches ? `Подходит для ${matches} текущих ремонтов` : `Источник: ${escapeHtml(part.source || "Склад")}`}</small>${matches ? `<button class="primary-button" data-parts-mode-link="needs">Перейти к установке</button>` : ""}<div class="part-list-action"><input id="part-price-${part.id}" type="number" min="1" max="20000000" value="${Math.max(1, part.estimatedValue)}" aria-label="Цена продажи"><button class="secondary-button" data-list-part="${part.id}">Выставить на биржу</button></div></article>`;
  }).join("") || '<div class="parts-empty"><strong>Склад пуст</strong><span>Купите деталь в подборе по ремонту, на бирже или получите её после разбора автомобиля.</span></div>';

  const query = partsFilters.query.trim().toLocaleLowerCase("ru-RU");
  const neededKeys = new Set(needs.map((need) => `${need.defect.partKey}:${need.carModel}`));
  const filteredMarket = market.filter((lot) => {
    const part = lot.item || {};
    return (partsFilters.component === "all" || part.component === partsFilters.component) && (partsFilters.quality === "all" || part.quality === partsFilters.quality) && (!query || `${part.name} ${part.partKey} ${part.compatibleModel} ${part.brand}`.toLocaleLowerCase("ru-RU").includes(query));
  }).sort((a, b) => Number(neededKeys.has(`${b.item?.partKey}:${b.item?.compatibleModel}`)) - Number(neededKeys.has(`${a.item?.partKey}:${a.item?.compatibleModel}`)) || a.price - b.price);
  $("#parts-market-list").innerHTML = filteredMarket.map((lot) => { const part = lot.item; const needed = neededKeys.has(`${part.partKey}:${part.compatibleModel}`); return `<article class="exchange-part ${needed ? "needed" : ""}"><div><span class="quality-tag quality-${part.quality}">${escapeHtml(partQualityName(part))}</span>${needed ? '<span class="needed-tag">Нужно для вашей машины</span>' : ""}<strong>${escapeHtml(part.name)}</strong><small>${escapeHtml(part.brand)} · ${escapeHtml(part.partKey)} · ${escapeHtml(part.compatibleModel)} · ресурс ${part.conditionPct}%</small></div><div class="exchange-price"><strong>${money(lot.price)}</strong><small>оценка ${money(part.estimatedValue)} · ${escapeHtml(lot.seller)}</small></div><button class="secondary-button" data-buy-part-market="${lot.id}" ${lot.sellerId === state.player.id || state.player.availableCash < lot.price ? "disabled" : ""}>${lot.sellerId === state.player.id ? "Ваш лот" : "Купить"}</button></article>`; }).join("") || '<div class="parts-empty"><strong>Ничего не найдено</strong><span>Измените фильтры или дождитесь нового предложения от разборок.</span></div>';
  $("#parts-market-trends").innerHTML = Object.values(state.partsMarketStats || {}).map((stat) => `<span><b>${escapeHtml(partComponentName(stat.component))}</b> ${money(stat.averagePrice)}<small>${stat.active} лотов · ${stat.deals} сделок</small></span>`).join("");
}

function renderContainers() {
  const garageFull = state.player.garage.length >= state.player.garageCapacity;
  const containers = [...(state.containerAuctions || [])].sort((a, b) => Number(b.viewerLeading) - Number(a.viewerLeading) || Number(b.viewerParticipated) - Number(a.viewerParticipated) || a.endAt - b.endAt);
  $("#container-grid").innerHTML = containers.map((box) => {
    const current = box.highestBid || box.startingPrice;
    const minimum = box.highestBid ? Math.ceil((current + Math.max(1000, Math.ceil(current * .02))) / 1000) * 1000 : Math.ceil(current / 1000) * 1000;
    const leading = box.highestBidderId === state.player.id;
    const bidState = leading ? "Вы лидируете" : box.viewerParticipated ? "Вашу ставку перебили" : "";
    const bidControl = leading
      ? '<div class="leading-bid-note"><strong>Ставка зафиксирована</strong><span>Пока вы лидируете, повышать её не нужно. Кнопка вернётся, если ставку перебьют.</span></div>'
      : `<form data-container-bid="${box.id}"><label><span>Ваша ставка</span><input name="amount" type="number" min="${minimum}" step="1000" value="${minimum}" inputmode="numeric" required></label><button class="primary-button" ${garageFull ? "disabled" : ""}>${garageFull ? "Нет места в гараже" : "Поставить"}</button></form>`;
    return `<article class="container-card tier-${box.tier} ${box.viewerParticipated ? "player-lot" : ""} ${box.viewerParticipated && !leading ? "outbid-lot" : ""}" style="--box-color:${escapeHtml(box.color)}">${bidState ? `<div class="player-bid-status">${bidState}</div>` : ""}<div class="container-visual"><span>ЛОТ ${box.id.slice(-4).toUpperCase()}</span><i></i><b>?</b></div><div class="container-info"><p class="eyebrow">${escapeHtml(box.label || "Закрытый")} контейнер</p><h3>${escapeHtml(box.name)}</h3><span>${escapeHtml(box.description || "Состав неизвестен до победы")}</span><small class="container-range">Возможная стоимость: ${money(box.minValue)}–${money(box.maxValue)}</small><div class="container-bid-state"><strong>${money(current)}</strong><small>${box.highestBidderName ? `Лидирует ${escapeHtml(box.highestBidderName)}` : "Стартовая ставка"} · ${box.bidCount} ставок</small><time data-container-end="${box.endAt}">${auctionTime(box.endAt)}</time></div>${bidControl}</div></article>`;
  }).join("");
}

function renderAuctions() {
  const allAuctions = state.market.filter((car) => car.saleType === "auction");
  const auctions = allAuctions.filter((car) => {
    const conditionOk = auctionFilters.condition === "all" || (auctionFilters.condition === "good" && car.condition >= 72) || (auctionFilters.condition === "medium" && car.condition >= 52 && car.condition < 72) || (auctionFilters.condition === "low" && car.condition < 52);
    const sellerOk = auctionFilters.seller === "all" || (auctionFilters.seller === "npc" ? !car.sellerId : Boolean(car.sellerId));
    return conditionOk && sellerOk && (!auctionFilters.max || (car.highestBid || car.startingPrice) <= auctionFilters.max);
  }).sort((a, b) => Number(b.viewerLeading) - Number(a.viewerLeading) || Number(b.viewerParticipated) - Number(a.viewerParticipated) || (auctionFilters.sort === "price" ? (a.highestBid || a.startingPrice) - (b.highestBid || b.startingPrice) : auctionFilters.sort === "condition" ? b.condition - a.condition : a.auctionEnd - b.auctionEnd));
  $("#auction-count").textContent = allAuctions.length + (state.containerAuctions?.length || 0);
  if ($("#auction-filter-result")) $("#auction-filter-result").textContent = `Показано ${auctions.length} из ${allAuctions.length}`;
  const auctionMarkup = auctions.map((car) => {
    const [condition, conditionClass] = conditionLabel(car.condition);
    const status = car.viewerLeading ? "Вы лидируете" : car.viewerParticipated ? "Вашу ставку перебили" : car.sellerId === state.player.id ? "Ваш аукцион" : "";
    const current = car.highestBid || car.startingPrice;
    const minimum = car.highestBid ? current + Math.max(1, Math.ceil(current * .01)) : current;
    const defects = car.defects || [];
    return `<article class="auction-car-lot ${car.viewerParticipated ? "player-lot" : ""} ${car.viewerParticipated && !car.viewerLeading ? "outbid-lot" : ""}">${status ? `<span class="player-bid-status">${status}</span>` : ""}<button class="auction-car-preview" data-open-market="${car.id}">${carArt(car)}<span class="auction-details-link">Открыть осмотр</span></button><div class="auction-car-content"><div class="auction-car-title"><div><p class="eyebrow">${escapeHtml(car.seller)}</p><h3>${escapeHtml(car.model)}</h3><small>${car.year} · ${number(car.mileage)} км</small></div><span class="condition ${conditionClass}">${car.condition}% · ${condition}</span></div><div class="auction-defects"><strong>${defects.length ? `Известные поломки: ${defects.length}` : "Известных поломок нет"}</strong>${defects.length ? `<ul>${defects.map((defect) => `<li>${escapeHtml(defect.name)} · ${severityNames[defect.severity]}</li>`).join("")}</ul>` : `<span>Состояние полностью раскрыто для торгов</span>`}</div><div class="container-bid-state"><strong>${money(current)}</strong><small>${car.highestBidderName ? `Лидирует ${escapeHtml(car.highestBidderName)}` : "Стартовая ставка"} · ставок ${car.bidCount}</small><time data-auction-end="${car.auctionEnd}">${auctionTime(car.auctionEnd)}</time></div>${car.sellerId === state.player.id ? '<span class="auction-own-note">Вы продавец этого лота</span>' : `<form data-car-bid="${car.id}"><input id="auction-bid-${car.id}" name="amount" type="number" min="${minimum}" step="1" value="${minimum}" required><button class="primary-button" type="submit">${car.viewerLeading ? "Повысить" : "Сделать ставку"}</button></form>`}</div></article>`;
  }).join("") || '<div class="empty-filter">По выбранным фильтрам активных автомобильных лотов нет.</div>';
  const auctionSignature = auctions.map((car) => `${car.id}:${car.highestBid}:${car.bidCount}:${car.viewerLeading}:${car.condition}`).join("|");
  if (renderSignatures.auctions !== auctionSignature) { $("#auction-car-grid").innerHTML = auctionMarkup; renderSignatures.auctions = auctionSignature; }
  const notifications = state.player.notifications || [];
  $("#auction-notifications").innerHTML = notifications.slice(0, 5).map((item) => `<article class="auction-alert ${item.read ? "read" : ""}"><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.text)}</p></div><time>${new Date(item.createdAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</time></article>`).join("");
  $("#auction-notifications").hidden = !notifications.length;
  const unread = state.player.unreadNotifications || 0;
  $("#notification-count").hidden = !unread; $("#notification-count").textContent = unread;
  const newest = notifications.find((item) => !item.read);
  if (newest && shownNotificationId !== newest.id) { shownNotificationId = newest.id; showToast(newest.text, true); }
}

function offerCard(offer, incoming) {
  const car = offer.car || { model: "Проданный автомобиль", price: 0 };
  const counter = offer.status === "counter";
  return `<article class="offer-card ${offer.buyerType === "bot" ? "bot" : ""}">
    <div class="offer-head"><div><strong>${escapeHtml(incoming ? offer.buyerName : offer.sellerName || "Продавец")}</strong><p class="offer-car">${escapeHtml(car.model)} · цена ${money(car.price || offer.amount)}</p></div><span>${money(offer.amount)}</span></div>
    <p class="offer-reason">${escapeHtml(offer.reason)}</p>
    <div class="offer-actions">
      ${incoming ? `
        <button class="primary-button" data-offer-action="accept" data-offer-id="${offer.id}">Принять</button>
        <button class="secondary-button" data-offer-action="reject" data-offer-id="${offer.id}">Отказать</button>
        <div class="counter-row"><input id="counter-${offer.id}" type="number" step="1" min="1" max="${Math.max(1, (car.price || offer.amount) - 1)}" placeholder="Встречная цена"><button class="secondary-button" data-offer-action="counter" data-offer-id="${offer.id}">Ответить</button></div>
      ` : counter ? `<button class="primary-button" data-accept-counter="${offer.id}">Принять встречную цену</button>` : `<span class="condition mid">Ожидает ответа продавца</span>`}
    </div>
  </article>`;
}

function renderOffers() {
  const incoming = state.player.incomingOffers || [];
  const outgoing = state.player.outgoingOffers || [];
  $("#offers-count").textContent = incoming.length + outgoing.filter((offer) => offer.status === "counter").length;
  $("#incoming-offers").innerHTML = incoming.length ? incoming.map((offer) => offerCard(offer, true)).join("") : '<div class="no-offers">Пока никто не торгуется по вашим объявлениям.</div>';
  $("#outgoing-offers").innerHTML = outgoing.length ? outgoing.map((offer) => offerCard(offer, false)).join("") : '<div class="no-offers">Вы ещё не предлагали свою цену.</div>';
  const reputation = state.player.reputation || { score: 50 };
  $("#reputation-badge").textContent = `Репутация ${reputation.score}/100`;
  $("#contracts-list").innerHTML = (state.player.contracts || []).map((contract) => `<article class="contract-card ${contract.status}">
    <div><strong>${escapeHtml(contract.title)}</strong><p>${escapeHtml(contract.description)}</p><small>До ${new Date(contract.expiresAt).toLocaleDateString("ru-RU")}</small></div>
    <span>${contract.status === "completed" ? "Выполнено" : contract.status === "failed" ? "Провалено" : `+${money(contract.reward)}`}</span>
  </article>`).join("");
}

function renderLeaderboard() {
  $("#my-profit").textContent = money(state.player.profit);
  $("#my-profit").className = state.player.profit >= 0 ? "profit-positive" : "profit-negative";
  $("#leader-list").innerHTML = state.leaderboard.map((player, index) => `<div class="leader-row ${player.id === state.player.id ? "current" : ""}">
    <div class="leader-player"><span class="place">${index + 1}</span><span>${escapeHtml(player.name)}${player.id === state.player.id ? " (ты)" : ""} · ур. ${player.level}</span></div>
    <span>${player.deals}</span><span class="leader-profit ${player.profit >= 0 ? "profit-positive" : "profit-negative"}">${player.profit >= 0 ? "+" : ""}${money(player.profit)}</span>
  </div>`).join("");
}

function groupRoleSelect(member, group) {
  if (!group.permissions.roles || member.id === group.ownerId) return "";
  const roles = ["Участник", "Управляющий", "Казначей", "Механик", "Оценщик"];
  return `<select data-group-role="${member.id}">
    ${roles.map((role) => `<option value="${role}" ${member.role === role ? "selected" : ""}>${role}</option>`).join("")}
  </select>`;
}

function renderProfile() {
  const player = state.player;
  $("#profile-monogram").textContent = player.name[0].toUpperCase();
  $("#profile-name-large").textContent = player.name;
  const supporterName = supporterTierNames[player.supporterTier];
  $("#profile-career").innerHTML = `${player.level} уровень · ${player.xp} XP · ${player.deals} сделок${supporterName ? ` <span class="supporter-badge tier-${escapeHtml(player.supporterTier)}">${supporterName}</span>` : ""}`;
  $("#profile-cash").textContent = money(player.cash);
  $("#profile-reputation").textContent = `${player.reputation?.score || 50}/100`;
  const levelRange = Math.max(1, player.nextLevelXp - player.levelStartXp);
  const levelProgress = player.nextLevelXp === player.xp ? 100 : Math.min(100, Math.round((player.xp - player.levelStartXp) / levelRange * 100));
  $("#profile-xp-bar").style.width = `${levelProgress}%`;
  $("#profile-xp-label").textContent = player.nextLevelXp === player.xp ? "Максимальный уровень" : `${player.xp - player.levelStartXp} / ${levelRange} XP до следующего уровня`;
  const stats = [
    ["Сделки", player.deals], ["Результат", money(player.profit)],
    ["Авто в гараже", `${player.garage.length}/${player.garageCapacity}`], ["Осмотры", player.stats.inspections],
    ["Ремонты своими силами", player.stats.selfRepairs], ["Победы на торгах", player.stats.auctionsWon]
  ];
  $("#profile-stats").innerHTML = stats.map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("");
  const ledger = player.ledger || [];
  const ledgerBalance = ledger.reduce((sum, entry) => sum + entry.amount, 0);
  $("#ledger-summary").textContent = ledger.length ? `${ledger.length} операций · итог ${ledgerBalance >= 0 ? "+" : ""}${money(ledgerBalance)}` : "Операций пока нет";
  $("#deal-history").innerHTML = ledger.length ? ledger.slice(0, 40).map((entry) => `<article class="ledger-entry ledger-${escapeHtml(entry.type)}"><span class="ledger-icon">${entry.amount > 0 ? "+" : entry.amount < 0 ? "−" : "•"}</span><div><strong>${escapeHtml(entry.title)}</strong><small>${escapeHtml(entry.category || "Операция")}${entry.counterparty ? ` · ${escapeHtml(entry.counterparty)}` : ""}${Number.isFinite(entry.score) ? ` · точность ${entry.score}%` : ""}<br>${new Date(entry.at).toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</small></div><div class="ledger-money"><strong class="${entry.amount >= 0 ? "profit-positive" : "profit-negative"}">${entry.amount > 0 ? "+" : entry.amount < 0 ? "−" : ""}${money(Math.abs(entry.amount))}</strong>${Number.isFinite(entry.profit) ? `<small class="${entry.profit >= 0 ? "profit-positive" : "profit-negative"}">результат ${entry.profit >= 0 ? "+" : "−"}${money(Math.abs(entry.profit))}</small>` : ""}</div></article>`).join("") : '<div class="no-offers">Здесь появятся покупки, продажи, ремонты и доходы.</div>';
  $("#profile-skills").innerHTML = Object.entries(state.skillInfo).map(([key, info]) => `<div><span>${escapeHtml(info.name)}<small>${escapeHtml(info.description)}</small></span><strong>${player.skills[key]}/${info.maxLevel || 5}</strong></div>`).join("");
  $("#profile-equipment").innerHTML = Object.entries(state.equipmentInfo).map(([key, info]) => `<div><span>${escapeHtml(info.name)}</span><strong>${player.equipment[key]}/3</strong></div>`).join("");
  const group = player.group;
  $("#group-content").innerHTML = group ? `<div class="group-summary"><strong>${escapeHtml(group.name)}</strong><span>Рейтинг ${Math.round(group.rating)}/100 · касса ${money(group.treasury)}</span><small>Ваша роль: ${escapeHtml(player.groupRole || "Участник")} · общий гараж ${group.garage.length}/${group.garageCapacity} · ID: ${escapeHtml(group.id)}</small><div><input id="group-transfer-amount" type="number" min="1" placeholder="Сумма в общую кассу"><button class="secondary-button" data-group-transfer>Внести деньги</button></div>${group.permissions.treasury ? `<div><select id="group-pay-player">${group.members.map((member) => `<option value="${member.id}">${escapeHtml(member.name)}</option>`).join("")}</select><input id="group-pay-amount" type="number" min="1" placeholder="Сумма участнику"><button class="secondary-button" data-group-pay>Выдать из кассы</button></div>` : ""}</div>` : `<div class="group-create"><input id="group-name" maxlength="30" placeholder="Название новой группы"><button class="primary-button" data-group-create>Создать группу</button><input id="group-join-id" maxlength="40" placeholder="ID существующей группы"><button class="secondary-button" data-group-join>Вступить по ID</button><small>Владелец сможет назначать роли: управляющий, механик, оценщик или казначей.</small></div>`;
  const businessProgress = group ? Math.min(100, Math.round(group.businessXp / group.businessXpRequired * 100)) : 0;
  $("#group-business").innerHTML = group ? `<div class="business-dashboard"><div><span>Уровень бизнеса</span><strong>${group.businessLevel}</strong><small>${group.businessXp}/${group.businessXpRequired} XP</small></div><div><span>Рабочие места</span><strong>${group.activeJobs.length}/${group.jobSlots}</strong><small>Новые места на 3 и 5 уровне</small></div><div><span>Выполнено заказов</span><strong>${number(group.completedJobs)}</strong><small>Выручка ${money(group.totalRevenue)}</small></div><div><span>Чистая прибыль</span><strong class="${group.totalBusinessProfit >= 0 ? "profit-positive" : "profit-negative"}">${money(group.totalBusinessProfit)}</strong><small>После расходов и зарплат</small></div></div><div class="business-xp"><i style="width:${businessProgress}%"></i></div>` : "";
  $("#group-jobs").innerHTML = group ? `<div class="group-section-title"><div><h4>Заказы бизнеса</h4><small>Сотрудник приносит деньги в общую кассу и растёт вместе с командой</small></div><span>${group.activeJobs.length ? "Работа идёт" : "Нет активных заказов"}</span></div><div class="active-job-grid">${group.activeJobs.map((job) => `<article class="active-job"><div><strong>${escapeHtml(job.name)}</strong><small>${escapeHtml(job.employeeName)} · запустил ${escapeHtml(job.startedBy)}</small></div><time data-group-job-end="${job.finishAt}">${auctionTime(job.finishAt)}</time></article>`).join("") || '<div class="no-offers">Назначьте сотрудника на первый клиентский заказ.</div>'}</div>` : "";
  $("#group-members").innerHTML = group ? `<h4>Участники</h4>${group.members.map((member) => `<div class="group-member"><div><strong>${escapeHtml(member.name)}</strong><small>${escapeHtml(member.role)}</small></div>${groupRoleSelect(member, group)}</div>`).join("")}` : "";
  $("#group-garage").innerHTML = group ? `<h4>Общий гараж</h4>${group.garage.length ? group.garage.map((car) => `<article class="group-car">${carArt(car)}<div><strong>${escapeHtml(car.model)}</strong><small>${car.year} · вложено ${money(car.invested)} · передал ${escapeHtml(car.groupContributorName || "участник")}</small></div><div class="group-car-actions"><button class="secondary-button" data-group-work-car="${car.id}">Отдать в работу</button><button class="secondary-button" data-group-withdraw-car="${car.id}">Забрать</button></div></article>`).join("") : '<div class="no-offers">У группы пока нет общих автомобилей.</div>'}` : "";
  const specialtyNames = { diagnostics: "Диагностика", mechanics: "Ремонт", appraisal: "Оценка", sales: "Продажи" };
  const jobsBySpecialty = Object.fromEntries((state.groupJobCatalog || []).map((job) => [job.specialty, job]));
  $("#group-employees").innerHTML = group ? `<h4>Штат и загрузка</h4><div class="employee-grid">${group.employees.map((employee) => { const job = jobsBySpecialty[employee.specialty]; const busy = group.activeJobs.find((item) => item.employeeId === employee.id); const cost = job ? job.cost + employee.salary : 0; const canStart = group.permissions.business && !busy && employee.energy >= (job?.energy || 101) && group.activeJobs.length < group.jobSlots && group.treasury >= cost; return `<article class="employee-card hired ${busy ? "busy" : ""}"><div class="employee-head"><div><strong>${escapeHtml(employee.name)}</strong><span>${escapeHtml(employee.title)} · рейтинг ${employee.rating}</span></div><b>${busy ? "На заказе" : "Свободен"}</b></div><div class="employee-energy"><span>Энергия ${employee.energy}%</span><i><b style="width:${employee.energy}%"></b></i></div><small>${specialtyNames[employee.specialty]} · выполнено ${employee.jobsCompleted} · зарплата за заказ ${money(employee.salary)}</small>${job ? `<div class="employee-job"><strong>${escapeHtml(job.name)}</strong><small>${escapeHtml(job.description)} · доход ${money(job.rewardLow)}–${money(job.rewardHigh)}</small><button class="primary-button" data-start-group-job="${job.key}" data-employee-id="${employee.id}" ${canStart ? "" : "disabled"}>${busy ? "Уже работает" : employee.energy < job.energy ? "Нужен отдых" : group.activeJobs.length >= group.jobSlots ? "Нет свободного места" : group.treasury < cost ? `Нужно ${money(cost)}` : `Запустить · ${money(cost)}`}</button></div>` : ""}${group.permissions.business && !busy && employee.energy < 100 ? `<button class="secondary-button" data-restore-employee="${employee.id}" ${group.treasury < 12000 ? "disabled" : ""}>Отдых и премия · 12 000 ₽</button>` : ""}</article>`; }).join("") || '<div class="no-offers">Сотрудников пока нет. Наймите специалиста и запустите первый заказ.</div>'}</div>${group.permissions.hire ? `<h4>Рынок персонала</h4><div class="employee-grid candidates">${(state.employeeCandidates || []).filter((candidate) => !group.employees.some((employee) => employee.id === candidate.id)).map((candidate) => `<article class="employee-card"><strong>${escapeHtml(candidate.name)}</strong><span>${escapeHtml(candidate.title)} · рейтинг ${candidate.rating}</span><small>${specialtyNames[candidate.specialty]} · найм ${money(candidate.hireCost)} · зарплата ${money(candidate.salary)} за заказ</small><button class="secondary-button" data-hire-employee="${candidate.id}">Нанять</button></article>`).join("") || '<div class="no-offers">Все доступные специалисты уже в штате.</div>'}</div>` : ""}` : "";
  $("#group-activity").innerHTML = group ? `<h4>Журнал команды</h4><div>${group.log.slice().reverse().slice(0, 10).map((entry) => `<p><time>${new Date(entry.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</time><span>${escapeHtml(entry.text)}</span></p>`).join("") || '<div class="no-offers">Здесь появятся важные действия команды.</div>'}</div>` : "";
}

function renderStore() {
  const store = state.store || { enabled: false, packages: [] };
  $("#store-status").textContent = store.enabled ? `Оплата через ${store.provider}` : "Приём платежей готовится";
  $("#store-packages").innerHTML = store.packages.map((pack) => `<article class="store-package ${pack.popular ? "popular" : ""}">
    <div class="store-package-head"><span>${escapeHtml(pack.tag || "Поддержка")}</span>${pack.popular ? "<b>Популярный</b>" : ""}</div>
    <h3>${escapeHtml(pack.name)}</h3><strong>${money(pack.cash)}</strong><small>игровых рублей</small>
    <p>${escapeHtml(pack.description || "Пополнение игрового баланса")}</p><em>${escapeHtml(pack.bonus || "")}</em>
    <button class="danger-button" data-buy-cash="${pack.id}" ${store.enabled ? "" : "disabled"}>${store.enabled ? `Получить за ${number(pack.rubles)} ₽` : `${number(pack.rubles)} ₽ · скоро`}</button>
  </article>`).join("");
}

function renderAdmin() {
  $("#admin-tab").hidden = !state.player.isAdmin;
  if (!state.player.isAdmin || !adminState) return;
  const economy = adminState.economy;
  $("#admin-economy").innerHTML = [["Игроков", economy.players], ["Авто на рынке", economy.marketCars], ["Сделок", economy.deals], ["Предложений", economy.activeOffers], ["Жалоб", economy.openReports], ["Оплат", economy.payments]].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("");
  $("#admin-reports").innerHTML = adminState.reports.length ? adminState.reports.map((report) => `<article class="admin-report"><div><strong>${escapeHtml(report.accusedName)}</strong><small>Жалоба от ${escapeHtml(report.reporterName)} · ${new Date(report.createdAt).toLocaleString("ru-RU")}</small><p>«${escapeHtml(report.messageText)}»</p><span>${escapeHtml(report.reason)}</span></div><div><button class="danger-button" data-admin-report-ban="${report.id}" data-player-id="${report.accusedId}">Заблокировать</button><button class="secondary-button" data-admin-report="resolve" data-report-id="${report.id}">Закрыть</button><button class="secondary-button" data-admin-report="dismiss" data-report-id="${report.id}">Отклонить</button></div></article>`).join("") : '<div class="no-offers">Новых жалоб нет.</div>';
  $("#admin-players").innerHTML = adminState.players.map((player) => {
    const banned = player.bannedUntil === -1 || player.bannedUntil > Date.now();
    return `<article class="admin-player ${banned ? "banned" : ""}"><header><div class="admin-player-avatar">${escapeHtml(player.name[0].toUpperCase())}</div><div><strong>${escapeHtml(player.name)}</strong><small>Уровень ${player.level} · ${player.deals} сделок · гараж ${player.garage} · репутация ${player.reputation}</small>${banned ? `<b>Заблокирован: ${escapeHtml(player.banReason || "причина не указана")}</b>` : ""}</div></header><div class="admin-current-values"><span>Баланс<strong>${money(player.cash)}</strong></span><span>Очки навыков<strong>${number(player.skillPoints)}</strong></span></div><div class="admin-player-tools"><div class="admin-value-row"><label><span>Операция с балансом</span><select id="admin-cash-mode-${player.id}"><option value="set">Установить точно</option><option value="adjust">Прибавить или вычесть</option></select></label><label><span>Сумма</span><input id="admin-cash-${player.id}" type="number" step="1" inputmode="numeric" placeholder="Например, 40000000"></label><button class="primary-button" data-admin-value="cash" data-player-id="${player.id}">Сохранить баланс</button></div><div class="admin-value-row"><label><span>Операция с очками</span><select id="admin-skills-mode-${player.id}"><option value="set">Установить точно</option><option value="adjust">Прибавить или вычесть</option></select></label><label><span>Очки навыков</span><input id="admin-skills-${player.id}" type="number" step="1" inputmode="numeric" placeholder="Например, 25"></label><button class="secondary-button" data-admin-value="skills" data-player-id="${player.id}">Сохранить очки</button></div><label class="admin-reason"><span>Комментарий к изменению</span><input id="admin-reason-${player.id}" maxlength="100" placeholder="Необязательно"></label><div class="admin-ban-actions"><select id="admin-ban-duration-${player.id}"><option value="60">1 час</option><option value="1440">1 день</option><option value="10080">7 дней</option><option value="43200">30 дней</option><option value="-1">Навсегда</option></select><input id="admin-ban-reason-${player.id}" maxlength="160" placeholder="Причина блокировки"><button class="${banned ? "secondary-button" : "danger-button"}" data-admin-${banned ? "unban" : "ban"}="${player.id}">${banned ? "Снять блокировку" : "Заблокировать"}</button></div></div></article>`;
  }).join("");
}

async function loadAdmin() {
  if (!state.player?.isAdmin) return;
  try { adminState = await request("/api/admin/state"); renderAdmin(); }
  catch (error) { showToast(error.message, true); }
}

function renderChat() {
  const container = $("#chat-messages");
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 90;
  const messages = state.chatMessages || [];
  $("#chat-count").textContent = messages.length;
  container.innerHTML = messages.length ? messages.map((message) => `<div class="chat-message ${message.playerId === state.player.id ? "own" : ""}">
    <div><strong>${escapeHtml(message.playerName)}${supporterTierNames[message.supporterTier] ? ` <i class="supporter-badge tier-${escapeHtml(message.supporterTier)}">${escapeHtml(supporterTierNames[message.supporterTier])}</i>` : ""}</strong><span><time>${new Date(message.createdAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</time>${message.playerId !== state.player.id ? `<button class="chat-report" data-report-chat="${message.id}" title="Пожаловаться на сообщение">Пожаловаться</button>` : ""}</span></div>
    <p>${escapeHtml(message.text)}</p>
  </div>`).join("") : '<div class="chat-empty">Сообщений пока нет.</div>';
  if (nearBottom) container.scrollTop = container.scrollHeight;
}

function renderAssets() {
  const listings = state.assetMarket || [];
  const owned = state.player.ownedAssets || [];
  const categories = state.assetCategories || {};
  const filtered = listings.filter((asset) => (assetMode === "all" || asset.type === assetMode) && (assetFilters.category === "all" || asset.category === assetFilters.category) && (!assetFilters.min || asset.price >= assetFilters.min) && (!assetFilters.max || asset.price <= assetFilters.max)).sort((a, b) => assetFilters.sort === "priceAsc" ? a.price - b.price : assetFilters.sort === "priceDesc" ? b.price - a.price : assetFilters.sort === "income" ? (b.income || 0) - (a.income || 0) : (((b.estimateLow + b.estimateHigh) / 2) / b.price) - (((a.estimateLow + a.estimateHigh) / 2) / a.price));
  const portfolioValue = owned.reduce((sum, asset) => sum + asset.resaleValue, 0);
  const invested = owned.reduce((sum, asset) => sum + asset.purchasePrice, 0);
  const cryptoValue = owned.filter((asset) => asset.type === "crypto").reduce((sum, asset) => sum + asset.resaleValue, 0);
  const properties = owned.filter((asset) => asset.type === "property");
  const incomeRate = properties.reduce((sum, asset) => sum + (asset.incomeState?.perCycle || 0), 0);
  const nextIncomeAt = properties.map((asset) => asset.incomeState?.nextAt).filter(Boolean).sort((a, b) => a - b)[0];
  $("#asset-summary").innerHTML = `<div><span>Стоимость портфеля</span><strong>${money(portfolioValue)}</strong><small>${portfolioValue - invested >= 0 ? "+" : ""}${money(portfolioValue - invested)} к вложениям</small></div><div><span>Недвижимость</span><strong>${properties.length}</strong><small>${money(incomeRate)} в минуту</small></div><div><span>Криптопозиции</span><strong>${owned.filter((asset) => asset.type === "crypto").length}</strong><small>текущая цена ${money(cryptoValue)}</small></div><div><span>Свободный баланс</span><strong>${money(state.player.availableCash)}</strong><small>доступно для сделок</small></div>`;
  $("#property-income-value").textContent = money(state.player.assetIncomeAvailable || 0);
  $("#property-income-rate").textContent = `${money(incomeRate)} в минуту`;
  $("#property-income-explanation").textContent = properties.length ? (nextIncomeAt ? `Следующее начисление ${auctionTime(nextIncomeAt)} · максимум 10 минут накопления на объект` : "Доход готов к получению") : "Купите объект недвижимости, чтобы получать аренду";
  const incomeButton = $("#property-income-panel [data-asset-income]");
  incomeButton.disabled = (state.player.assetIncomeAvailable || 0) < 1;
  $("#asset-filter-result").textContent = `Показано ${filtered.length} из ${listings.length}`;
  $("#asset-market-grid").innerHTML = filtered.map((asset) => { const deal = Math.round((asset.price / ((asset.estimateLow + asset.estimateHigh) / 2) - 1) * 100); const crypto = asset.type === "crypto"; return `<article class="asset-card asset-${asset.type}"><div class="asset-visual"><span>${crypto ? `КРИПТО · ${escapeHtml(asset.symbol)}` : asset.type === "property" ? "НЕДВИЖИМОСТЬ" : escapeHtml(categories[asset.category] || "ВЕЩЬ")}</span><strong>${crypto ? escapeHtml(asset.symbol[0]) : asset.type === "property" ? "▦" : "◆"}</strong></div><div class="asset-card-body"><p class="eyebrow">${escapeHtml(asset.seller)}</p><h3>${escapeHtml(asset.name)}</h3><p>${escapeHtml(asset.description)}</p><div class="asset-metrics">${crypto ? `<span>Курс<strong>${money(asset.unitPrice)}</strong></span><span>Пакет<strong>${number(asset.quantity)} ${escapeHtml(asset.symbol)}</strong></span><span>Движение<strong class="crypto-move ${asset.changePct >= 0 ? "up" : "down"}">${asset.changePct >= 0 ? "+" : ""}${asset.changePct}%</strong></span>` : `<span>Состояние<strong>${asset.condition}%</strong></span><span>Ликвидность<strong>${asset.liquidity}/100</strong></span>${asset.income ? `<span>Доход / мин<strong>${money(asset.income)}</strong></span>` : `<span>Риск<strong>${asset.risk}/5</strong></span>`}`}</div><div class="asset-estimate"><span>${crypto ? "Диапазон риск-оценки" : "Ваша оценка"}: ${money(asset.estimateLow)}–${money(asset.estimateHigh)}</span><b class="${deal <= -8 ? "profit-positive" : deal >= 8 ? "profit-negative" : ""}">${deal > 0 ? "+" : ""}${deal}%</b></div><div class="asset-buy"><strong>${money(asset.price)}</strong><small>${state.skillInfo[asset.skill]?.name || "Оценка"} ${asset.skillLevel}/5${crypto ? " · биржевая наценка 1,2%" : ` · остаток ${asset.stock}`}</small><button class="primary-button" data-buy-asset="${asset.id}" ${state.player.availableCash < asset.price ? "disabled" : ""}>${crypto ? "Купить пакет" : "Купить"}</button></div></div></article>`; }).join("") || '<div class="empty-filter">На этом рынке лотов по выбранным условиям нет.</div>';
  const visibleOwned = owned.filter((asset) => assetMode === "all" || asset.type === assetMode);
  $("#owned-assets").innerHTML = visibleOwned.length ? visibleOwned.map((asset) => { const delta = asset.resaleValue - asset.purchasePrice; const income = asset.incomeState; return `<article class="owned-asset"><div><span>${asset.type === "crypto" ? `Криптовалюта · ${escapeHtml(asset.symbol)}` : asset.type === "property" ? "Недвижимость" : escapeHtml(categories[asset.category] || "Вещь")}</span><strong>${escapeHtml(asset.name)}</strong><small>${asset.type === "crypto" ? `${number(asset.quantity)} ${escapeHtml(asset.symbol)} · куплено за ${money(asset.purchasePrice)}` : `Куплено за ${money(asset.purchasePrice)} · состояние ${asset.condition}%`}</small>${income?.perCycle ? `<small class="asset-income-line">Аренда ${money(income.perCycle)}/мин · накоплено ${money(income.amount)}</small>` : ""}</div><div><span>${asset.type === "crypto" ? "По курсу после комиссии" : "Быстрая продажа"}</span><strong>${money(asset.resaleValue)}</strong><small class="${delta >= 0 ? "profit-positive" : "profit-negative"}">${delta >= 0 ? "+" : ""}${money(delta)}</small><button class="secondary-button" data-sell-asset="${asset.id}">Продать</button></div></article>`; }).join("") : '<div class="no-offers">В выбранном разделе портфеля пока ничего нет.</div>';
}

function updateAssetIncomeTimer() {
  if (!state.player || !$("#assets-view")?.classList.contains("active-view")) return;
  const nextAt = (state.player.ownedAssets || []).filter((asset) => asset.type === "property").map((asset) => asset.incomeState?.nextAt).filter(Boolean).sort((a, b) => a - b)[0];
  if (nextAt && (state.player.assetIncomeAvailable || 0) < 1) $("#property-income-explanation").textContent = `Следующее начисление ${auctionTime(nextAt)} · максимум 10 минут накопления на объект`;
}

function captureActiveDraft() {
  const active = document.activeElement;
  if (!active?.matches("input, textarea, select") || !$("#game")?.contains(active)) return null;
  let selector = active.id ? `#${CSS.escape(active.id)}` : null;
  const containerForm = active.closest("[data-container-bid]");
  if (!selector && containerForm && active.name) selector = `[data-container-bid="${CSS.escape(containerForm.dataset.containerBid)}"] [name="${CSS.escape(active.name)}"]`;
  const namedForm = active.closest("form[id]");
  if (!selector && namedForm && active.name) selector = `#${CSS.escape(namedForm.id)} [name="${CSS.escape(active.name)}"]`;
  if (!selector) return null;
  return { selector, value: active.value, start: active.selectionStart, end: active.selectionEnd };
}

function restoreActiveDraft(draft) {
  if (!draft) return;
  const active = $(draft.selector);
  if (!active) return;
  active.value = draft.value;
  active.focus({ preventScroll: true });
  if (typeof draft.start === "number" && active.setSelectionRange) {
    try { active.setSelectionRange(draft.start, draft.end); } catch { /* number inputs do not expose a text selection */ }
  }
}

function render() {
  if (!state.player) return;
  const draft = captureActiveDraft();
  $("#cash").textContent = money(state.player.availableCash);
  $("#cash").title = state.player.reservedCash ? `Баланс ${money(state.player.cash)}, в ставках зарезервировано ${money(state.player.reservedCash)}` : `Баланс ${money(state.player.cash)}`;
  $("#profile-name").textContent = state.player.name;
  $("#avatar").textContent = state.player.name[0].toUpperCase();
  renderMarketStats(); renderMarket(); renderActivities(); renderGarage(); renderParts(); renderOffers(); renderLeaderboard(); renderProfile(); renderChat(); renderAssets(); renderStore(); renderAdmin(); renderContainers(); renderAuctions();
  if (modalCarId && !$("#car-modal").hidden) refreshOpenModal();
  maybeOpenContainerReward();
  restoreActiveDraft(draft);
  hydrateCarPhotos();
}

function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; render(); }, 80);
}

function setView(view) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
  document.querySelectorAll(".utility-nav [data-view]").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
  document.querySelectorAll(".view").forEach((section) => section.classList.toggle("active-view", section.id === `${view}-view`));
  $("#utility-nav")?.classList.remove("open");
  $("#section-menu-button")?.setAttribute("aria-expanded", "false");
  if (location.hash !== `#${view}`) history.replaceState(null, "", `#${view}`);
  if (view === "auctions" && state.player.unreadNotifications) markNotificationsRead();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function markNotificationsRead() {
  try { state = await request("/api/notifications/read", { method: "POST", body: "{}" }); render(); } catch { /* next server update will retry through the user action */ }
}

function marketModal(car) {
  const own = car.sellerId === state.player.id;
  const auction = car.saleType === "auction";
  const [condition, conditionClass] = conditionLabel(car.condition);
  const canOffer = !own && !auction && car.price > 1;
  const stats = state.marketStats[car.model];
  const [priceLabel, priceClass] = pricePosition(car);
  return `${carArt(car, "modal-car-art")}<div class="modal-body">
    <p class="eyebrow">${own ? "Ваше объявление" : `Продавец: ${escapeHtml(car.seller)}`}</p>
    <h2 id="modal-title">${escapeHtml(car.model)}</h2><p class="modal-subtitle">${car.year} год · ${number(car.mileage)} км</p>
    <div class="inspection-grid">
      <div><span>Состояние</span><strong class="condition ${conditionClass}">${condition}</strong></div>
      <div><span>Пробег</span><strong>${number(car.mileage)} км</strong></div>
      <div><span>Предложения</span><strong>${car.offerCount || 0}</strong></div>
    </div>
    <p class="description">«${escapeHtml(car.description)}»</p>
    <section class="market-inspection"><div class="workshop-heading"><div><p class="eyebrow">Проверка до покупки</p><h3>Осмотреть автомобиль</h3></div><span>Найденное увидят все участники</span></div><div class="inspection-actions">${state.inspectionCategories.map((category) => { const req = state.inspectionRequirements[category]; const record = car.publicInspectionRecords?.[category]; const score = state.player.skills[req.skill] + state.player.equipment[req.equipment]; const can = !record || score > record.bestScore; return `<button class="inspection-button" data-market-check="${category}" data-car-id="${car.id}" ${can ? "" : "disabled"}><strong>${categoryNames[category]}</strong><small>${record ? `проверено: ${record.confidence}%` : "не проверено"}<br>${state.skillInfo[req.skill].name} ${state.player.skills[req.skill]}/5 · ${state.equipmentInfo[req.equipment].name} ${state.player.equipment[req.equipment]}/3</small></button>`; }).join("")}</div>${car.defects?.length ? `<div class="known-defects"><strong>Уже подтверждено другими:</strong> ${car.defects.map((defect) => escapeHtml(defect.name)).join(" · ")}</div>` : ""}</section>
    ${auction ? `<div class="auction-status"><strong>${car.highestBid ? `Текущая ставка ${money(car.highestBid)}` : `Стартовая цена ${money(car.startingPrice)}`}</strong><span>${car.highestBidderName ? `Лидирует ${escapeHtml(car.highestBidderName)} · ` : ""}До завершения <b class="auction-timer" data-auction-end="${car.auctionEnd}">${auctionTime(car.auctionEnd)}</b></span></div>` : ""}
    ${stats ? `<div class="market-comparison">
      <div><span>Индекс рынка</span><strong>${money(stats.marketPrice)} <b class="market-trend ${stats.trend > 0 ? "up" : stats.trend < 0 ? "down" : ""}">${stats.trend > 0 ? "+" : ""}${stats.trend}%</b></strong></div>
      <div><span>Сейчас выставляют</span><strong>${money(stats.askingAverage)}</strong></div>
      <div><span>Оценка цены</span><strong class="price-signal ${priceClass}">${priceLabel}</strong></div>
    </div>` : ""}
    <div class="modal-action-row"><div class="modal-price"><span>Цена продавца</span><strong>${money(car.price)}</strong></div>
      ${own ? `<button class="secondary-button" data-unlist="${car.id}" ${auction && car.bidCount ? "disabled" : ""}>${auction && car.bidCount ? "Аукцион уже идёт" : "Снять с продажи"}</button>` : auction ? "" : `<button class="danger-button" data-buy="${car.id}" ${state.player.garage.length >= state.player.garageCapacity || state.player.availableCash < car.price ? "disabled" : ""}>${state.player.garage.length >= state.player.garageCapacity ? "Нет места в гараже" : state.player.availableCash < car.price ? "Недостаточно свободных денег" : "Купить сейчас"}</button>`}
    </div>
    ${auction && !own ? `<form id="bid-form" class="bid-form" data-car-id="${car.id}"><input id="modal-bid-${car.id}" name="amount" type="number" min="${car.highestBid ? car.highestBid + Math.max(1, Math.ceil(car.highestBid * .01)) : car.startingPrice}" step="1" value="${car.highestBid ? car.highestBid + Math.max(1, Math.ceil(car.highestBid * .01)) : car.startingPrice}" required><button class="danger-button" type="submit">Сделать ставку</button></form>` : ""}
    ${canOffer ? `<form id="offer-form" class="offer-form" data-car-id="${car.id}"><input id="offer-amount-${car.id}" name="amount" type="number" min="1" max="${car.price - 1}" step="1" value="${Math.max(1, Math.round(car.price * .92))}" required><button class="secondary-button" type="submit">Предложить цену</button></form>` : ""}
  </div>`;
}

function inspectionButton(car, category) {
  const requirement = state.inspectionRequirements[category];
  const skillLevel = state.player.skills[requirement.skill];
  const equipmentLevel = state.player.equipment[requirement.equipment];
  const score = skillLevel + equipmentLevel;
  const record = car.inspectionRecords?.[category];
  const canInspect = !car.serviceDiagnosed && (!record || score > record.bestScore);
  const status = car.serviceDiagnosed ? "заключение сервиса" : record ? canInspect ? `можно углубить · было ${record.confidence}%` : `уверенность ${record.confidence}%` : "не проверено";
  return `<button class="inspection-button" data-check="${category}" data-car-id="${car.id}" ${canInspect ? "" : "disabled"}>
    <strong>${categoryNames[category]} <em class="free-action">Бесплатно</em></strong><small>${status}<br>${state.skillInfo[requirement.skill].name} ${skillLevel}/5 · ${state.equipmentInfo[requirement.equipment].name} ${equipmentLevel}/3</small>
  </button>`;
}

function defectRow(car, defect) {
  const skillName = state.skillInfo[defect.repairSkill]?.name || "Специалист";
  const equipmentName = state.equipmentInfo[defect.repairEquipment]?.name || "Инструмент";
  const canSelf = defect.selfRepairable && state.player.skills[defect.repairSkill] >= defect.repairSkillLevel && state.player.equipment[defect.repairEquipment] >= defect.repairEquipmentLevel;
  const skillCurrent = state.player.skills[defect.repairSkill] || 0;
  const equipmentCurrent = state.player.equipment[defect.repairEquipment] || 0;
  const compatibleParts = (state.player.partInventory || []).filter((part) => part.partKey === defect.partKey && part.compatibleModel === car.model);
  return `<div class="defect-row ${defect.repaired ? "repaired" : ""}">
    <strong>${escapeHtml(defect.name)} <span class="severity">${severityNames[defect.severity]}</span><small class="defect-detail">${escapeHtml(defect.symptom)}<br>Риск: ${escapeHtml(defect.consequence)}${defect.selfRepairable ? `<br>Готовность: ${skillName} ${skillCurrent}/5 · ${equipmentName} ${equipmentCurrent}/3` : "<br>Только специализированный сервис"}</small></strong>
    ${defect.repaired ? "<span>Устранено</span>" : `<div class="repair-actions">${defect.partRequired ? `<div class="repair-part-status"><strong>${escapeHtml(defect.partName)}</strong><small>${escapeHtml(defect.partKey)} · ${compatibleParts.length ? `на складе ${compatibleParts.length}` : "нужно купить"}</small></div>` : ""}${compatibleParts.length ? `<select data-part-select="${car.id}:${defect.code}">${compatibleParts.map((part) => `<option value="${part.id}">${escapeHtml(part.brand)} · ${partQualityName(part)} · ресурс ${part.conditionPct}%</option>`).join("")}</select>` : defect.partRequired ? `<button class="part-order-button" data-open-parts-center>Подобрать деталь</button>` : ""}<button class="secondary-button" data-repair="${car.id}" data-defect="${defect.code}" data-repair-mode="workshop">${compatibleParts.length ? "Сервис, работа" : "Сервис под ключ"} · ${money(compatibleParts.length ? defect.serviceLaborCost : defect.serviceRepairCost || defect.repair)}</button><button class="secondary-button" data-repair="${car.id}" data-defect="${defect.code}" data-repair-mode="assisted" ${defect.selfRepairable && (!defect.partRequired || compatibleParts.length) ? "" : "disabled"}>Мастер с вашей деталью · ${money(defect.assistedRepairCost)}</button><button class="primary-button" data-repair="${car.id}" data-defect="${defect.code}" data-repair-mode="self" ${canSelf && (!defect.partRequired || compatibleParts.length) ? "" : "disabled"}>Самостоятельно · ${money(defect.selfRepairCost)}</button>${!canSelf && defect.selfRepairable ? `<button class="repair-readiness" data-open-development>Для самостоятельного ремонта: ${escapeHtml(skillName)} ${skillCurrent}/${defect.repairSkillLevel} · ${escapeHtml(equipmentName)} ${equipmentCurrent}/${defect.repairEquipmentLevel} · прокачать</button>` : ""}</div>`}
  </div>`;
}

function garageModal(car) {
  const open = car.defects.filter((defect) => !defect.repaired);
  const result = lastCheckResult && lastCheckResult.carId === car.id ? lastCheckResult : null;
  return `${carArt(car, "modal-car-art")}<div class="modal-body">
    <p class="eyebrow">Самостоятельный осмотр</p><h2 id="modal-title">${escapeHtml(car.model)}</h2>
    <p class="modal-subtitle">Состояние ${car.condition}% · вложено ${money(car.invested)}</p>
    ${!car.serviceDiagnosed ? `<div class="service-diagnostic"><div><strong>Полная диагностика в сервисе · необязательно</strong><span>Уже найденные ниже неисправности можно ремонтировать сразу. Сервис нужен только чтобы раскрыть остальные проблемы и получить заключение для продажи.</span></div><button class="danger-button" data-service-diagnostic="${car.id}">${money(car.serviceDiagnosticCost)}</button></div>` : `<div class="inspection-summary"><strong>Диагностика сервиса завершена.</strong> Все неисправности известны, заключение увеличивает ликвидность машины.</div>`}
    <div class="inspection-actions">${state.inspectionCategories.map((category) => inspectionButton(car, category)).join("")}</div>
    <section class="upgrade-section"><div class="workshop-heading"><div><p class="eyebrow">Тюнинг своими силами или через ателье</p><h3>Улучшения автомобиля</h3></div><span>Навыки снижают стоимость работ</span></div><div class="upgrade-options">${(car.upgradeOptions || []).map((upgrade) => { const price = upgrade.canUse ? upgrade.cost : upgrade.serviceCost; return `<article class="car-upgrade ${upgrade.installed ? "installed" : ""}"><div><strong>${escapeHtml(upgrade.name)}</strong><small>${escapeHtml(upgrade.description)}</small><small>${upgrade.canUse ? "Самостоятельная установка" : "Установка в тюнинг-ателье"} · ценность +${money(upgrade.value)}</small></div>${upgrade.installed ? `<b>Установлено</b>` : `<button class="primary-button" data-car-upgrade="${car.id}" data-upgrade="${upgrade.key}" ${state.player.cash >= price ? "" : "disabled"}>${upgrade.canUse ? "Установить самому" : "Заказать в ателье"} · ${money(price)}</button>`}</article>`; }).join("")}</div></section>
    ${result ? `<div class="inspection-summary"><strong>${categoryNames[result.category]}:</strong> новых проблем найдено ${result.found.length}. Уверенность проверки ${result.confidence}%. ${result.canImprove ? "После улучшения профессии или комплекта узел можно проверить глубже." : "Достигнута максимальная глубина личного осмотра."}</div>` : ""}
    <div class="defect-list">${car.defects.length ? car.defects.map((defect) => defectRow(car, defect)).join("") : '<div class="defect-row"><strong>Обнаруженных неисправностей пока нет</strong><span>Проверяйте узлы</span></div>'}</div>
    <section class="car-history"><h3>История автомобиля</h3>${(car.history || []).slice().reverse().map((entry) => `<div><time>${new Date(entry.at).toLocaleDateString("ru-RU")}</time><span>${escapeHtml(entry.text)}</span></div>`).join("")}</section>
    <p class="description">Проверки находят только те дефекты, для которых хватает навыка и оборудования. Чистый результат не всегда означает исправную машину.</p>
  </div>`;
}

function listModal(car) {
  const estimate = car.saleEstimate;
  const suggested = Math.max(1, estimate.recommendedLow);
  const unresolvedText = estimate.unresolvedCount ? `${estimate.unresolvedCount} известных неисправностей` : "известных неисправностей нет";
  return `${carArt(car, "modal-car-art")}<div class="modal-body"><p class="eyebrow">Новое объявление</p><h2 id="modal-title">Продать ${escapeHtml(car.model)}</h2>
    <div class="seller-summary">
      <div><span>Всего вложено</span><strong>${money(estimate.invested)}</strong></div>
      <div><span>Индекс модели</span><strong>${money(estimate.marketPrice)}</strong></div>
      <div><span>Техническая цена</span><strong>${money(estimate.technicalValue)}</strong></div>
      <div><span>Ценность ремонта</span><strong>+${money(estimate.repairPremium + estimate.documentationPremium)}</strong></div>
      <div><span>Рекомендация</span><strong>${money(estimate.recommendedLow)} — ${money(estimate.recommendedHigh)}</strong></div>
      <div><span>Окупаемость</span><strong>${money(estimate.breakEven)}</strong></div>
    </div>
    <div class="seller-verdict"><span>${unresolvedText} · уверенность осмотра ${estimate.inspectionConfidence}%</span><strong id="npc-interest">—</strong><b id="projected-profit">—</b></div>
    <form id="list-form" class="list-form" data-car-id="${car.id}">
      <div class="sale-mode">
        <label><input type="radio" name="saleType" value="fixed" checked><strong>Обычная продажа</strong><small>Покупка сразу или торг</small></label>
        <label><input type="radio" name="saleType" value="auction"><strong>Аукцион</strong><small>Победит максимальная ставка</small></label>
      </div>
      <label>Цена продажи или стартовая ставка<input name="price" type="number" min="1" max="150000000" step="1" value="${suggested}" required></label>
      <label class="auction-duration">Длительность аукциона<select name="durationSeconds"><option value="60">1 минута</option><option value="180">3 минуты</option><option value="300" selected>5 минут</option><option value="900">15 минут</option></select></label>
      <label>Текст объявления<input name="description" maxlength="120" value="${car.repairs.length ? "Обслужена, список работ в истории." : "На ходу, разумный торг у капота."}" required></label>
      <button class="danger-button" type="submit">Опубликовать объявление</button>
    </form></div>`;
}

function updateListingSummary() {
  if (modalMode !== "list") return;
  const car = state.player.garage.find((item) => item.id === modalCarId);
  const input = $("#list-form input[name='price']");
  if (!car?.saleEstimate || !input) return;
  const price = Math.max(1, Number(input.value) || 1);
  const estimate = car.saleEstimate;
  const profit = price - estimate.invested;
  const interest = price <= estimate.expectedNpcPrice ? ["Высокий спрос", "high-interest"] : price <= estimate.recommendedHigh ? ["Умеренный спрос", "medium-interest"] : ["Низкий спрос", "low-interest"];
  $("#npc-interest").textContent = interest[0];
  $("#npc-interest").className = interest[1];
  $("#projected-profit").textContent = `${profit >= 0 ? "Прогноз прибыли +" : "Прогноз убытка "}${money(Math.abs(profit))}`;
  $("#projected-profit").className = profit >= 0 ? "profit-positive" : "profit-negative";
}

function openModal(content, carId, mode) {
  modalCarId = carId; modalMode = mode;
  $("#modal-content").innerHTML = content;
  modalContentSignature = stableModalSignature(content);
  $("#car-modal").classList.toggle("reward-modal", mode === "reward");
  $("#car-modal").hidden = false;
  document.body.style.overflow = "hidden";
  updateListingSummary();
  hydrateCarPhotos($("#modal-content"));
}
function closeModal(force = false) { if (modalMode === "reward" && !force) return; $("#car-modal").hidden = true; $("#car-modal").classList.remove("reward-modal"); document.body.style.overflow = ""; modalCarId = null; modalMode = null; modalContentSignature = ""; lastCheckResult = null; }
function stableModalSignature(content) {
  return content.replace(/(<[^>]+data-auction-end="[^"]+"[^>]*>)[^<]*(<\/[^>]+>)/g, "$1TIME$2");
}
function refreshOpenModal() {
  const marketCar = state.market.find((car) => car.id === modalCarId);
  const garageCar = state.player.garage.find((car) => car.id === modalCarId);
  if (modalMode === "list" && garageCar) return;
  let content = "";
  if (modalMode === "garage" && garageCar) content = garageModal(garageCar);
  else if (modalMode === "market" && marketCar) content = marketModal(marketCar);
  else { closeModal(); return; }
  const signature = stableModalSignature(content);
  if (signature !== modalContentSignature) {
    const panel = $(".modal-panel");
    const scrollTop = panel?.scrollTop || 0;
    $("#modal-content").innerHTML = content;
    modalContentSignature = signature;
    if (panel) panel.scrollTop = scrollTop;
  }
  hydrateCarPhotos($("#modal-content"));
}

function connectEvents() {
  if (events) events.close();
  events = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  events.addEventListener("update", (event) => { state = JSON.parse(event.data); scheduleRender(); });
  events.addEventListener("banned", (event) => { const data = JSON.parse(event.data); events.close(); localStorage.removeItem("perekup-token"); window.alert(data.error || "Аккаунт заблокирован"); location.reload(); });
  events.onerror = () => { $("#online-label").textContent = "Переподключение…"; };
  events.onopen = () => { $("#online-label").textContent = "Рынок онлайн"; };
}

async function enterGame(data) {
  state = data; $("#join-screen").hidden = true; $("#game").hidden = false; render();
  const initialView = location.hash.slice(1);
  if (document.getElementById(`${initialView}-view`)) setView(initialView);
  connectEvents();
}

$("#join-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; $("#join-error").textContent = "";
  const action = event.submitter?.dataset.authAction || "login";
  try { const data = await request(`/api/${action}`, { method: "POST", body: JSON.stringify({ name: $("#player-name").value, pin: $("#player-pin").value }) }); token = data.token; localStorage.setItem("perekup-token", token); await enterGame(data); }
  catch (error) { $("#join-error").textContent = error.message; } finally { button.disabled = false; }
});

async function perform(path, body, success) {
  const actionKey = `${path}:${body?.carId || body?.offerId || body?.partId || ""}`;
  if (pendingActions.has(actionKey)) return false;
  pendingActions.add(actionKey);
  try { state = await request(path, { method: "POST", body: JSON.stringify(body) }); render(); if (success) showToast(success); return true; }
  catch (error) { showToast(error.message, true); return false; }
  finally { pendingActions.delete(actionKey); }
}

document.addEventListener("click", async (event) => {
  const tab = event.target.closest("[data-view]"); if (tab) { setView(tab.dataset.view); if (tab.dataset.view === "admin") loadAdmin(); return; }
  if (event.target.closest("#section-menu-button")) { const menu = $("#utility-nav"); const open = menu.classList.toggle("open"); $("#section-menu-button").setAttribute("aria-expanded", String(open)); return; }
  const assetModeButton = event.target.closest("[data-asset-mode]");
  if (assetModeButton) { assetMode = assetModeButton.dataset.assetMode; document.querySelectorAll("[data-asset-mode]").forEach((button) => button.classList.toggle("active", button === assetModeButton)); assetFilters.category = "all"; $("#asset-filters select[name='category']").value = "all"; renderAssets(); return; }
  const partsModeButton = event.target.closest("[data-parts-mode]"); if (partsModeButton) { partsMode = partsModeButton.dataset.partsMode; renderParts(); return; }
  const partsModeLink = event.target.closest("[data-parts-mode-link]"); if (partsModeLink) { partsMode = partsModeLink.dataset.partsModeLink; renderParts(); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
  const partsCarButton = event.target.closest("[data-parts-car]"); if (partsCarButton) { partsCarFilter = partsCarButton.dataset.partsCar; renderParts(); return; }
  const garageCarButton = event.target.closest("[data-open-garage-car]"); if (garageCarButton) { const car = state.player.garage.find((item) => item.id === garageCarButton.dataset.openGarageCar); if (car) { setView("garage"); openModal(garageModal(car), car.id, "garage"); } return; }
  if (event.target.closest("[data-open-development]")) { closeModal(); setView("garage"); const workshop = document.querySelector(".garage-workshop"); if (workshop) { workshop.open = true; setTimeout(() => workshop.scrollIntoView({ behavior: "smooth", block: "start" }), 50); } return; }
  if (event.target.closest("[data-go-market]")) return setView("market");
  if (event.target.closest("[data-close-modal]")) return closeModal();
  if (event.target.closest("[data-open-parts-center]")) { closeModal(); partsMode = "needs"; setView("parts"); renderParts(); return; }

  const claimReward = event.target.closest("[data-claim-reward]");
  if (claimReward) {
    if (await perform("/api/container/reward/ack", { rewardId: claimReward.dataset.claimReward }, "Автомобиль добавлен в гараж. Вы остались в торгах")) { closeModal(true); maybeOpenContainerReward(); }
    return;
  }
  const preset = event.target.closest("[data-market-preset]");
  if (preset) {
    const type = preset.dataset.marketPreset;
    if (type === "auctions") { setView("auctions"); return; }
    $("#market-filters").reset();
    marketFilters = { query: "", min: null, max: type === "budget" ? 300000 : null, saleType: type === "auctions" ? "auction" : "all", className: "all", condition: "all", priceBand: type === "deals" ? "below" : "all", sort: type === "deals" ? "deal" : "new", fresh: type === "fresh" };
    marketVisibleCount = 24;
    document.querySelectorAll("[data-market-preset]").forEach((button) => button.classList.toggle("active", button === preset));
    $("#price-max").value = marketFilters.max || ""; $("#price-band-filter").value = marketFilters.priceBand; $("#market-sort").value = marketFilters.sort;
    renderMarket(); return;
  }
  if (event.target.closest("#market-load-more")) { marketVisibleCount += 24; renderMarket(); return; }
  const mobileFilterToggle = event.target.closest("#mobile-filter-toggle");
  if (mobileFilterToggle) {
    const open = $("#market-filters").classList.toggle("mobile-open");
    mobileFilterToggle.setAttribute("aria-expanded", String(open));
    mobileFilterToggle.textContent = open ? "Скрыть фильтры" : "Фильтры и сортировка";
    return;
  }

  if (event.target.closest("[data-photo-source]")) return;
  const openMarket = event.target.closest("[data-open-market]");
  if (openMarket) { const car = state.market.find((item) => item.id === openMarket.dataset.openMarket); if (car) openModal(marketModal(car), car.id, "market"); return; }
  const openGarage = event.target.closest("[data-open-garage]");
  if (openGarage) { const car = state.player.garage.find((item) => item.id === openGarage.dataset.openGarage); if (car) openModal(garageModal(car), car.id, "garage"); return; }
  const listCar = event.target.closest("[data-list-car]");
  if (listCar) { const car = state.player.garage.find((item) => item.id === listCar.dataset.listCar); if (car) openModal(listModal(car), car.id, "list"); return; }

  const skill = event.target.closest("[data-skill]"); if (skill) return perform("/api/skill", { skill: skill.dataset.skill }, "Навык повышен");
  const equipment = event.target.closest("[data-equipment]"); if (equipment) return perform("/api/equipment", { equipment: equipment.dataset.equipment }, "Оборудование куплено");
  if (event.target.closest("[data-expand-garage]")) return perform("/api/garage/expand", {}, "В гараже появилось новое место");
  if (event.target.closest("[data-training]")) return perform("/api/training", {}, "Задание выполнено: получены XP и 7 000 ₽");
  const activityButton = event.target.closest("[data-activity]");
  if (activityButton) {
    if (activityButton.disabled) return;
    const key = activityButton.dataset.activity;
    const activity = state.player.activities?.catalog?.[key];
    if (!activity) return;
    const mode = key === "workshop" ? "sequence" : key === "negotiate" ? "choice" : key === "portfolio" ? "risk" : "timing";
    const score = await timingChallenge({ title: activity.name, task: activity.task, rounds: activity.rounds, mode });
    if (score === null) return;
    return perform("/api/activity", { activity: key, score }, `${activity.name}: награда начислена`);
  }
  const buyParts = event.target.closest("[data-buy-parts]"); if (buyParts) return perform("/api/parts/buy", { type: buyParts.dataset.buyParts, model: $(buyParts.dataset.buyParts === "premium" ? "#parts-model-premium" : "#parts-model")?.value }, "Деталь для выбранной модели добавлена на склад");
  const carUpgrade = event.target.closest("[data-car-upgrade]"); if (carUpgrade) return perform("/api/car/upgrade", { carId: carUpgrade.dataset.carUpgrade, upgrade: carUpgrade.dataset.upgrade }, "Улучшение установлено, ценность автомобиля обновлена");
  const buyMarketPart = event.target.closest("[data-buy-part-market]"); if (buyMarketPart) return perform("/api/parts/buy-market", { partId: buyMarketPart.dataset.buyPartMarket }, "Запчасть куплена на рынке");
  const listPart = event.target.closest("[data-list-part]"); if (listPart) return perform("/api/parts/list", { inventoryPartId: listPart.dataset.listPart, price: $(`#part-price-${listPart.dataset.listPart}`)?.value }, "Деталь выставлена на биржу");
  const orderPart = event.target.closest("[data-order-part]"); if (orderPart) return perform("/api/parts/order", { carId: orderPart.dataset.orderPart, defect: orderPart.dataset.defect, quality: orderPart.dataset.quality || "analog" }, "Деталь куплена и добавлена на склад");
  if (event.target.closest("[data-group-create]")) return perform("/api/group/create", { name: $("#group-name")?.value }, "Группа создана");
  if (event.target.closest("[data-group-join]")) return perform("/api/group/join", { groupId: $("#group-join-id")?.value }, "Вы вступили в группу");
  if (event.target.closest("[data-group-transfer]")) return perform("/api/group/transfer", { amount: $("#group-transfer-amount")?.value }, "Взнос отправлен в общую кассу");
  if (event.target.closest("[data-group-pay]")) return perform("/api/group/pay", { playerId: $("#group-pay-player")?.value, amount: $("#group-pay-amount")?.value }, "Деньги выданы участнику");
  const groupDepositCar = event.target.closest("[data-group-deposit-car]"); if (groupDepositCar) return perform("/api/group/garage/deposit", { carId: groupDepositCar.dataset.groupDepositCar }, "Машина передана в общий гараж");
  const groupWithdrawCar = event.target.closest("[data-group-withdraw-car]"); if (groupWithdrawCar) return perform("/api/group/garage/withdraw", { carId: groupWithdrawCar.dataset.groupWithdrawCar }, "Машина возвращена в личный гараж");
  const groupWorkCar = event.target.closest("[data-group-work-car]"); if (groupWorkCar) return perform("/api/group/garage/work", { carId: groupWorkCar.dataset.groupWorkCar }, "Сотрудники группы провели обслуживание");
  const hireEmployee = event.target.closest("[data-hire-employee]"); if (hireEmployee) return perform("/api/group/employee/hire", { employeeId: hireEmployee.dataset.hireEmployee }, "Сотрудник принят в группу");
  const startGroupJob = event.target.closest("[data-start-group-job]"); if (startGroupJob) return perform("/api/group/job/start", { employeeId: startGroupJob.dataset.employeeId, jobKey: startGroupJob.dataset.startGroupJob }, "Сотрудник приступил к заказу");
  const restoreEmployee = event.target.closest("[data-restore-employee]"); if (restoreEmployee) return perform("/api/group/employee/restore", { employeeId: restoreEmployee.dataset.restoreEmployee }, "Сотрудник отдохнул и восстановил энергию");
  const buy = event.target.closest("[data-buy]"); if (buy) { if (buy.disabled) return; if (await perform("/api/buy", { carId: buy.dataset.buy }, "Машина отправлена в гараж")) { closeModal(); setView("garage"); } else if (!state.market.some((car) => car.id === buy.dataset.buy)) { closeModal(); try { state = await request("/api/state"); render(); } catch { /* session will be handled by the event stream */ } } return; }
  const dismantle = event.target.closest("[data-dismantle]"); if (dismantle) return perform("/api/car/dismantle", { carId: dismantle.dataset.dismantle }, "Машина разобрана, детали отправлены на склад");
  const unlist = event.target.closest("[data-unlist]"); if (unlist) { if (await perform("/api/unlist", { carId: unlist.dataset.unlist }, "Объявление снято")) closeModal(); return; }
  const repair = event.target.closest("[data-repair]");
  if (repair) {
    let interactionScore = 0;
    if (repair.dataset.repairMode === "self") {
      const car = state.player.garage.find((item) => item.id === repair.dataset.repair);
      const defect = car?.defects.find((item) => item.code === repair.dataset.defect);
      interactionScore = await timingChallenge({ title: defect?.name || "Самостоятельный ремонт", task: "Практика ремонта", rounds: 2, mode: "repair", actions: repairChallengeFor(defect) });
      if (interactionScore === null) return;
    }
    return perform("/api/repair", { carId: repair.dataset.repair, defect: repair.dataset.defect, mode: repair.dataset.repairMode, interactionScore, partId: document.querySelector(`[data-part-select="${repair.dataset.repair}:${repair.dataset.defect}"]`)?.value || null }, repair.dataset.repairMode === "self" ? `Ремонт завершен · точность ${interactionScore}%` : repair.dataset.repairMode === "assisted" ? "Деталь установлена вместе с мастером" : "Сервис завершил ремонт");
  }
  const serviceDiagnostic = event.target.closest("[data-service-diagnostic]");
  if (serviceDiagnostic) return perform("/api/service-diagnostic", { carId: serviceDiagnostic.dataset.serviceDiagnostic }, "Сервис обнаружил все неисправности");
  const check = event.target.closest("[data-check]");
  if (check) {
    try {
      const interactionScore = await timingChallenge({ title: categoryNames[check.dataset.check] || "Осмотр узла", task: "Точный замер", rounds: 1 });
      if (interactionScore === null) return;
      const data = await request("/api/check", { method: "POST", body: JSON.stringify({ carId: check.dataset.carId, category: check.dataset.check, interactionScore }) });
      lastCheckResult = { ...data.checkResult, carId: check.dataset.carId }; state = data; render();
      showToast(data.checkResult.found.length ? `Обнаружено неисправностей: ${data.checkResult.found.length}` : "Явных неисправностей не обнаружено");
    } catch (error) { showToast(error.message, true); }
    return;
  }
  const marketCheck = event.target.closest("[data-market-check]");
  if (marketCheck) {
    try {
      const interactionScore = await timingChallenge({ title: categoryNames[marketCheck.dataset.marketCheck] || "Осмотр автомобиля", task: "Предпродажная проверка", rounds: 1 });
      if (interactionScore === null) return;
      const data = await request("/api/market-check", { method: "POST", body: JSON.stringify({ carId: marketCheck.dataset.carId, category: marketCheck.dataset.marketCheck, interactionScore }) });
      state = data; render();
      const updatedCar = state.market.find((item) => item.id === marketCheck.dataset.carId);
      if (updatedCar) openModal(marketModal(updatedCar), updatedCar.id, "market");
      showToast(data.checkResult.found.length ? `Найдено неисправностей: ${data.checkResult.found.length}` : "Явных неисправностей не обнаружено");
    } catch (error) { showToast(error.message, true); }
    return;
  }

  const offerAction = event.target.closest("[data-offer-action]");
  if (offerAction) {
    const action = offerAction.dataset.offerAction;
    const amount = action === "counter" ? $(`#counter-${offerAction.dataset.offerId}`)?.value : undefined;
    return perform("/api/offer/respond", { offerId: offerAction.dataset.offerId, action, amount }, action === "accept" ? "Предложение принято" : action === "reject" ? "Предложение отклонено" : "Встречная цена отправлена");
  }
  const acceptCounter = event.target.closest("[data-accept-counter]");
  if (acceptCounter) { if (await perform("/api/offer/accept-counter", { offerId: acceptCounter.dataset.acceptCounter }, "Машина куплена по встречной цене")) setView("garage"); }
  if (event.target.closest("#profile-button")) return setView("profile");
  if (event.target.closest("[data-logout]")) {
    localStorage.removeItem("perekup-token");
    if (events) events.close();
    location.reload();
  }
  const buyCash = event.target.closest("[data-buy-cash]");
  if (buyCash) {
    try { const data = await request("/api/store/create-payment", { method: "POST", body: JSON.stringify({ packageId: buyCash.dataset.buyCash }) }); if (data.confirmationUrl) location.href = data.confirmationUrl; }
    catch (error) { showToast(error.message, true); }
    return;
  }
  if (event.target.closest("[data-admin-refresh]")) return loadAdmin();
  const reportChat = event.target.closest("[data-report-chat]");
  if (reportChat) {
    const reason = window.prompt("Причина жалобы", "Оскорбление или нарушение правил");
    if (reason) await perform("/api/chat/report", { messageId: reportChat.dataset.reportChat, reason }, "Жалоба отправлена модераторам");
    return;
  }
  const buyAsset = event.target.closest("[data-buy-asset]");
  if (buyAsset) return perform("/api/assets/buy", { assetId: buyAsset.dataset.buyAsset }, "Актив добавлен в ваш портфель");
  const sellAsset = event.target.closest("[data-sell-asset]");
  if (sellAsset) return perform("/api/assets/sell", { assetId: sellAsset.dataset.sellAsset }, "Актив продан");
  if (event.target.closest("[data-asset-income]")) return perform("/api/assets/income", {}, "Доход от недвижимости получен");
  const reportAction = event.target.closest("[data-admin-report]");
  if (reportAction) { if (await perform("/api/admin/moderation", { action: reportAction.dataset.adminReport, reportId: reportAction.dataset.reportId }, "Жалоба обработана")) await loadAdmin(); return; }
  const reportBan = event.target.closest("[data-admin-report-ban]");
  if (reportBan) {
    const reason = window.prompt("Причина блокировки", "Нарушение правил чата");
    if (reason && await perform("/api/admin/moderation", { action: "ban", playerId: reportBan.dataset.playerId, durationMinutes: 1440, reason }, "Игрок заблокирован")) { await perform("/api/admin/moderation", { action: "resolve", reportId: reportBan.dataset.adminReportBan }, "Жалоба закрыта"); await loadAdmin(); }
    return;
  }
  const adminBan = event.target.closest("[data-admin-ban]");
  if (adminBan) { const playerId = adminBan.dataset.adminBan; if (await perform("/api/admin/moderation", { action: "ban", playerId, durationMinutes: Number($(`#admin-ban-duration-${playerId}`)?.value), reason: $(`#admin-ban-reason-${playerId}`)?.value }, "Игрок заблокирован")) await loadAdmin(); return; }
  const adminUnban = event.target.closest("[data-admin-unban]");
  if (adminUnban) { if (await perform("/api/admin/moderation", { action: "unban", playerId: adminUnban.dataset.adminUnban }, "Блокировка снята")) await loadAdmin(); return; }
  const adminValue = event.target.closest("[data-admin-value]");
  if (adminValue) {
    const playerId = adminValue.dataset.playerId;
    const cash = adminValue.dataset.adminValue === "cash";
    const payload = cash
      ? { playerId, cashMode: $(`#admin-cash-mode-${playerId}`)?.value, cashValue: $(`#admin-cash-${playerId}`)?.value, reason: $(`#admin-reason-${playerId}`)?.value }
      : { playerId, skillPointsMode: $(`#admin-skills-mode-${playerId}`)?.value, skillPointsValue: $(`#admin-skills-${playerId}`)?.value, reason: $(`#admin-reason-${playerId}`)?.value };
    if (await perform("/api/admin/player", payload, cash ? "Баланс игрока сохранён" : "Очки навыков сохранены")) await loadAdmin();
    return;
  }
});

document.addEventListener("submit", async (event) => {
  const carBidForm = event.target.closest("[data-car-bid]");
  if (carBidForm) {
    event.preventDefault(); const data = new FormData(carBidForm);
    return perform("/api/bid", { carId: carBidForm.dataset.carBid, amount: data.get("amount") }, "Ставка принята, сумма зарезервирована");
  }
  const containerForm = event.target.closest("[data-container-bid]");
  if (containerForm) {
    event.preventDefault(); const data = new FormData(containerForm);
    return perform("/api/container/bid", { containerId: containerForm.dataset.containerBid, amount: data.get("amount") }, "Ставка на контейнер принята");
  }
  if (event.target.id === "market-filters") {
    event.preventDefault();
    const data = new FormData(event.target);
    marketFilters = { query: String(data.get("query") || ""), min: Number(data.get("min")) || null, max: Number(data.get("max")) || null, saleType: data.get("saleType") || "all", className: data.get("className") || "all", condition: data.get("condition") || "all", priceBand: data.get("priceBand") || "all", sort: data.get("sort") || "new", fresh: false };
    marketVisibleCount = 24;
    document.querySelectorAll("[data-market-preset]").forEach((button) => button.classList.remove("active"));
    renderMarket();
    return;
  }
  if (event.target.id === "auction-filters") {
    event.preventDefault(); const data = new FormData(event.target);
    auctionFilters = { condition: data.get("condition") || "all", max: Number(data.get("max")) || null, seller: data.get("seller") || "all", sort: data.get("sort") || "ending" };
    renderAuctions(); return;
  }
  if (event.target.id === "asset-filters") {
    event.preventDefault(); const data = new FormData(event.target);
    assetFilters = { type: assetMode, category: data.get("category") || "all", min: Number(data.get("min")) || null, max: Number(data.get("max")) || null, sort: data.get("sort") || "deal" };
    renderAssets(); return;
  }
  if (event.target.id === "chat-form") {
    event.preventDefault();
    const input = $("#chat-input");
    if (await perform("/api/chat", { message: input.value }, "Сообщение отправлено")) input.value = "";
    return;
  }
  if (event.target.id === "list-form") {
    event.preventDefault(); const form = event.target; const data = new FormData(form);
    if (await perform("/api/list", { carId: form.dataset.carId, price: data.get("price"), description: data.get("description"), saleType: data.get("saleType"), durationSeconds: data.get("durationSeconds") }, data.get("saleType") === "auction" ? "Аукцион запущен. Вы остались в гараже" : "Объявление опубликовано. Вы остались в гараже")) closeModal();
  }
  if (event.target.id === "offer-form") {
    event.preventDefault(); const form = event.target; const data = new FormData(form);
    if (await perform("/api/offer", { carId: form.dataset.carId, amount: data.get("amount") }, "Продавец рассмотрел вашу цену")) { const purchased = state.player.garage.some((car) => car.id === form.dataset.carId); closeModal(); setView(purchased ? "garage" : "deals"); }
  }
  if (event.target.id === "bid-form") {
    event.preventDefault(); const form = event.target; const data = new FormData(form);
    if (await perform("/api/bid", { carId: form.dataset.carId, amount: data.get("amount") }, "Ставка принята, сумма зарезервирована")) refreshOpenModal();
  }
});

document.addEventListener("input", (event) => {
  if (event.target.matches("#list-form input[name='price']")) updateListingSummary();
  if (event.target.id === "parts-filter-query") { partsFilters.query = event.target.value; renderParts(); }
});

document.addEventListener("change", (event) => {
  if (event.target.matches("[data-group-role]")) perform("/api/group/role", { playerId: event.target.dataset.groupRole, role: event.target.value }, "Роль участника изменена");
  if (event.target.id === "parts-filter-component") { partsFilters.component = event.target.value; renderParts(); }
  if (event.target.id === "parts-filter-quality") { partsFilters.quality = event.target.value; renderParts(); }
});

$("#market-filters").addEventListener("reset", () => {
  marketFilters = { query: "", min: null, max: null, saleType: "all", className: "all", condition: "all", priceBand: "all", sort: "new", fresh: false };
  marketVisibleCount = 24;
  document.querySelectorAll("[data-market-preset]").forEach((button) => button.classList.toggle("active", button.dataset.marketPreset === "all"));
  setTimeout(renderMarket, 0);
});

$("#asset-filters").addEventListener("reset", () => {
  assetFilters = { type: assetMode, category: "all", min: null, max: null, sort: "deal" };
  setTimeout(renderAssets, 0);
});

$("#auction-filters").addEventListener("reset", () => {
  auctionFilters = { condition: "all", max: null, seller: "all", sort: "ending" };
  setTimeout(renderAuctions, 0);
});

document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("#car-modal").hidden) closeModal(); });
window.addEventListener("hashchange", () => { const view = location.hash.slice(1); if (document.getElementById(`${view}-view`) && state.player) setView(view); });
initAds();
async function restore() { if (!token) return; try { await enterGame(await request("/api/state")); } catch { localStorage.removeItem("perekup-token"); token = ""; } }
restore();
setInterval(() => { updateAuctionTimers(); updateMarketRotationTimer(); updateAssetIncomeTimer(); }, 1000);
document.addEventListener("contextmenu", (event) => event.preventDefault());
