const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const port = 4300 + (process.pid % 500);
const base = `http://localhost:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "perekup-test-"));
let server;

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, [path.join(__dirname, "server.js")], {
      env: { ...process.env, PORT: String(port), PEREKUP_DATA_DIR: dataDir, PEREKUP_BOT_ALWAYS: "1", PEREKUP_FAST_JOBS: "1", PEREKUP_ADMIN_NAMES: "TestAdmin" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const timeout = setTimeout(() => reject(new Error("Server start timed out")), 5000);
    server.stdout.on("data", (chunk) => {
      if (String(chunk).includes("Perekup Market")) { clearTimeout(timeout); resolve(); }
    });
    server.stderr.on("data", (chunk) => process.stderr.write(chunk));
    server.on("error", reject);
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server || server.exitCode !== null) return resolve();
    server.once("exit", resolve);
    server.kill();
  });
}

async function request(pathname, token, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${pathname}: ${data.error}`);
  return data;
}

async function requestError(pathname, token, body) {
  try {
    await request(pathname, token, body);
  } catch (error) {
    return error.message;
  }
  throw new Error(`${pathname}: request unexpectedly succeeded`);
}

function check(value, message) {
  if (!value) throw new Error(message);
}

function boostAccount(playerName) {
  const database = new DatabaseSync(path.join(dataDir, "game.db"));
  const row = database.prepare("SELECT payload FROM game_state WHERE id = 1").get();
  const saved = JSON.parse(row.payload);
  const entry = saved.players.find(([, player]) => player.name === playerName);
  for (const key of Object.keys(entry[1].skills)) entry[1].skills[key] = 5;
  for (const key of Object.keys(entry[1].equipment)) entry[1].equipment[key] = 3;
  entry[1].cash = 3000000;
  entry[1].garageCapacity = 10;
  database.prepare("UPDATE game_state SET payload = ?, updated_at = ? WHERE id = 1").run(JSON.stringify(saved), Date.now());
  database.close();
}

async function run() {
  await startServer();
  const suffix = Date.now().toString().slice(-7);
  const sellerName = `AuctionSeller${suffix}`;
  const buyerName = `AuctionBuyer${suffix}`;
  const seller = await request("/api/register", null, { name: sellerName, pin: "2468" });
  const buyer = await request("/api/register", null, { name: buyerName, pin: "1357" });
  check(seller.market.length >= 100, `Expected 100 market cars, got ${seller.market.length}`);
  check(new Set(seller.market.map((item) => item.className)).size >= 8, "Vehicle body variety is too low");
  check(Object.keys(seller.skillInfo).length >= 8 && Object.keys(seller.equipmentInfo).length >= 8, "Expanded inspection and repair specializations are missing");
  check(seller.market.filter((car) => !car.sellerId && car.saleType === "auction").length >= 8, "NPC sellers did not publish enough car auctions");
  check(new Set(seller.containerAuctions.map((container) => container.tier)).size === 5, "Five distinct container tiers were not stocked");
  check(seller.assetMarket.length >= 20 && seller.assetMarket.some((asset) => asset.type === "item") && seller.assetMarket.some((asset) => asset.type === "property"), "Item and property market was not stocked");
  check(["assetTrading", "collectibles", "propertyAppraisal", "propertyManagement"].every((skill) => seller.skillInfo[skill]), "Non-vehicle skills are missing");
  const auctionDisclosure = seller.market.find((car) => car.saleType === "auction" && car.defects.length);
  check(auctionDisclosure && auctionDisclosure.condition > 0 && auctionDisclosure.defects.every((defect) => defect.name), "Car auction did not disclose condition and defects");

  let assetTrader = await request("/api/register", null, { name: `AssetTrader${suffix}`, pin: "5566" });
  const assetTraderToken = assetTrader.token;
  const affordableAsset = assetTrader.assetMarket.filter((asset) => asset.type === "item" && asset.price < assetTrader.player.availableCash).sort((a, b) => a.price - b.price)[0];
  assetTrader = await request("/api/assets/buy", assetTraderToken, { assetId: affordableAsset.id });
  check(assetTrader.player.ownedAssets.length === 1 && assetTrader.player.stats.assetsBought === 1, "Purchased asset did not reach the portfolio");
  assetTrader = await request("/api/assets/sell", assetTraderToken, { assetId: assetTrader.player.ownedAssets[0].id });
  check(assetTrader.player.ownedAssets.length === 0 && assetTrader.player.stats.assetsSold === 1, "Asset resale did not complete");

  const admin = await request("/api/register", null, { name: "TestAdmin", pin: "9900" });
  const offender = await request("/api/register", null, { name: `Offender${suffix}`, pin: "9911" });
  const reporter = await request("/api/register", null, { name: `Reporter${suffix}`, pin: "9922" });
  const chatState = await request("/api/chat", offender.token, { message: "Проверочное сообщение для модерации" });
  const reportedMessage = chatState.chatMessages.at(-1);
  await request("/api/chat/report", reporter.token, { messageId: reportedMessage.id, reason: "Нарушение правил сообщества" });
  let adminState = await request("/api/admin/state", admin.token);
  check(adminState.reports.some((report) => report.accusedId === offender.player.id), "Chat report did not reach the admin queue");
  await request("/api/admin/moderation", admin.token, { action: "ban", playerId: offender.player.id, durationMinutes: 60, reason: "Тестовая блокировка" });
  check((await requestError("/api/state", offender.token)).includes("Аккаунт заблокирован"), "Banned player kept API access");
  await request("/api/admin/moderation", admin.token, { action: "unban", playerId: offender.player.id });
  check((await request("/api/state", offender.token)).player.id === offender.player.id, "Unbanned player did not regain access");
  const indexSeller = await request("/api/register", null, { name: `IndexSeller${suffix}`, pin: "1122" });
  const indexBuyer = await request("/api/register", null, { name: `IndexBuyer${suffix}`, pin: "3344" });
  const indexCarSeed = indexSeller.market.find((item) => item.saleType !== "auction" && item.price < 450000 && indexSeller.marketStats[item.model].marketPrice < 400000);
  const indexBeforeRise = indexSeller.marketStats[indexCarSeed.model].marketPrice;
  const indexPurchase = await request("/api/buy", indexSeller.token, { carId: indexCarSeed.id });
  const indexCar = indexPurchase.player.garage[0];
  const inflatedSalePrice = Math.min(600000, Math.round(indexBeforeRise * 1.4));
  await request("/api/list", indexSeller.token, { carId: indexCar.id, price: inflatedSalePrice, description: "Дорогая рыночная сделка", saleType: "fixed" });
  const indexSale = await request("/api/buy", indexBuyer.token, { carId: indexCar.id });
  check(indexSale.marketStats[indexCar.model].marketPrice > indexBeforeRise, "Above-market player transaction did not raise the model index");
  check(indexSale.marketStats[indexCar.model].trend > 0, "Market trend did not report the upward move");
  let sellerReady = await request("/api/skill", seller.token, { skill: "diagnostics" });
  sellerReady = await request("/api/equipment", seller.token, { equipment: "diagnosticKit" });
  const carSeed = sellerReady.market.filter((car) => car.saleType !== "auction" && car.price < 400000).sort((a, b) => a.price - b.price)[0];
  const purchased = await request("/api/buy", seller.token, { carId: carSeed.id });
  const car = purchased.player.garage[0];
  const inspected = await request("/api/check", seller.token, { carId: car.id, category: "engine" });
  check(inspected.player.stats.inspections === 1 && inspected.player.xp >= 20, "New career-based inspection did not work");
  const firstInspection = inspected.player.garage.find((item) => item.id === car.id).inspectionRecords.engine;
  await requestError("/api/check", seller.token, { carId: car.id, category: "engine" });
  const upgradedEquipment = await request("/api/equipment", seller.token, { equipment: "diagnosticKit" });
  const deeperInspection = await request("/api/check", seller.token, { carId: car.id, category: "engine" });
  const deeperRecord = deeperInspection.player.garage.find((item) => item.id === car.id).inspectionRecords.engine;
  check(deeperRecord.bestScore > firstInspection.bestScore && deeperRecord.confidence > firstInspection.confidence, "Equipment upgrade did not unlock deeper reinspection");
  check(!("hiddenDefectCount" in deeperInspection.player.garage.find((item) => item.id === car.id)), "Owner view leaks the exact hidden defect count");
  const startPrice = Math.max(1, Math.round(car.invested * 0.7));
  const indexBeforeSale = inspected.marketStats[car.model].marketPrice;
  await request("/api/list", seller.token, { carId: car.id, price: startPrice, description: "Тестовый аукцион", saleType: "auction", durationSeconds: 2 });
  const bidAmount = startPrice + 1234;
  const bid = await request("/api/bid", buyer.token, { carId: car.id, amount: bidAmount });
  check(bid.player.reservedCash === bidAmount, "Winning bid was not reserved");
  await new Promise((resolve) => setTimeout(resolve, 3200));
  const won = await request("/api/state", buyer.token);
  check(won.player.garage.some((item) => item.id === car.id), "Auction winner did not receive the car");
  check(won.player.cash === 650000 - bidAmount, "Auction payment was not charged");
  check(won.marketStats[car.model].marketPrice !== indexBeforeSale, "Completed transaction did not move the model market index");

  await stopServer();
  await startServer();
  const restored = await request("/api/login", null, { name: buyerName, pin: "1357" });
  check(restored.player.garage.some((item) => item.id === car.id), "Garage was not restored after restart");
  check(restored.player.cash === 650000 - bidAmount, "Balance was not restored after restart");

  await stopServer();
  boostAccount(buyerName);
  boostAccount(sellerName);
  await startServer();
  let expert = await request("/api/login", null, { name: buyerName, pin: "1357" });
  const expertToken = expert.token;
  let repairCar;
  let repairDefect;
  for (const candidate of expert.market.filter((item) => item.saleType !== "auction" && item.price < 600000).slice(0, 3)) {
    expert = await request("/api/buy", expertToken, { carId: candidate.id });
    const owned = expert.player.garage.find((item) => item.id === candidate.id);
    expert = await request("/api/service-diagnostic", expertToken, { carId: owned.id });
    repairCar = expert.player.garage.find((item) => item.id === owned.id);
    repairDefect = repairCar.defects.find((defect) => defect.selfRepairable && !defect.repaired);
    if (repairDefect) break;
  }
  check(repairDefect, "Could not find a self-repairable defect");
  expert = await request("/api/parts/order", expertToken, { carId: repairCar.id, defect: repairDefect.code, quality: "original" });
  const selfRepairPart = expert.player.partInventory.at(-1);
  check(selfRepairPart.partKey === repairDefect.partKey && selfRepairPart.compatibleModel === repairCar.model && selfRepairPart.reliability === 100, "Exact original repair part was not supplied");
  const cashBeforeRepair = expert.player.cash;
  const investedBeforeRepair = expert.player.garage.find((item) => item.id === repairCar.id).invested;
  expert = await request("/api/repair", expertToken, { carId: repairCar.id, defect: repairDefect.code, mode: "self", partId: selfRepairPart.id });
  check(expert.player.cash === cashBeforeRepair - repairDefect.selfRepairCost, "Self repair charged the wrong amount");
  check(expert.player.garage.find((item) => item.id === repairCar.id).invested === investedBeforeRepair + repairDefect.selfRepairCost + selfRepairPart.purchasePrice, "Purchased part cost was not included in car investment");
  check(expert.player.stats.selfRepairs === 1, "Self repair profile statistic was not updated");
  const valuedRepairCar = expert.player.garage.find((item) => item.id === repairCar.id);
  check(valuedRepairCar.saleEstimate.repairPremium > 0 && valuedRepairCar.saleEstimate.documentationPremium > 0, "Repaired and diagnosed car did not receive a seller-value premium");
  check(valuedRepairCar.saleEstimate.recommendedHigh >= valuedRepairCar.saleEstimate.recommendedLow && valuedRepairCar.saleEstimate.breakEven >= valuedRepairCar.invested, "Seller summary contains invalid pricing guidance");
  let assistedCar = repairCar;
  let assistedDefect = repairCar.defects.find((defect) => defect.selfRepairable && !defect.repaired && defect.code !== repairDefect.code);
  for (const candidate of expert.market.filter((item) => item.saleType !== "auction" && item.price < 600000).slice(0, 2)) {
    if (assistedDefect) break;
    expert = await request("/api/buy", expertToken, { carId: candidate.id });
    const owned = expert.player.garage.find((item) => item.id === candidate.id);
    expert = await request("/api/service-diagnostic", expertToken, { carId: owned.id });
    assistedCar = expert.player.garage.find((item) => item.id === owned.id);
    assistedDefect = assistedCar.defects.find((defect) => defect.selfRepairable && !defect.repaired);
  }
  check(assistedDefect, "Could not find a defect for assisted repair");
  expert = await request("/api/parts/order", expertToken, { carId: assistedCar.id, defect: assistedDefect.code, quality: "economy" });
  const assistedPart = expert.player.partInventory.at(-1);
  const cashBeforeAssisted = expert.player.cash;
  expert = await request("/api/repair", expertToken, { carId: assistedCar.id, defect: assistedDefect.code, mode: "assisted", partId: assistedPart.id });
  check(expert.player.cash === cashBeforeAssisted - assistedDefect.assistedRepairCost, "Assisted repair charged the wrong amount");
  check(expert.player.stats.assistedRepairs === 1, "Assisted repair profile statistic was not updated");

  let inspectedBeforePurchase;
  let publicCheck = expert;
  let publiclyFoundCodes = [];
  for (const candidate of expert.market.filter((item) => !item.sellerId && item.saleType !== "auction" && item.price < expert.player.availableCash).slice(0, 5)) {
    for (const category of expert.inspectionCategories) publicCheck = await request("/api/market-check", expertToken, { carId: candidate.id, category });
    const revealed = publicCheck.market.find((item) => item.id === candidate.id).defects.filter((defect) => defect.partRequired);
    if (revealed.length) { inspectedBeforePurchase = candidate; publiclyFoundCodes = revealed.map((defect) => defect.code); break; }
  }
  check(inspectedBeforePurchase && publiclyFoundCodes.length > 0, "Expert market inspection did not reveal any repairable defect");
  expert = await request("/api/buy", expertToken, { carId: inspectedBeforePurchase.id });
  const boughtAfterInspection = expert.player.garage.find((item) => item.id === inspectedBeforePurchase.id);
  check(publiclyFoundCodes.every((code) => boughtAfterInspection.defects.some((defect) => defect.code === code)), "Known market defects disappeared after purchase");
  check(!boughtAfterInspection.serviceDiagnosed && expert.partNeeds.some((need) => need.carId === boughtAfterInspection.id), "Known defect still requires a full service diagnostic before repair");

  let negotiator = await request("/api/register", null, { name: `NpcNegotiator${suffix}`, pin: "6677" });
  const negotiatorToken = negotiator.token;
  const npcFixed = negotiator.market.filter((item) => !item.sellerId && item.saleType !== "auction" && item.price < negotiator.player.availableCash).sort((a, b) => a.price - b.price)[0];
  negotiator = await request("/api/offer", negotiatorToken, { carId: npcFixed.id, amount: Math.max(1, Math.round(npcFixed.price * 0.9)) });
  const npcCounter = negotiator.player.outgoingOffers.find((offer) => offer.carId === npcFixed.id && offer.status === "counter");
  if (npcCounter) negotiator = await request("/api/offer/accept-counter", negotiatorToken, { offerId: npcCounter.id });
  check(negotiator.player.garage.some((item) => item.id === npcFixed.id), "NPC fixed-price negotiation did not result in a purchase");

  let novice = await request("/api/register", null, { name: `RepairNovice${suffix}`, pin: "7788" });
  const noviceToken = novice.token;
  check(Object.values(novice.player.skills).every((level) => level === 0) && Object.values(novice.player.equipment).every((level) => level === 0), "Repair novice unexpectedly has progression unlocks");
  const noviceSeed = novice.market.filter((item) => item.saleType !== "auction" && item.price < 250000).sort((a, b) => a.price - b.price)[0];
  novice = await request("/api/buy", noviceToken, { carId: noviceSeed.id });
  novice = await request("/api/service-diagnostic", noviceToken, { carId: noviceSeed.id });
  const noviceCar = novice.player.garage.find((item) => item.id === noviceSeed.id);
  const noviceDefect = noviceCar.defects.find((defect) => defect.selfRepairable && !defect.repaired);
  check(noviceDefect, "Diagnosed novice car has no physical repair need");
  check(novice.partNeeds.filter((need) => need.carId === noviceCar.id).length === noviceCar.defects.filter((defect) => defect.selfRepairable && !defect.repaired).length, "Not every diagnosed physical defect received an exact part need");
  novice = await request("/api/parts/order", noviceToken, { carId: noviceCar.id, defect: noviceDefect.code, quality: "economy" });
  const novicePart = novice.player.partInventory.at(-1);
  novice = await request("/api/repair", noviceToken, { carId: noviceCar.id, defect: noviceDefect.code, mode: "assisted", partId: novicePart.id });
  check(novice.player.stats.assistedRepairs === 1, "A novice could not hire a mechanic to install an owned exact part");

  const sellerAgain = await request("/api/login", null, { name: sellerName, pin: "2468" });
  const botLotSeed = sellerAgain.market.filter((item) => item.saleType !== "auction" && item.price < sellerAgain.player.availableCash).sort((a, b) => a.price - b.price)[0];
  const botLotPurchase = await request("/api/buy", sellerAgain.token, { carId: botLotSeed.id });
  const botLot = botLotPurchase.player.garage[0];
  await request("/api/list", sellerAgain.token, { carId: botLot.id, price: 1, description: "Честный аукцион", saleType: "auction", durationSeconds: 14 });
  await new Promise((resolve) => setTimeout(resolve, 8500));
  const duringAuction = await request("/api/state", sellerAgain.token);
  const activeLot = duringAuction.market.find((item) => item.id === botLot.id);
  check(activeLot?.highestBidderType === "bot" && activeLot.bidCount >= 2, `NPCs did not compete for an idle attractive auction: ${JSON.stringify(activeLot)}`);
  check(activeLot.highestBid <= activeLot.saleEstimate.recommendedHigh * 1.2, `NPC auction exceeded a rational valuation: ${JSON.stringify(activeLot)}`);
  await new Promise((resolve) => setTimeout(resolve, 6500));
  const afterNpcSale = await request("/api/state", sellerAgain.token);
  check(afterNpcSale.player.deals === 2, "NPC auction purchase did not complete");

  const chatNormal = await request("/api/chat", sellerAgain.token, { message: "Кто сегодня смотрит недорогие седаны?" });
  check(chatNormal.chatMessages.at(-1).text.includes("седаны"), "Normal chat message was not published");
  await new Promise((resolve) => setTimeout(resolve, 1600));
  const chatCensored = await request("/api/chat", sellerAgain.token, { message: "Вот это блядь цена" });
  check(!chatCensored.chatMessages.at(-1).text.toLocaleLowerCase("ru-RU").includes("блядь") && chatCensored.chatMessages.at(-1).text.includes("*"), "Chat profanity was not censored");
  const spamError = await requestError("/api/chat", sellerAgain.token, { message: "Вот это блядь цена" });
  check(/Слишком быстро|Одинаковые/.test(spamError), "Chat spam protection did not reject a rapid duplicate");
  const persistedMessageId = chatCensored.chatMessages.at(-1).id;
  await stopServer();
  await startServer();
  const chatRestored = await request("/api/login", null, { name: sellerName, pin: "2468" });
  check(chatRestored.chatMessages.some((message) => message.id === persistedMessageId), "Chat history was not restored after restart");

  let groupOwner = await request("/api/login", null, { name: buyerName, pin: "1357" });
  let groupMember = await request("/api/login", null, { name: sellerName, pin: "2468" });
  const ownerToken = groupOwner.token;
  const memberToken = groupMember.token;
  groupOwner = await request("/api/group/create", ownerToken, { name: `Test Group ${suffix}` });
  const groupId = groupOwner.player.group.id;
  groupMember = await request("/api/group/join", memberToken, { groupId });
  check(groupMember.player.group.members.length === 2, "Second player did not join the group");
  groupOwner = await request("/api/group/transfer", ownerToken, { amount: 300000 });
  const memberCashBeforePay = groupMember.player.cash;
  groupOwner = await request("/api/group/pay", ownerToken, { playerId: groupMember.player.id, amount: 12000 });
  groupMember = await request("/api/state", memberToken);
  check(groupMember.player.cash === memberCashBeforePay + 12000, "Treasury payout did not reach the member");
  groupOwner = await request("/api/group/role", ownerToken, { playerId: groupMember.player.id, role: "Механик" });
  groupMember = await request("/api/state", memberToken);
  check(groupMember.player.groupRole === "Механик" && groupMember.player.group.permissions.garage, "Mechanic role permissions were not applied");

  const garageSeed = groupOwner.market.filter((item) => item.saleType !== "auction" && item.price < groupOwner.player.availableCash).sort((a, b) => a.price - b.price)[0];
  groupOwner = await request("/api/buy", ownerToken, { carId: garageSeed.id });
  groupOwner = await request("/api/group/garage/deposit", ownerToken, { carId: garageSeed.id });
  check(groupOwner.player.group.garage.some((car) => car.id === garageSeed.id), "Car did not enter the shared garage");
  groupMember = await request("/api/group/garage/withdraw", memberToken, { carId: garageSeed.id });
  check(groupMember.player.garage.some((car) => car.id === garageSeed.id), "Authorized mechanic could not withdraw from shared garage");

  groupOwner = await request("/api/group/employee/hire", ownerToken, { employeeId: "employee_diagnostic_1" });
  check(groupOwner.player.group.employees.some((employee) => employee.id === "employee_diagnostic_1"), "Employee was not hired");
  const treasuryBeforeJob = groupOwner.player.group.treasury;
  groupOwner = await request("/api/group/job/start", ownerToken, { employeeId: "employee_diagnostic_1", jobKey: "inspection" });
  check(groupOwner.player.group.activeJobs.length === 1 && groupOwner.player.group.employees[0].energy < 100, "Group business job did not start or consume employee energy");
  await new Promise((resolve) => setTimeout(resolve, 1800));
  groupOwner = await request("/api/state", ownerToken);
  check(groupOwner.player.group.activeJobs.length === 0 && groupOwner.player.group.completedJobs === 1, "Group business job did not complete");
  check(groupOwner.player.group.treasury > treasuryBeforeJob && groupOwner.player.group.totalBusinessProfit > 0, "Completed group job did not create a rational profit");
  groupOwner = await request("/api/group/employee/restore", ownerToken, { employeeId: "employee_diagnostic_1" });
  check(groupOwner.player.group.employees[0].energy === 100, "Employee rest action did not restore energy");
  groupMember = await request("/api/service-diagnostic", memberToken, { carId: garageSeed.id });

  groupOwner = await request("/api/parts/buy", ownerToken, { type: "premium" });
  const exchangePart = groupOwner.player.partInventory.at(-1);
  const listingPrice = 40000;
  const sellerCashBeforePartSale = groupOwner.player.cash;
  groupOwner = await request("/api/parts/list", ownerToken, { inventoryPartId: exchangePart.id, price: listingPrice });
  check(!groupOwner.player.partInventory.some((part) => part.id === exchangePart.id), "Listed part remained in seller inventory");
  groupMember = await request("/api/parts/buy-market", memberToken, { partId: groupOwner.partsMarket.find((lot) => lot.item.id === exchangePart.id).id });
  check(groupMember.player.partInventory.some((part) => part.id === exchangePart.id), "Buyer did not receive the listed part");
  groupOwner = await request("/api/state", ownerToken);
  check(groupOwner.player.cash === sellerCashBeforePartSale + Math.round(listingPrice * 0.95), "Parts exchange did not apply the 5% commission correctly");

  let repairTarget = groupMember.player.garage.find((car) => car.defects.some((defect) => !defect.repaired && defect.partName));
  for (const candidate of groupMember.market.filter((car) => car.saleType !== "auction" && car.price < 150000).slice(0, 8)) {
    if (repairTarget) break;
    try {
      groupMember = await request("/api/buy", memberToken, { carId: candidate.id });
      groupMember = await request("/api/service-diagnostic", memberToken, { carId: candidate.id });
      repairTarget = groupMember.player.garage.find((car) => car.id === candidate.id && car.defects.some((defect) => !defect.repaired && defect.partName));
    } catch { /* another test actor may have taken the lot */ }
  }
  check(repairTarget, "No diagnosed car with an orderable part remained for the parts repair test");
  const repairDefectWithPart = repairTarget.defects.find((defect) => !defect.repaired && defect.partName);
  check(repairDefectWithPart, "No defect with an orderable model-specific part remained");
  groupMember = await request("/api/parts/order", memberToken, { carId: repairTarget.id, defect: repairDefectWithPart.code, quality: "analog" });
  const repairPart = groupMember.player.partInventory.at(-1);
  const repairCashBefore = groupMember.player.cash;
  groupMember = await request("/api/repair", memberToken, { carId: repairTarget.id, defect: repairDefectWithPart.code, mode: "workshop", partId: repairPart.id });
  const repairedWithPart = groupMember.player.garage.find((car) => car.id === repairTarget.id);
  check(!groupMember.player.partInventory.some((part) => part.id === repairPart.id), "Installed part was not consumed");
  check(repairedWithPart.installedParts.some((part) => part.id === repairPart.id), "Installed part was not recorded on the car");
  check(groupMember.player.cash > repairCashBefore - repairDefectWithPart.repair, "Installed part did not reduce the repair cash cost");

  await stopServer();
  await startServer();
  const groupRestored = await request("/api/login", null, { name: buyerName, pin: "1357" });
  check(groupRestored.player.group?.id === groupId && groupRestored.player.group.employees.length === 1, "Group and employees were not restored after restart");
  const memberRestored = await request("/api/login", null, { name: sellerName, pin: "2468" });
  check(memberRestored.player.garage.some((car) => car.installedParts.some((part) => part.id === repairPart.id)), "Installed part history was not restored after restart");
  console.log(`PASS: persistence, groups, treasury, roles, shared garage, employees, detailed parts exchange and installed repair parts; player bid ${bidAmount}`);
}

run().catch((error) => { console.error(`FAIL: ${error.message}`); process.exitCode = 1; })
  .finally(async () => {
    await stopServer();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
