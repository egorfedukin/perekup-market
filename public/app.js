const $ = (selector) => document.querySelector(selector);
const money = (value) => `${new Intl.NumberFormat("ru-RU").format(value)} ₽`;
const number = (value) => new Intl.NumberFormat("ru-RU").format(value);
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));

const categoryNames = { engine: "Двигатель", chassis: "Ходовая", body: "Кузов", electrics: "Электрика", tires: "Шины и колёса", documents: "Документы и VIN" };
const severityNames = { 1: "незначительно", 2: "серьёзно", 3: "критично" };
const vehicleClassNames = { classic: "Классика", hatch: "Хэтчбек", sedan: "Седан", suv: "Кроссовер / SUV", coupe: "Купе", van: "Фургон", electric: "Электромобиль", premium: "Премиум", wagon: "Универсал", pickup: "Пикап", roadster: "Родстер" };
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

function carArt(car, extraClass = "") {
  return `<div class="car-art vehicle-${escapeHtml(car.className)} ${extraClass}" style="--car-color:${escapeHtml(car.color)}">
    <span class="car-year">${car.year}</span><span class="seller-label">${escapeHtml(car.seller || "Гараж")}</span>
    <i class="car-window"></i><i class="wheel left"></i><i class="wheel right"></i>
  </div>`;
}

function conditionLabel(value) {
  if (value >= 72) return ["Хорошее", ""];
  if (value >= 52) return ["Есть нюансы", "mid"];
  return ["Требует внимания", "low"];
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
  $("#market-grid").innerHTML = shown.map((car) => {
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
  }).join("") || '<div class="empty-filter">По выбранным параметрам машин нет. Сбросьте часть фильтров.</div>';
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
  if ($("#common-parts")) $("#common-parts").textContent = `${state.player.parts.common} комплектов`;
  if ($("#premium-parts")) $("#premium-parts").textContent = `${state.player.parts.premium} комплектов`;
  const qualityNames = { original: "Оригинал", analog: "Аналог", restored: "Восстановленная" };
  const componentNames = { engine: "Двигатель", chassis: "Ходовая", body: "Кузов", electrics: "Электрика", tires: "Шины" };
  $("#parts-inventory-list").innerHTML = (state.player.partInventory || []).map((part) => `<article class="part-lot inventory"><div><span class="part-component">${componentNames[part.component] || "Деталь"}</span><strong>${escapeHtml(part.name)}</strong><small>${qualityNames[part.quality] || part.quality} · ресурс ${part.conditionPct}% · ${part.compatibleModel && part.compatibleModel !== "all" ? `для ${escapeHtml(part.compatibleModel)}` : "для совместимых моделей"}</small></div><span>${money(part.estimatedValue)}</span><div class="part-list-action"><input id="part-price-${part.id}" type="number" min="1" max="1000000" value="${part.estimatedValue}"><button class="primary-button" data-list-part="${part.id}">Выставить на рынок</button></div></article>`).join("") || '<div class="no-offers">Склад пуст. Купите конкретную деталь для модели или разберите автомобиль.</div>';
  $("#parts-market-list").innerHTML = (state.partsMarket || []).slice(0, 24).map((lot) => `<article class="part-lot"><div><strong>${escapeHtml(lot.item?.name || (lot.type === "premium" ? "Премиальный комплект" : "Обычный комплект"))}</strong><small>${lot.item ? `${qualityNames[lot.item.quality] || lot.item.quality} · ресурс ${lot.item.conditionPct}% · ${lot.item.compatibleModel && lot.item.compatibleModel !== "all" ? `для ${escapeHtml(lot.item.compatibleModel)}` : "универсально"}` : lot.condition === "used" ? "Б/у · проверено" : "Новый комплект"} · продавец ${escapeHtml(lot.seller)}</small></div><span>${money(lot.price)}</span><button class="secondary-button" data-buy-part-market="${lot.id}" ${lot.sellerId === state.player.id ? "disabled" : ""}>${lot.sellerId === state.player.id ? "Ваш лот" : "Купить"}</button></article>`).join("") || '<div class="no-offers">Рынок деталей пуст.</div>';
  const modelOptions = state.marketStats ? Object.keys(state.marketStats).map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join("") : "";
  if ($("#parts-model")) $("#parts-model").innerHTML = modelOptions;
  if ($("#parts-model-premium")) $("#parts-model-premium").innerHTML = modelOptions;
  const componentLabels = { engine: "Двигатель", chassis: "Ходовая", body: "Кузов", electrics: "Электрика", tires: "Шины" };
  if ($("#parts-market-trends")) $("#parts-market-trends").innerHTML = Object.values(state.partsMarketStats || {}).map((stat) => `<span><b>${componentLabels[stat.component] || stat.component}</b> ${money(stat.averagePrice)}<small>${stat.deals ? `сделок ${stat.deals}` : "ориентир"}</small></span>`).join("");
  $("#catalog-count").textContent = `${number(state.catalogCount || 1000)} моделей`;
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

function renderContainers() {
  const garageFull = state.player.garage.length >= state.player.garageCapacity;
  const containers = [...(state.containerAuctions || [])].sort((a, b) => Number(b.viewerLeading) - Number(a.viewerLeading) || Number(b.viewerParticipated) - Number(a.viewerParticipated) || a.endAt - b.endAt);
  $("#container-grid").innerHTML = containers.map((box) => {
    const current = box.highestBid || box.startingPrice;
    const minimum = box.highestBid ? current + Math.max(1000, Math.ceil(current * .02)) : current;
    const leading = box.highestBidderId === state.player.id;
    const bidState = leading ? "Вы лидируете" : box.viewerParticipated ? "Вашу ставку перебили" : "";
    return `<article class="container-card tier-${box.tier} ${box.viewerParticipated ? "player-lot" : ""} ${box.viewerParticipated && !leading ? "outbid-lot" : ""}" style="--box-color:${escapeHtml(box.color)}">${bidState ? `<div class="player-bid-status">${bidState}</div>` : ""}<div class="container-visual"><span>LOT ${box.id.slice(-4).toUpperCase()}</span><i></i><b>?</b></div><div class="container-info"><p class="eyebrow">${box.tier === "cheap" ? "Бюджетный" : box.tier === "middle" ? "Средний" : "Премиальный"} контейнер</p><h3>${escapeHtml(box.name)}</h3><span>Внутри авто стоимостью ${money(box.minValue)}–${money(box.maxValue)}</span><div class="container-bid-state"><strong>${money(current)}</strong><small>${box.highestBidderName ? `Лидирует ${escapeHtml(box.highestBidderName)}` : "Стартовая ставка"} · ставок ${box.bidCount}</small><time data-container-end="${box.endAt}">${auctionTime(box.endAt)}</time></div><form data-container-bid="${box.id}"><input name="amount" type="number" min="${minimum}" step="1000" value="${minimum}"><button class="primary-button" ${garageFull ? "disabled" : ""}>${garageFull ? "Нет места" : leading ? "Повысить ставку" : "Сделать ставку"}</button></form></div></article>`;
  }).join("");
}

function renderAuctions() {
  const auctions = state.market.filter((car) => car.saleType === "auction").sort((a, b) => Number(b.viewerLeading) - Number(a.viewerLeading) || Number(b.viewerParticipated) - Number(a.viewerParticipated) || a.auctionEnd - b.auctionEnd);
  $("#auction-count").textContent = auctions.length + (state.containerAuctions?.length || 0);
  $("#auction-car-grid").innerHTML = auctions.map((car) => {
    const [condition, conditionClass] = conditionLabel(car.condition);
    const status = car.viewerLeading ? "Вы лидируете" : car.viewerParticipated ? "Вашу ставку перебили" : car.sellerId === state.player.id ? "Ваш аукцион" : "";
    return `<button class="car-card auction-car ${car.viewerParticipated ? "player-lot" : ""} ${car.viewerParticipated && !car.viewerLeading ? "outbid-lot" : ""}" data-open-market="${car.id}">${status ? `<span class="player-bid-status">${status}</span>` : ""}${carArt(car)}<div class="car-info"><h3>${escapeHtml(car.model)}</h3><div class="car-meta"><span>${number(car.mileage)} км</span><span>${escapeHtml(car.seller)}</span></div><div class="car-price-row"><strong>${money(car.highestBid || car.startingPrice)}</strong><span class="condition ${conditionClass}">${condition}</span></div><div class="auction-note"><span>Ставок: ${car.bidCount}</span><span class="auction-timer" data-auction-end="${car.auctionEnd}">${auctionTime(car.auctionEnd)}</span></div></div></button>`;
  }).join("") || '<div class="empty-filter">Автомобильных аукционов сейчас нет.</div>';
  const notifications = state.player.notifications || [];
  $("#auction-notifications").innerHTML = notifications.slice(0, 5).map((item) => `<article class="auction-alert ${item.read ? "read" : ""}"><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.text)}</p></div><time>${new Date(item.createdAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</time></article>`).join("");
  $("#auction-notifications").hidden = !notifications.length;
  const unread = state.player.unreadNotifications || 0;
  $("#notification-count").hidden = !unread; $("#notification-count").textContent = unread;
  $("#more-badge").hidden = !unread; $("#more-badge").textContent = unread;
  const newest = notifications.find((item) => !item.read);
  if (newest && shownNotificationId !== newest.id) { shownNotificationId = newest.id; showToast(newest.text, true); }
}

function offerCard(offer, incoming) {
  const car = offer.car || { model: "Проданный автомобиль", price: 0 };
  const counter = offer.status === "counter";
  return `<article class="offer-card ${offer.buyerType === "bot" ? "bot" : ""}">
    <div class="offer-head"><div><strong>${escapeHtml(offer.buyerName)}</strong><p class="offer-car">${escapeHtml(car.model)} · цена ${money(car.price || offer.amount)}</p></div><span>${money(offer.amount)}</span></div>
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
  $("#leader-list").innerHTML = state.leaderboard.map((player, index) => `<div class="leader-row ${player.id === state.player.id ? "current" : ""}">
    <div class="leader-player"><span class="place">${index + 1}</span><span>${escapeHtml(player.name)}${player.id === state.player.id ? " (ты)" : ""} · ур. ${player.level}</span></div>
    <span>${player.deals}</span><span class="leader-profit">${player.profit >= 0 ? "+" : ""}${money(player.profit)}</span>
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
  $("#profile-career").textContent = `${player.level} уровень · ${player.xp} XP · ${player.deals} сделок`;
  $("#profile-cash").textContent = money(player.cash);
  $("#profile-reputation").textContent = `${player.reputation?.score || 50}/100`;
  const stats = [
    ["Покупки", player.stats.purchases], ["Прибыль", money(player.profit)],
    ["Осмотры", player.stats.inspections], ["Диагностики в сервисе", player.stats.serviceDiagnostics],
    ["Починил сам", player.stats.selfRepairs], ["С помощником", player.stats.assistedRepairs],
    ["Ремонты в сервисе", player.stats.workshopRepairs],
    ["Победы на аукционе", player.stats.auctionsWon], ["Ставки", player.stats.bids]
  ];
  $("#profile-stats").innerHTML = stats.map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("");
  $("#profile-skills").innerHTML = Object.entries(state.skillInfo).map(([key, info]) => `<div><span>${escapeHtml(info.name)}<small>${escapeHtml(info.description)}</small></span><strong>${player.skills[key]}/${info.maxLevel || 5}</strong></div>`).join("");
  $("#profile-equipment").innerHTML = Object.entries(state.equipmentInfo).map(([key, info]) => `<div><span>${escapeHtml(info.name)}</span><strong>${player.equipment[key]}/3</strong></div>`).join("");
  const group = player.group;
  $("#group-content").innerHTML = group ? `<div class="group-summary"><strong>${escapeHtml(group.name)}</strong><span>Рейтинг ${Math.round(group.rating)}/100 · касса ${money(group.treasury)}</span><small>Ваша роль: ${escapeHtml(player.groupRole || "Участник")} · общий гараж ${group.garage.length}/${group.garageCapacity} · ID: ${escapeHtml(group.id)}</small><div><input id="group-transfer-amount" type="number" min="1" placeholder="Сумма в общую кассу"><button class="secondary-button" data-group-transfer>Внести деньги</button></div>${group.permissions.treasury ? `<div><select id="group-pay-player">${group.members.map((member) => `<option value="${member.id}">${escapeHtml(member.name)}</option>`).join("")}</select><input id="group-pay-amount" type="number" min="1" placeholder="Сумма участнику"><button class="secondary-button" data-group-pay>Выдать из кассы</button></div>` : ""}</div>` : `<div class="group-create"><input id="group-name" maxlength="30" placeholder="Название новой группы"><button class="primary-button" data-group-create>Создать группу</button><input id="group-join-id" maxlength="40" placeholder="ID существующей группы"><button class="secondary-button" data-group-join>Вступить по ID</button><small>Владелец сможет назначать роли: управляющий, механик, оценщик или казначей.</small></div>`;
  $("#group-members").innerHTML = group ? `<h4>Участники</h4>${group.members.map((member) => `<div class="group-member"><div><strong>${escapeHtml(member.name)}</strong><small>${escapeHtml(member.role)}</small></div>${groupRoleSelect(member, group)}</div>`).join("")}` : "";
  $("#group-garage").innerHTML = group ? `<h4>Общий гараж</h4>${group.garage.length ? group.garage.map((car) => `<article class="group-car">${carArt(car)}<div><strong>${escapeHtml(car.model)}</strong><small>${car.year} · вложено ${money(car.invested)} · передал ${escapeHtml(car.groupContributorName || "участник")}</small></div><div class="group-car-actions"><button class="secondary-button" data-group-work-car="${car.id}">Обслужить NPC</button><button class="secondary-button" data-group-withdraw-car="${car.id}">Забрать</button></div></article>`).join("") : '<div class="no-offers">У группы пока нет общих автомобилей.</div>'}` : "";
  const specialtyNames = { diagnostics: "Диагностика", mechanics: "Ремонт", appraisal: "Оценка", sales: "Продажи" };
  $("#group-employees").innerHTML = group ? `<h4>Сотрудники</h4><div class="employee-grid">${group.employees.map((employee) => `<article class="employee-card hired"><strong>${escapeHtml(employee.name)}</strong><span>${escapeHtml(employee.title)} · рейтинг ${employee.rating}</span><small>Бонус: ${specialtyNames[employee.specialty]}</small></article>`).join("") || '<div class="no-offers">Сотрудников пока нет.</div>'}</div>${group.permissions.hire ? `<h4>Кандидаты</h4><div class="employee-grid">${(state.employeeCandidates || []).filter((candidate) => !group.employees.some((employee) => employee.id === candidate.id)).map((candidate) => `<article class="employee-card"><strong>${escapeHtml(candidate.name)}</strong><span>${escapeHtml(candidate.title)} · рейтинг ${candidate.rating}</span><small>${specialtyNames[candidate.specialty]} · найм ${money(candidate.hireCost)}</small><button class="secondary-button" data-hire-employee="${candidate.id}">Нанять</button></article>`).join("")}</div>` : ""}` : "";
  $("#npc-list").innerHTML = (state.npcProfiles || []).map((npc) => `<div class="npc-row"><div><strong>${escapeHtml(npc.name)}</strong><small>${escapeHtml(npc.type)} · бюджет ${money(npc.budget)}</small></div><span>Рейтинг ${npc.rating}/100</span></div>`).join("");
}

function renderStore() {
  const store = state.store || { enabled: false, packages: [] };
  $("#store-status").textContent = store.enabled ? `Оплата через ${store.provider}` : "Приём платежей готовится";
  $("#store-packages").innerHTML = store.packages.map((pack) => `<article class="store-package"><span>${escapeHtml(pack.name)}</span><strong>${money(pack.cash)}</strong><small>игровых рублей</small><button class="danger-button" data-buy-cash="${pack.id}" ${store.enabled ? "" : "disabled"}>${store.enabled ? `Купить за ${pack.rubles} ₽` : "Скоро"}</button></article>`).join("");
}

function renderAdmin() {
  $("#admin-tab").hidden = !state.player.isAdmin;
  if (!state.player.isAdmin || !adminState) return;
  const economy = adminState.economy;
  $("#admin-economy").innerHTML = [["Игроков", economy.players], ["Авто на рынке", economy.marketCars], ["Завершённых сделок", economy.deals], ["Активных предложений", economy.activeOffers], ["Оплаченных заказов", economy.payments]].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("");
  $("#admin-players").innerHTML = adminState.players.map((player) => `<article class="admin-player"><div><strong>${escapeHtml(player.name)}</strong><small>Уровень ${player.level} · сделок ${player.deals} · гараж ${player.garage} · репутация ${player.reputation}</small></div><span>${money(player.cash)}<small>куплено ${money(player.purchasedCash)}</small></span><div class="admin-actions"><input id="admin-cash-${player.id}" type="number" step="1000" placeholder="+/- сумма"><input id="admin-reason-${player.id}" maxlength="100" placeholder="Причина"><button class="secondary-button" data-admin-cash="${player.id}">Применить</button></div></article>`).join("");
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
    <div><strong>${escapeHtml(message.playerName)}</strong><time>${new Date(message.createdAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</time></div>
    <p>${escapeHtml(message.text)}</p>
  </div>`).join("") : '<div class="chat-empty">Сообщений пока нет.</div>';
  if (nearBottom) container.scrollTop = container.scrollHeight;
}

function render() {
  if (!state.player) return;
  $("#cash").textContent = money(state.player.availableCash);
  $("#cash").title = state.player.reservedCash ? `Баланс ${money(state.player.cash)}, в ставках зарезервировано ${money(state.player.reservedCash)}` : `Баланс ${money(state.player.cash)}`;
  $("#profile-name").textContent = state.player.name;
  $("#avatar").textContent = state.player.name[0].toUpperCase();
  renderMarketStats(); renderMarket(); renderGarage(); renderOffers(); renderLeaderboard(); renderProfile(); renderChat(); renderStore(); renderAdmin(); renderContainers(); renderAuctions();
  if (modalCarId && !$("#car-modal").hidden) refreshOpenModal();
  maybeOpenContainerReward();
}

function setView(view) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
  document.querySelectorAll(".view").forEach((section) => section.classList.toggle("active-view", section.id === `${view}-view`));
  document.querySelector(".more-menu")?.removeAttribute("open");
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
  const canOffer = car.sellerId && !own && !auction && car.price > 1;
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
    ${auction && !own ? `<form id="bid-form" class="bid-form" data-car-id="${car.id}"><input name="amount" type="number" min="${car.highestBid ? car.highestBid + Math.max(1, Math.ceil(car.highestBid * .01)) : car.startingPrice}" step="1" value="${car.highestBid ? car.highestBid + Math.max(1, Math.ceil(car.highestBid * .01)) : car.startingPrice}" required><button class="danger-button" type="submit">Сделать ставку</button></form>` : ""}
    ${canOffer ? `<form id="offer-form" class="offer-form" data-car-id="${car.id}"><input name="amount" type="number" min="1" max="${car.price - 1}" step="1" value="${Math.max(1, Math.round(car.price * .92))}" required><button class="secondary-button" type="submit">Предложить цену</button></form>` : ""}
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
    <strong>${categoryNames[category]}</strong><small>${status}<br>${state.skillInfo[requirement.skill].name} ${skillLevel}/5 · ${state.equipmentInfo[requirement.equipment].name} ${equipmentLevel}/3</small>
  </button>`;
}

function defectRow(car, defect) {
  const skillName = state.skillInfo[defect.repairSkill]?.name || "Специалист";
  const equipmentName = state.equipmentInfo[defect.repairEquipment]?.name || "Инструмент";
  const canSelf = defect.selfRepairable && state.player.skills[defect.repairSkill] >= defect.repairSkillLevel && state.player.equipment[defect.repairEquipment] >= defect.repairEquipmentLevel;
  const canAssisted = defect.selfRepairable && state.player.skills[defect.repairSkill] >= defect.assistedSkillLevel && state.player.equipment[defect.repairEquipment] >= defect.assistedEquipmentLevel;
  const skillCurrent = state.player.skills[defect.repairSkill] || 0;
  const equipmentCurrent = state.player.equipment[defect.repairEquipment] || 0;
  const compatibleParts = (state.player.partInventory || []).filter((part) => [defect.category, "universal"].includes(part.component) && ["all", car.className].includes(part.compatibleClass) && (!part.compatibleModel || part.compatibleModel === "all" || part.compatibleModel === car.model) && (!defect.partName || part.name.includes(defect.partName)));
  return `<div class="defect-row ${defect.repaired ? "repaired" : ""}">
    <strong>${escapeHtml(defect.name)} <span class="severity">${severityNames[defect.severity]}</span><small class="defect-detail">${escapeHtml(defect.symptom)}<br>Риск: ${escapeHtml(defect.consequence)}${defect.selfRepairable ? `<br>Готовность: ${skillName} ${skillCurrent}/5 · ${equipmentName} ${equipmentCurrent}/3` : "<br>Только специализированный сервис"}</small></strong>
    ${defect.repaired ? "<span>Устранено</span>" : `<div class="repair-actions">${defect.partName ? `<button class="part-order-button" data-order-part="${car.id}" data-defect="${defect.code}">Заказать: ${escapeHtml(defect.partName)}</button>` : ""}${compatibleParts.length ? `<select data-part-select="${defect.code}"><option value="">Без складской детали</option>${compatibleParts.map((part) => `<option value="${part.id}">${escapeHtml(part.name)} · ${part.conditionPct}% · скидка до ${money(Math.round(part.estimatedValue * .65))}</option>`).join("")}</select>` : ""}<button class="secondary-button" data-repair="${car.id}" data-defect="${defect.code}" data-repair-mode="workshop">Сервис · ${money(defect.repair)}</button><button class="secondary-button" data-repair="${car.id}" data-defect="${defect.code}" data-repair-mode="assisted" ${canAssisted ? "" : "disabled"}>С помощником · ${money(defect.assistedRepairCost)}</button><button class="primary-button" data-repair="${car.id}" data-defect="${defect.code}" data-repair-mode="self" ${canSelf ? "" : "disabled"}>Самостоятельно · ${money(defect.selfRepairCost)}</button></div>`}
  </div>`;
}

function garageModal(car) {
  const open = car.defects.filter((defect) => !defect.repaired);
  const result = lastCheckResult && lastCheckResult.carId === car.id ? lastCheckResult : null;
  return `${carArt(car, "modal-car-art")}<div class="modal-body">
    <p class="eyebrow">Самостоятельный осмотр</p><h2 id="modal-title">${escapeHtml(car.model)}</h2>
    <p class="modal-subtitle">Состояние ${car.condition}% · вложено ${money(car.invested)}</p>
    ${!car.serviceDiagnosed ? `<div class="service-diagnostic"><div><strong>Полная диагностика в сервисе</strong><span>Заключение даёт 100% уверенности и повышает доверие покупателей. Выгодно, пока личный осмотр недостаточно глубокий.</span></div><button class="danger-button" data-service-diagnostic="${car.id}">${money(car.serviceDiagnosticCost)}</button></div>` : `<div class="inspection-summary"><strong>Диагностика сервиса завершена.</strong> Все неисправности известны, заключение увеличивает ликвидность машины.</div>`}
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
  const interest = price <= estimate.expectedNpcPrice ? ["Высокий интерес NPC", "high-interest"] : price <= estimate.recommendedHigh ? ["Средний интерес NPC", "medium-interest"] : ["Низкий интерес NPC", "low-interest"];
  $("#npc-interest").textContent = interest[0];
  $("#npc-interest").className = interest[1];
  $("#projected-profit").textContent = `${profit >= 0 ? "Прогноз прибыли +" : "Прогноз убытка "}${money(Math.abs(profit))}`;
  $("#projected-profit").className = profit >= 0 ? "profit-positive" : "profit-negative";
}

function openModal(content, carId, mode) {
  modalCarId = carId; modalMode = mode;
  $("#modal-content").innerHTML = content;
  $("#car-modal").classList.toggle("reward-modal", mode === "reward");
  $("#car-modal").hidden = false;
  document.body.style.overflow = "hidden";
  updateListingSummary();
}
function closeModal(force = false) { if (modalMode === "reward" && !force) return; $("#car-modal").hidden = true; $("#car-modal").classList.remove("reward-modal"); document.body.style.overflow = ""; modalCarId = null; modalMode = null; lastCheckResult = null; }
function refreshOpenModal() {
  const marketCar = state.market.find((car) => car.id === modalCarId);
  const garageCar = state.player.garage.find((car) => car.id === modalCarId);
  if (modalMode === "list" && garageCar) return;
  else if (modalMode === "garage" && garageCar) $("#modal-content").innerHTML = garageModal(garageCar);
  else if (modalMode === "market" && marketCar) $("#modal-content").innerHTML = marketModal(marketCar);
  else closeModal();
}

function connectEvents() {
  if (events) events.close();
  events = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  events.addEventListener("update", (event) => { state = JSON.parse(event.data); render(); });
  events.onerror = () => { $("#online-label").textContent = "Переподключение…"; };
  events.onopen = () => { $("#online-label").textContent = "Рынок онлайн"; };
}

async function enterGame(data) {
  state = data; $("#join-screen").hidden = true; $("#game").hidden = false; render(); connectEvents();
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
  if (event.target.closest("[data-go-market]")) return setView("market");
  if (event.target.closest("[data-close-modal]")) return closeModal();

  const claimReward = event.target.closest("[data-claim-reward]");
  if (claimReward) {
    if (await perform("/api/container/reward/ack", { rewardId: claimReward.dataset.claimReward }, "Автомобиль добавлен в гараж")) { closeModal(true); setView("garage"); maybeOpenContainerReward(); }
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
  const buyParts = event.target.closest("[data-buy-parts]"); if (buyParts) return perform("/api/parts/buy", { type: buyParts.dataset.buyParts, model: $(buyParts.dataset.buyParts === "premium" ? "#parts-model-premium" : "#parts-model")?.value }, "Деталь для выбранной модели добавлена на склад");
  const carUpgrade = event.target.closest("[data-car-upgrade]"); if (carUpgrade) return perform("/api/car/upgrade", { carId: carUpgrade.dataset.carUpgrade, upgrade: carUpgrade.dataset.upgrade }, "Улучшение установлено, ценность автомобиля обновлена");
  const buyMarketPart = event.target.closest("[data-buy-part-market]"); if (buyMarketPart) return perform("/api/parts/buy-market", { partId: buyMarketPart.dataset.buyPartMarket }, "Запчасть куплена на рынке");
  const listPart = event.target.closest("[data-list-part]"); if (listPart) return perform("/api/parts/list", { inventoryPartId: listPart.dataset.listPart, price: $(`#part-price-${listPart.dataset.listPart}`)?.value }, "Деталь выставлена на биржу");
  const orderPart = event.target.closest("[data-order-part]"); if (orderPart) return perform("/api/parts/order", { carId: orderPart.dataset.orderPart, defect: orderPart.dataset.defect, quality: "analog" }, "Нужная деталь заказана и добавлена на склад");
  if (event.target.closest("[data-group-create]")) return perform("/api/group/create", { name: $("#group-name")?.value }, "Группа создана");
  if (event.target.closest("[data-group-join]")) return perform("/api/group/join", { groupId: $("#group-join-id")?.value }, "Вы вступили в группу");
  if (event.target.closest("[data-group-transfer]")) return perform("/api/group/transfer", { amount: $("#group-transfer-amount")?.value }, "Взнос отправлен в общую кассу");
  if (event.target.closest("[data-group-pay]")) return perform("/api/group/pay", { playerId: $("#group-pay-player")?.value, amount: $("#group-pay-amount")?.value }, "Деньги выданы участнику");
  const groupDepositCar = event.target.closest("[data-group-deposit-car]"); if (groupDepositCar) return perform("/api/group/garage/deposit", { carId: groupDepositCar.dataset.groupDepositCar }, "Машина передана в общий гараж");
  const groupWithdrawCar = event.target.closest("[data-group-withdraw-car]"); if (groupWithdrawCar) return perform("/api/group/garage/withdraw", { carId: groupWithdrawCar.dataset.groupWithdrawCar }, "Машина возвращена в личный гараж");
  const groupWorkCar = event.target.closest("[data-group-work-car]"); if (groupWorkCar) return perform("/api/group/garage/work", { carId: groupWorkCar.dataset.groupWorkCar }, "Сотрудники группы провели обслуживание");
  const hireEmployee = event.target.closest("[data-hire-employee]"); if (hireEmployee) return perform("/api/group/employee/hire", { employeeId: hireEmployee.dataset.hireEmployee }, "Сотрудник принят в группу");
  const buy = event.target.closest("[data-buy]"); if (buy) { if (buy.disabled) return; if (await perform("/api/buy", { carId: buy.dataset.buy }, "Машина отправлена в гараж")) { closeModal(); setView("garage"); } else if (!state.market.some((car) => car.id === buy.dataset.buy)) { closeModal(); try { state = await request("/api/state"); render(); } catch { /* session will be handled by the event stream */ } } return; }
  const dismantle = event.target.closest("[data-dismantle]"); if (dismantle) return perform("/api/car/dismantle", { carId: dismantle.dataset.dismantle }, "Машина разобрана, детали отправлены на склад");
  const unlist = event.target.closest("[data-unlist]"); if (unlist) { if (await perform("/api/unlist", { carId: unlist.dataset.unlist }, "Объявление снято")) closeModal(); return; }
  const repair = event.target.closest("[data-repair]"); if (repair) return perform("/api/repair", { carId: repair.dataset.repair, defect: repair.dataset.defect, mode: repair.dataset.repairMode, partId: document.querySelector(`[data-part-select="${repair.dataset.defect}"]`)?.value || null }, repair.dataset.repairMode === "self" ? "Вы самостоятельно устранили неисправность" : repair.dataset.repairMode === "assisted" ? "Ремонт выполнен вместе с мастером" : "Ремонт выполнен в сервисе");
  const serviceDiagnostic = event.target.closest("[data-service-diagnostic]");
  if (serviceDiagnostic) return perform("/api/service-diagnostic", { carId: serviceDiagnostic.dataset.serviceDiagnostic }, "Сервис обнаружил все неисправности");
  const check = event.target.closest("[data-check]");
  if (check) {
    try {
      const data = await request("/api/check", { method: "POST", body: JSON.stringify({ carId: check.dataset.carId, category: check.dataset.check }) });
      lastCheckResult = { ...data.checkResult, carId: check.dataset.carId }; state = data; render();
      showToast(data.checkResult.found.length ? `Обнаружено неисправностей: ${data.checkResult.found.length}` : "Явных неисправностей не обнаружено");
    } catch (error) { showToast(error.message, true); }
    return;
  }
  const marketCheck = event.target.closest("[data-market-check]");
  if (marketCheck) {
    try {
      const data = await request("/api/market-check", { method: "POST", body: JSON.stringify({ carId: marketCheck.dataset.carId, category: marketCheck.dataset.marketCheck }) });
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
  const adAction = event.target.closest("[data-ad-action]"); if (adAction) return showToast("Рекламный слот готов к подключению партнёрской сети");
  const buyCash = event.target.closest("[data-buy-cash]");
  if (buyCash) {
    try { const data = await request("/api/store/create-payment", { method: "POST", body: JSON.stringify({ packageId: buyCash.dataset.buyCash }) }); if (data.confirmationUrl) location.href = data.confirmationUrl; }
    catch (error) { showToast(error.message, true); }
    return;
  }
  if (event.target.closest("[data-admin-refresh]")) return loadAdmin();
  const adminCash = event.target.closest("[data-admin-cash]");
  if (adminCash) {
    const playerId = adminCash.dataset.adminCash;
    if (await perform("/api/admin/player", { playerId, cashDelta: $(`#admin-cash-${playerId}`)?.value, reason: $(`#admin-reason-${playerId}`)?.value }, "Баланс игрока изменён")) await loadAdmin();
    return;
  }
});

document.addEventListener("submit", async (event) => {
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
  if (event.target.id === "chat-form") {
    event.preventDefault();
    const input = $("#chat-input");
    if (await perform("/api/chat", { message: input.value }, "Сообщение отправлено")) input.value = "";
    return;
  }
  if (event.target.id === "list-form") {
    event.preventDefault(); const form = event.target; const data = new FormData(form);
    if (await perform("/api/list", { carId: form.dataset.carId, price: data.get("price"), description: data.get("description"), saleType: data.get("saleType"), durationSeconds: data.get("durationSeconds") }, data.get("saleType") === "auction" ? "Аукцион запущен" : "Объявление опубликовано. NPC уже оценивают машину.")) { closeModal(); setView("market"); }
  }
  if (event.target.id === "offer-form") {
    event.preventDefault(); const form = event.target; const data = new FormData(form);
    if (await perform("/api/offer", { carId: form.dataset.carId, amount: data.get("amount") }, "Предложение отправлено продавцу")) { closeModal(); setView("deals"); }
  }
  if (event.target.id === "bid-form") {
    event.preventDefault(); const form = event.target; const data = new FormData(form);
    if (await perform("/api/bid", { carId: form.dataset.carId, amount: data.get("amount") }, "Ставка принята, сумма зарезервирована")) refreshOpenModal();
  }
});

document.addEventListener("input", (event) => {
  if (event.target.matches("#list-form input[name='price']")) updateListingSummary();
});

document.addEventListener("change", (event) => {
  if (event.target.matches("[data-group-role]")) perform("/api/group/role", { playerId: event.target.dataset.groupRole, role: event.target.value }, "Роль участника изменена");
});

$("#market-filters").addEventListener("reset", () => {
  marketFilters = { query: "", min: null, max: null, saleType: "all", className: "all", condition: "all", priceBand: "all", sort: "new", fresh: false };
  marketVisibleCount = 24;
  document.querySelectorAll("[data-market-preset]").forEach((button) => button.classList.toggle("active", button.dataset.marketPreset === "all"));
  setTimeout(renderMarket, 0);
});

document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("#car-modal").hidden) closeModal(); });
async function restore() { if (!token) return; try { await enterGame(await request("/api/state")); } catch { localStorage.removeItem("perekup-token"); token = ""; } }
restore();
setInterval(() => { updateAuctionTimers(); updateMarketRotationTimer(); }, 1000);
document.addEventListener("contextmenu", (event) => event.preventDefault());
