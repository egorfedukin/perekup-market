"use strict";

const cosmetics = [
  { id: "workshop", slot: "background", name: "Первая мастерская", level: 1, image: "/profile-art/workshop.jpg" },
  { id: "road", slot: "background", name: "Открытая дорога", level: 3, image: "/profile-art/road.jpg" },
  { id: "classic", slot: "background", name: "Классика", level: 7, image: "/profile-art/classic.jpg" },
  { id: "showroom", slot: "background", name: "Личный салон", level: 12, image: "/profile-art/showroom.jpg" },
  { id: "night", slot: "background", name: "Ночная смена", pack: "night_style", image: "/profile-art/night.jpg" },
  { id: "studio", slot: "background", name: "Коллекция", pack: "collector_style", image: "/profile-art/studio.jpg" },
  { id: "plain", slot: "frame", name: "Стандарт", level: 1, color: "#d0d5d1" },
  { id: "green", slot: "frame", name: "Мастер", level: 5, color: "#62bd92" },
  { id: "copper", slot: "frame", name: "Дилер", level: 10, color: "#ddae6e" },
  { id: "redline", slot: "frame", name: "Красная линия", pack: "night_style", color: "#ef716c" },
  { id: "gold", slot: "frame", name: "Коллекционер", pack: "collector_style", color: "#e4ca82" }
];
const stylePackages = [
  { id: "night_style", name: "Ночная смена", rubles: 149, cash: 0, cosmetics: ["night", "redline"], tag: "Оформление", description: "Ночной фон и рамка «Красная линия». Навсегда для вашего профиля.", benefits: ["Фон «Ночная смена»", "Рамка «Красная линия»"], preview: "night" },
  { id: "collector_style", name: "Коллекция", rubles: 249, cash: 0, cosmetics: ["studio", "gold"], tag: "Оформление", description: "Фон коллекционера и золотая рамка. Навсегда для вашего профиля.", benefits: ["Фон «Коллекция»", "Рамка «Коллекционер»"], preview: "studio" }
];
function ownsCosmetic(player, item, level) {
  if (item.level) return level >= item.level;
  if (player.cosmeticsOwned?.includes(item.id)) return true;
  const ranks = { bronze: 1, silver: 2, gold: 3, platinum: 4, founder: 5 };
  return (ranks[player.supporterTier] || 0) >= (item.pack === "night_style" ? 1 : 3);
}
function profileAppearance(player, level) {
  const catalog = cosmetics.map(item => ({ ...item, unlocked: ownsCosmetic(player, item, level) }));
  const selected = {};
  for (const slot of ["background", "frame"]) selected[slot] = catalog.find(item => item.slot === slot && item.id === player.appearance?.[slot] && item.unlocked)?.id || (slot === "background" ? "workshop" : "plain");
  return { catalog, selected };
}
function paymentMatches(order, payment) {
  return payment.status === "succeeded" && payment.paid === true && payment.metadata?.orderId === order.orderId && payment.amount?.currency === "RUB" && Math.round(Number(payment.amount.value) * 100) === Math.round(order.rubles * 100);
}
function grantPurchase(player, order) {
  player.cash += Number(order.cash) || 0;
  player.purchasedCash = (player.purchasedCash || 0) + (Number(order.cash) || 0);
  player.cosmeticsOwned = [...new Set([...(player.cosmeticsOwned || []), ...(order.cosmetics || [])])];
}
module.exports = { cosmetics, stylePackages, profileAppearance, ownsCosmetic, paymentMatches, grantPurchase };
