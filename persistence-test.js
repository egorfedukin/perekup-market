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
      env: { ...process.env, PORT: String(port), PEREKUP_DATA_DIR: dataDir, PEREKUP_BOT_ALWAYS: "1" },
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
  check(Object.keys(seller.skillInfo).length === 5 && Object.keys(seller.equipmentInfo).length === 5, "Career system was not simplified to five coherent branches");
  const indexSeller = await request("/api/register", null, { name: `IndexSeller${suffix}`, pin: "1122" });
  const indexBuyer = await request("/api/register", null, { name: `IndexBuyer${suffix}`, pin: "3344" });
  const indexCarSeed = indexSeller.market.find((item) => item.price < 450000 && indexSeller.marketStats[item.model].marketPrice < 400000);
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
  const carSeed = sellerReady.market.filter((car) => car.price < 400000).sort((a, b) => a.price - b.price)[0];
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
  await startServer();
  let expert = await request("/api/login", null, { name: buyerName, pin: "1357" });
  const expertToken = expert.token;
  let repairCar;
  let repairDefect;
  for (const candidate of expert.market.filter((item) => item.price < 600000).slice(0, 3)) {
    expert = await request("/api/buy", expertToken, { carId: candidate.id });
    const owned = expert.player.garage.find((item) => item.id === candidate.id);
    expert = await request("/api/service-diagnostic", expertToken, { carId: owned.id });
    repairCar = expert.player.garage.find((item) => item.id === owned.id);
    repairDefect = repairCar.defects.find((defect) => defect.selfRepairable && !defect.repaired);
    if (repairDefect) break;
  }
  check(repairDefect, "Could not find a self-repairable defect");
  const cashBeforeRepair = expert.player.cash;
  expert = await request("/api/repair", expertToken, { carId: repairCar.id, defect: repairDefect.code, mode: "self" });
  check(expert.player.cash === cashBeforeRepair - repairDefect.selfRepairCost, "Self repair charged the wrong amount");
  check(expert.player.stats.selfRepairs === 1, "Self repair profile statistic was not updated");
  const valuedRepairCar = expert.player.garage.find((item) => item.id === repairCar.id);
  check(valuedRepairCar.saleEstimate.repairPremium > 0 && valuedRepairCar.saleEstimate.documentationPremium > 0, "Repaired and diagnosed car did not receive a seller-value premium");
  check(valuedRepairCar.saleEstimate.recommendedHigh >= valuedRepairCar.saleEstimate.recommendedLow && valuedRepairCar.saleEstimate.breakEven >= valuedRepairCar.invested, "Seller summary contains invalid pricing guidance");
  let assistedCar = repairCar;
  let assistedDefect = repairCar.defects.find((defect) => defect.selfRepairable && !defect.repaired && defect.code !== repairDefect.code);
  for (const candidate of expert.market.filter((item) => item.price < 600000).slice(0, 2)) {
    if (assistedDefect) break;
    expert = await request("/api/buy", expertToken, { carId: candidate.id });
    const owned = expert.player.garage.find((item) => item.id === candidate.id);
    expert = await request("/api/service-diagnostic", expertToken, { carId: owned.id });
    assistedCar = expert.player.garage.find((item) => item.id === owned.id);
    assistedDefect = assistedCar.defects.find((defect) => defect.selfRepairable && !defect.repaired);
  }
  check(assistedDefect, "Could not find a defect for assisted repair");
  const cashBeforeAssisted = expert.player.cash;
  expert = await request("/api/repair", expertToken, { carId: assistedCar.id, defect: assistedDefect.code, mode: "assisted" });
  check(expert.player.cash === cashBeforeAssisted - assistedDefect.assistedRepairCost, "Assisted repair charged the wrong amount");
  check(expert.player.stats.assistedRepairs === 1, "Assisted repair profile statistic was not updated");

  const sellerAgain = await request("/api/login", null, { name: sellerName, pin: "2468" });
  const botLotSeed = sellerAgain.market.filter((item) => item.price < sellerAgain.player.availableCash).sort((a, b) => a.price - b.price)[0];
  const botLotPurchase = await request("/api/buy", sellerAgain.token, { carId: botLotSeed.id });
  const botLot = botLotPurchase.player.garage[0];
  await request("/api/list", sellerAgain.token, { carId: botLot.id, price: 1, description: "Честный аукцион", saleType: "auction", durationSeconds: 8 });
  await new Promise((resolve) => setTimeout(resolve, 4800));
  const duringAuction = await request("/api/state", sellerAgain.token);
  const activeLot = duringAuction.market.find((item) => item.id === botLot.id);
  check(activeLot?.highestBidderType === "bot" && activeLot.highestBid >= 1, `Rational NPC did not enter an attractive auction: ${JSON.stringify(activeLot)}`);
  await new Promise((resolve) => setTimeout(resolve, 4300));
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

  const garageSeed = groupOwner.market.filter((item) => item.price < groupOwner.player.availableCash).sort((a, b) => a.price - b.price)[0];
  groupOwner = await request("/api/buy", ownerToken, { carId: garageSeed.id });
  groupOwner = await request("/api/group/garage/deposit", ownerToken, { carId: garageSeed.id });
  check(groupOwner.player.group.garage.some((car) => car.id === garageSeed.id), "Car did not enter the shared garage");
  groupMember = await request("/api/group/garage/withdraw", memberToken, { carId: garageSeed.id });
  check(groupMember.player.garage.some((car) => car.id === garageSeed.id), "Authorized mechanic could not withdraw from shared garage");

  groupOwner = await request("/api/group/employee/hire", ownerToken, { employeeId: "employee_diagnostic_1" });
  check(groupOwner.player.group.employees.some((employee) => employee.id === "employee_diagnostic_1"), "Employee was not hired");
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

  groupMember = await request("/api/parts/buy", memberToken, { type: "common" });
  const repairPart = groupMember.player.partInventory.at(-1);
  const repairTarget = groupMember.player.garage.find((car) => car.defects.some((defect) => !defect.repaired));
  check(repairTarget, "No diagnosed car remained for the parts repair test");
  const repairDefectWithPart = repairTarget.defects.find((defect) => !defect.repaired);
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
