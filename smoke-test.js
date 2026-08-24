const base = process.env.TEST_URL || "http://localhost:4173";

async function request(path, token, body) {
  const response = await fetch(`${base}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path}: ${data.error}`);
  return data;
}

function check(value, message) {
  if (!value) throw new Error(message);
}

async function run() {
  const suffix = Date.now().toString().slice(-6);
  const shellResponse = await fetch(base);
  const shell = await shellResponse.text();
  const clientScript = await (await fetch(`${base}/app.js`)).text();
  check(shellResponse.ok && ["cars", "containers", "mine"].every((mode) => shell.includes(`data-auction-mode="${mode}"`)), "Auction workspace modes are missing from the client shell");
  check(shell.includes('id="auction-cars-panel"') && shell.includes('id="auction-containers-panel"'), "Auction workspace panels are missing from the client shell");
  check(["cars", "development"].every((mode) => shell.includes(`data-garage-mode="${mode}"`)), "Garage workspace modes are missing from the client shell");
  check(shell.includes('data-garage-mode="plates"') && ["public", "direct"].every((mode) => shell.includes(`data-chat-mode="${mode}"`)), "Plate or direct-message workspaces are missing from the client shell");
  check(shell.includes('id="player-modal"') && !shell.includes('id="direct-search"') && clientScript.includes('/api/player/profile') && clientScript.includes('includePlate'), "Profile-based messaging or plate-inclusive listing UI is missing");
  check(["overview", "progress", "history"].every((mode) => shell.includes(`data-profile-mode="${mode}"`)), "Profile workspace modes are missing from the client shell");
  check(clientScript.includes('max="2000000000"'), "Vehicle listing form does not match the server price ceiling");
  const seller = await request("/api/join", null, { name: `Seller${suffix}` });
  check(seller.leaderboardCurrent?.id === seller.player.id && seller.leaderboardCurrent.rank >= 1, "Current player is missing from the activity-based leaderboard");
  check(Object.keys(seller.marketStats).length > 0, "Market statistics are missing");
  check(Object.values(seller.marketStats).every((stats) => stats.dealAverage > 0 && stats.normalLow >= 1), "Market price ranges are incomplete");
  check(seller.catalogCount === 10000, `Expected 10,000 catalog variants, got ${seller.catalogCount}`);
  check(seller.market.every((car) => /^https:\/\//.test(car.photoUrl || "") && /^https:\/\//.test(car.photoSource || "")), "Direct catalog photos are missing");
  check(new Set(seller.market.filter((car) => !car.sellerId).map((car) => car.model)).size >= 85, "NPC market model variety is too low");
  check(seller.market.some((car) => !car.sellerId && car.price <= 650000), "New players have no affordable market entry");
  check(seller.market.some((car) => !car.sellerId && car.price >= 50000000), "Collector segment is missing from the market");
  const npcPriceBands = seller.market.filter((car) => !car.sellerId).reduce((bands, car) => {
    const stats = seller.marketStats[car.model];
    const band = car.price < stats.normalLow ? "below" : car.price > stats.normalHigh ? "above" : "fair";
    bands[band] += 1;
    return bands;
  }, { below: 0, fair: 0, above: 0 });
  check(npcPriceBands.below >= 15, `NPC market has too few opportunities: ${JSON.stringify(npcPriceBands)}`);
  check(npcPriceBands.above <= 20, `NPC market is overpriced again: ${JSON.stringify(npcPriceBands)}`);
  check(seller.marketRotation?.replaceCount === 10 && seller.marketRotation.intervalSeconds >= 10, "NPC market rotation metadata is missing");
  const affordable = seller.market.filter((car) => car.saleType !== "auction" && car.price < 330000).sort((a, b) => a.price - b.price)[0];
  check(affordable, "No affordable car was seeded");

  let state = await request("/api/buy", seller.token, { carId: affordable.id });
  check(state.player.garage.length === 1, "Purchased car did not reach garage");

  state = await request("/api/skill", seller.token, { skill: "diagnostics" });
  check(state.player.skills.diagnostics === 1 && state.player.skillPoints === 0, "Skill upgrade failed");
  state = await request("/api/equipment", seller.token, { equipment: "diagnosticKit" });
  check(state.player.equipment.diagnosticKit === 1, "Equipment purchase failed");

  state = await request("/api/check", seller.token, { carId: affordable.id, category: "engine" });
  check(state.player.xp >= 20, "Inspection did not award XP");
  check(state.player.garage[0].checkedCategories.includes("engine"), "Inspection category was not recorded");

  const car = state.player.garage[0];
  const listPrice = Math.min(600000, car.invested + 90000);
  await request("/api/list", seller.token, { carId: car.id, price: listPrice, description: "Есть результаты осмотра, торг уместен" });

  const buyer = await request("/api/join", null, { name: `Buyer${suffix}` });
  let directState = await request("/api/direct/send", seller.token, { recipientId: buyer.player.id, message: "Привет, обсудим автомобиль?" });
  check(directState.directMessages.some((message) => message.recipientId === buyer.player.id), "Direct message was not stored for the sender");
  directState = await request("/api/state", buyer.token);
  const directMessage = directState.directMessages.find((message) => message.senderId === seller.player.id);
  check(directMessage && directState.directUnread === 1, "Recipient did not receive an unread direct message");
  await request("/api/chat/report", buyer.token, { messageId: directMessage.id, reason: "Проверка модерации личных сообщений" });
  directState = await request("/api/direct/read", buyer.token, { playerId: seller.player.id });
  check(directState.directUnread === 0 && directState.directMessages.find((message) => message.id === directMessage.id)?.readAt, "Direct conversation was not marked as read");
  const offerAmount = Math.round((listPrice - 40000) / 1000) * 1000;
  const offered = await request("/api/offer", buyer.token, { carId: car.id, amount: offerAmount });
  const outgoing = offered.player.outgoingOffers.find((offer) => offer.carId === car.id);
  check(outgoing, `Player offer was not created: car ${car.id}, offers ${JSON.stringify(offered.player.outgoingOffers)}`);
  check(outgoing.amount === offerAmount, `Offer amount mismatch: expected ${offerAmount}, got ${outgoing.amount}`);

  const sellerState = await request("/api/state", seller.token);
  const incoming = sellerState.player.incomingOffers.find((offer) => offer.buyerId === buyer.player.id);
  check(incoming, "Seller did not receive the offer");
  await request("/api/offer/respond", seller.token, { offerId: incoming.id, action: "accept" });

  const finalBuyer = await request("/api/state", buyer.token);
  const finalSeller = await request("/api/state", seller.token);
  check(finalBuyer.player.garage.some((item) => item.id === car.id), "Negotiated purchase failed");
  check(finalSeller.player.deals === 1, "Seller deal counter was not updated");
  check(finalSeller.player.profit === offerAmount - car.invested, "Profit does not include inspection and equipment-independent car costs");
  check(finalSeller.player.xp >= 120, "Sale XP was not awarded");

  const servicePlayer = await request("/api/join", null, { name: `Service${suffix}` });
  const serviceSeed = servicePlayer.market.filter((item) => item.saleType !== "auction" && item.price < 330000).sort((a, b) => a.price - b.price)[0];
  let serviceState = await request("/api/buy", servicePlayer.token, { carId: serviceSeed.id });
  const beforeService = serviceState.player.cash;
  const serviceCar = serviceState.player.garage[0];
  serviceState = await request("/api/service-diagnostic", servicePlayer.token, { carId: serviceCar.id });
  const diagnosed = serviceState.player.garage[0];
  check(diagnosed.serviceDiagnosed && diagnosed.checkedCategories.length === serviceState.inspectionCategories.length && diagnosed.inspection.confidence === 100, "Service did not complete all inspections");
  check(!("hiddenDefectCount" in diagnosed), "Service response exposes hidden defect metadata");
  check(serviceState.player.cash === beforeService - serviceCar.serviceDiagnosticCost, "Service diagnostic cost mismatch");
  serviceState = await request("/api/plates/issue", servicePlayer.token, {});
  const issuedPlate = serviceState.player.plateInventory[0];
  check(issuedPlate?.number && serviceState.plateMarket.length >= 30, "Plate issue or marketplace seed failed");
  serviceState = await request("/api/car/registration", servicePlayer.token, { carId: serviceCar.id, action: "register", plateId: issuedPlate.id });
  check(serviceState.player.garage[0].registration.registered && serviceState.player.garage[0].registration.plate?.id === issuedPlate.id, "Plate was not attached to a registered car");
  serviceState = await request("/api/list", servicePlayer.token, { carId: serviceCar.id, price: 200000000, description: "Коллекционный автомобиль" });
  check(serviceState.market.some((item) => item.id === serviceCar.id && item.price === 200000000 && !item.registration.registered && !item.registration.plate) && serviceState.player.plateInventory.some((plate) => plate.id === issuedPlate.id), "High-value listing or automatic plate removal failed");
  serviceState = await request("/api/unlist", servicePlayer.token, { carId: serviceCar.id });
  serviceState = await request("/api/plates/list", servicePlayer.token, { plateId: issuedPlate.id, price: 5000 });
  const plateLot = serviceState.plateMarket.find((lot) => lot.sellerId === servicePlayer.player.id);
  check(plateLot, "Player plate listing failed");
  const plateBuyer = await request("/api/join", null, { name: `PlateBuyer${suffix}` });
  const plateBuyerState = await request("/api/plates/buy", plateBuyer.token, { lotId: plateLot.id });
  check(plateBuyerState.player.plateInventory.some((plate) => plate.id === issuedPlate.id), "Player-to-player plate purchase failed");
  serviceState = await request("/api/plates/issue", servicePlayer.token, {});
  const includedPlate = serviceState.player.plateInventory[0];
  serviceState = await request("/api/car/registration", servicePlayer.token, { carId: serviceCar.id, action: "register", plateId: includedPlate.id });
  serviceState = await request("/api/list", servicePlayer.token, { carId: serviceCar.id, price: 1, description: "Срочная продажа с номером", includePlate: true });
  const includedLot = serviceState.market.find((item) => item.id === serviceCar.id);
  check(includedLot?.price === 1 && includedLot.plateIncluded && includedLot.registration.plate?.id === includedPlate.id, "One-ruble listing with an included plate was rejected");
  const publicProfile = await request(`/api/player/profile?id=${servicePlayer.player.id}`, plateBuyer.token);
  check(publicProfile.listings.some((item) => item.id === serviceCar.id) && !Object.hasOwn(publicProfile, "cash"), "Public player profile is missing a listing or exposes private balance data");
  const vehicleBuyer = await request("/api/join", null, { name: `VehicleBuyer${suffix}` });
  const vehicleBuyerState = await request("/api/buy", vehicleBuyer.token, { carId: serviceCar.id });
  check(vehicleBuyerState.player.garage.some((car) => car.id === serviceCar.id && car.registration.registered && car.registration.plate?.id === includedPlate.id), "Plate did not transfer with the purchased vehicle");

  const npcSeller = await request("/api/join", null, { name: `NpcSeller${suffix}` });
  const npcCarSeed = npcSeller.market.filter((item) => item.saleType !== "auction" && item.price < 500000).sort((a, b) => b.price - a.price)[0];
  let npcState = await request("/api/buy", npcSeller.token, { carId: npcCarSeed.id });
  const npcCar = npcState.player.garage[0];
  await request("/api/list", npcSeller.token, { carId: npcCar.id, price: Math.min(5000000, npcCar.invested * 3), description: "Идеал, без проблем и вложений" });
  await new Promise((resolve) => setTimeout(resolve, 2200));
  npcState = await request("/api/state", npcSeller.token);
  check(npcState.market.some((item) => item.id === npcCar.id), "Bot bought a severely overpriced car");
  check(npcState.player.incomingOffers.length === 0, "Bot negotiated on a severely overpriced car");

  await request("/api/unlist", npcSeller.token, { carId: npcCar.id });
  const attractivePrice = Math.max(50000, Math.round(npcCar.invested * 0.72 / 1000) * 1000);
  await request("/api/list", npcSeller.token, { carId: npcCar.id, price: attractivePrice, description: "Честное описание, торг" });
  await new Promise((resolve) => setTimeout(resolve, 2400));
  npcState = await request("/api/state", npcSeller.token);
  const botActed = npcState.player.incomingOffers.some((offer) => offer.buyerType === "bot") || npcState.player.deals === 1;
  check(botActed, "Bots ignored an attractively priced car");

  console.log(`PASS: balanced rotating NPC market, 1-ruble price, market stats, diagnostics, negotiation and rational NPC pricing; bands ${JSON.stringify(npcPriceBands)}`);
}

run().catch((error) => { console.error(`FAIL: ${error.message}`); process.exitCode = 1; });
