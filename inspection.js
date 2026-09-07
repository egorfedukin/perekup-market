"use strict";
const crypto = require("node:crypto");

function createInspection(category) {
  const names = { engine: "Холодный запуск", chassis: "Тест-драйв", body: "Следы кузовного ремонта", electrics: "Диагностический прибор", tires: "Проверка шин", documents: "Сверка документов" };
  if (!Object.hasOwn(names, category)) throw new Error("Неизвестная система автомобиля");
  const rounds = Array.from({ length: 3 }, (_, index) => {
    if (category === "engine" || category === "chassis") {
      const target = crypto.randomInt(25, 76);
      return { target, tolerance: category === "engine" ? 13 : 11, label: (category === "engine" ? ["Запуск стартера", "Стабилизация оборотов", "Проверка отклика"] : ["Разгон", "Торможение", "Коррекция увода"])[index] };
    }
    const answer = crypto.randomInt(0, 4);
    if (category === "body") return { answer, label: ["Передние панели", "Двери", "Задние панели"][index], readings: Array.from({ length: 4 }, (_, i) => i === answer ? crypto.randomInt(260, 560) : crypto.randomInt(90, 145)), unit: "мкм", normal: "Заводское покрытие: 80–160 мкм" };
    if (category === "electrics") return { answer, label: ["Напряжение аккумулятора", "Зарядка генератора", "Ток покоя"][index], readings: Array.from({ length: 4 }, (_, i) => i === answer ? [10.1, 16.8, 0.45][index] : [12.6, 14.2, 0.03][index]), unit: index === 2 ? "А" : "В", normal: ["Норма: 12,4–12,8 В", "Норма: 13,8–14,6 В", "Норма: до 0,05 А"][index] };
    return { answer, label: category === "tires" ? "Остаток протектора" : "Сверка номера кузова", readings: Array.from({ length: 4 }, (_, i) => category === "tires" ? (i === answer ? 1 : 6) : (i === answer ? "XTA21099123456780" : "XTA21099123456789")), unit: category === "tires" ? "мм" : "", normal: category === "tires" ? "Минимум: 1,6 мм" : "В документах: XTA21099123456789" };
  });
  return { category, name: names[category], rounds };
}

function gradeInspection(challenge, answers, skill = 0) {
  if (!Array.isArray(answers) || answers.length !== challenge.rounds.length || answers.some(x => typeof x !== "number" || !Number.isFinite(x))) throw new Error("Нужны ответы на все этапы осмотра");
  const points = challenge.rounds.map((round, i) => round.target === undefined ? Number(answers[i] === round.answer) : Math.max(0, 1 - Math.max(0, Math.abs(answers[i] - round.target) - skill) / round.tolerance));
  const accuracy = Math.round(points.reduce((a, b) => a + b, 0) / points.length * 100);
  return { accuracy, bonus: accuracy >= 80 ? 2 : accuracy >= 45 ? 1 : 0 };
}

module.exports = { createInspection, gradeInspection };
