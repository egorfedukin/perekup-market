#!/usr/bin/env python3
"""Build a deployable local vehicle catalog from prepared WebP photos."""

from __future__ import annotations

import csv
import hashlib
import re
import shutil
import unicodedata
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "машины_ready"
OUTPUT_IMAGES = ROOT / "public" / "car-photos"
OUTPUT_TSV = ROOT / "vehicle-catalog.tsv"
YEARS_FILE = ROOT / "vehicle-production-years.json"

MAKES = [
    "Mercedes-Benz", "Rolls-Royce", "Aston Martin", "Alfa Romeo", "Land Rover", "Range Rover",
    "Great Wall", "Volkswagen", "Mitsubishi", "Lamborghini", "Koenigsegg", "Oldsmobile", "SsangYong",
    "Chevrolet", "Citroën", "Renault", "Peugeot", "Skoda", "Škoda", "Suzuki", "Hyundai", "Toyota",
    "Nissan", "Honda", "Mazda", "Subaru", "Chrysler", "Cadillac", "Infiniti", "Maserati", "Porsche",
    "Ferrari", "Bentley", "McLaren", "Bugatti", "Pagani", "Maybach", "Dacia", "Daewoo", "Fiat",
    "Opel", "SEAT", "Kia", "Lada", "Ford", "Volvo", "Jeep", "GMC", "Isuzu", "Chery", "Geely",
    "Haval", "BYD", "Acura", "Lexus", "Audi", "BMW", "Tesla", "Polestar", "Rivian", "Lucid",
    "Saab", "Rover", "Vauxhall", "Mercury", "Plymouth", "Holden", "Mini", "Smart", "Tata", "Proton",
    "Daihatsu", "Lotus", "Alpine", "Genesis", "Dodge", "Buick", "Pontiac", "MG", "UAZ", "GAZ",
    "Moskvich", "Changan", "Exeed", "Omoda", "Jaecoo", "Jetour", "Hongqi", "FAW", "BAIC", "JAC",
    "Foton", "Evolute", "Voyah", "Zeekr", "Tank", "Li Auto", "Aito", "Avatr", "Dongfeng", "Soueast",
    "Haima", "Ravon", "ZAZ", "Izh", "Tenet",
]
MAKE_ALIASES = {"mercedesbenz": "Mercedes-Benz", "rollsroyce": "Rolls-Royce", "landrover": "Land Rover", "alfaromeo": "Alfa Romeo", "greatwall": "Great Wall", "liauto": "Li Auto"}

# Approximate 2025-2026 Russian-market replacement values in RUB. Model rules below refine these anchors.
MAKE_BASE = {
    "Lada": 1_350_000, "UAZ": 1_800_000, "GAZ": 2_400_000, "Moskvich": 2_300_000,
    "Daewoo": 650_000, "Dacia": 1_700_000, "Renault": 2_200_000, "Peugeot": 2_300_000,
    "Citroën": 2_400_000, "Fiat": 2_100_000, "Skoda": 2_800_000, "Škoda": 2_800_000,
    "Volkswagen": 3_400_000, "Toyota": 4_300_000, "Honda": 3_600_000, "Nissan": 3_300_000,
    "Mazda": 3_500_000, "Mitsubishi": 3_400_000, "Subaru": 4_200_000, "Suzuki": 2_700_000,
    "Hyundai": 3_000_000, "Kia": 3_100_000, "Ford": 2_900_000, "Chevrolet": 3_300_000,
    "Opel": 2_200_000, "Chery": 3_400_000, "Geely": 3_600_000, "Haval": 3_700_000,
    "Changan": 3_600_000, "Omoda": 3_300_000, "Jaecoo": 4_100_000, "Exeed": 4_500_000,
    "Jetour": 3_700_000, "Tank": 6_500_000, "Hongqi": 7_500_000, "BYD": 4_800_000,
    "BMW": 8_000_000, "Audi": 7_500_000, "Mercedes-Benz": 8_800_000, "Lexus": 7_200_000,
    "Infiniti": 5_500_000, "Acura": 5_400_000, "Volvo": 5_700_000, "Genesis": 7_000_000,
    "Cadillac": 8_500_000, "Land Rover": 12_000_000, "Range Rover": 16_000_000, "Jaguar": 8_500_000,
    "Tesla": 6_800_000, "Zeekr": 7_000_000, "Li Auto": 7_500_000, "Voyah": 7_000_000,
    "Porsche": 22_000_000, "Maserati": 16_000_000, "Lotus": 16_000_000, "Alpine": 9_000_000,
    "Aston Martin": 45_000_000, "Bentley": 45_000_000, "Rolls-Royce": 75_000_000,
    "Ferrari": 75_000_000, "Lamborghini": 80_000_000, "McLaren": 85_000_000,
    "Bugatti": 450_000_000, "Pagani": 500_000_000, "Koenigsegg": 550_000_000, "Maybach": 75_000_000,
}

# Public auction/collector-market inspired anchors; values are rounded for game balance, not appraisal certificates.
EXACT_PRICES = {
    "mclaren f1": (1_800_000_000, True), "mclaren f1 lm": (2_000_000_000, True),
    "ferrari 250 gt": (1_200_000_000, True), "ferrari 250 gto": (2_000_000_000, True),
    "mercedes benz 300 slr": (2_000_000_000, True), "mercedes benz 300 sl": (180_000_000, True),
    "bugatti type 57": (900_000_000, True), "bugatti eb110": (320_000_000, True),
    "bugatti veyron": (260_000_000, True), "bugatti chiron": (500_000_000, True),
    "pagani zonda": (480_000_000, True), "pagani huayra": (430_000_000, True),
    "lamborghini countach": (190_000_000, True), "lamborghini miura": (230_000_000, True),
    "lamborghini diablo": (95_000_000, True), "lamborghini murcielago": (70_000_000, True),
    "ferrari f40": (280_000_000, True), "ferrari f50": (400_000_000, True),
    "ferrari enzo": (420_000_000, True), "ferrari testarossa": (65_000_000, True),
    "maserati mc12": (350_000_000, True), "jaguar e type": (90_000_000, True),
    "aston martin db5": (110_000_000, True), "bmw m1": (75_000_000, True),
    "porsche carrera gt": (170_000_000, True), "porsche 959": (150_000_000, True),
    "porsche 918 spyder": (180_000_000, True), "lexus lfa": (110_000_000, True),
    "ford gt40": (500_000_000, True), "shelby cobra": (120_000_000, True),
    "toyota 2000gt": (100_000_000, True), "mercedes benz slr mclaren": (75_000_000, True),
}

SPORT_HINT = re.compile(r"\b(amg|alpina|rs\d?|m\d|m3|m4|m5|m6|m8|gtr|gt r|gt3|gt2|sti|evo|type r|srt|hellcat|svr|quadrifoglio|nismo|grmn|supra|rx ?7|nsx|corvette|viper|911|cayman|boxster)\b", re.I)
SUV_HINT = re.compile(r"\b(suv|cross|crossover|x[1-7]|q[2-9]|gl[abceks]|gle|gls|g class|land cruiser|range rover|patrol|pajero|touareg|tiguan|cayenne|macan|wrangler|cherokee|tahoe|escalade|rav4|cr v|x trail|qashqai|sportage|sorento|duster|niva|4x4)\b", re.I)


def compact(value: str) -> str:
    value = unicodedata.normalize("NFKD", value.casefold())
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    return re.sub(r"[^a-zа-я0-9]+", "", value)


def words(value: str) -> str:
    value = unicodedata.normalize("NFKD", value.casefold())
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    return re.sub(r"[^a-zа-я0-9]+", " ", value).strip()


def load_old_names() -> dict[str, str]:
    if not OUTPUT_TSV.exists():
        return {}
    with OUTPUT_TSV.open(encoding="utf-8-sig", newline="") as handle:
        return {compact(row["АВТОМОБИЛЬ"]): row["АВТОМОБИЛЬ"] for row in csv.DictReader(handle, delimiter="\t")}


def make_and_name(stem: str, known: dict[str, str]) -> tuple[str, str] | None:
    stem = re.sub(r"__[0-9a-f]{8}$", "", stem, flags=re.I).strip()
    if stem.isdigit() or len(stem) < 3 or re.fullmatch(r"(?:aito|amber|auto|avto|car|img|photo)[a-z]*\d+", stem, re.I):
        return None
    key = compact(stem)
    if key in known:
        name = known[key]
    else:
        make = next((MAKE_ALIASES.get(compact(item), item) for item in sorted(MAKES, key=len, reverse=True) if key.startswith(compact(item))), None)
        if not make:
            return None
        remainder = key[len(compact(make)):]
        if not remainder:
            return None
        original_spaced = re.sub(r"[-_]+", " ", stem).strip()
        if " " in original_spaced and compact(original_spaced).startswith(compact(make)):
            visible_remainder = original_spaced
            for alias in sorted(MAKES, key=len, reverse=True):
                visible_remainder = re.sub(rf"^{re.escape(alias)}\s*", "", visible_remainder, flags=re.I)
            model = visible_remainder.strip() or remainder.upper()
        else:
            model = re.sub(r"(?<=\D)(\d)", r" \1", remainder).strip().upper() if len(remainder) <= 5 else remainder.capitalize()
        name = f"{make} {model}".strip()
    make = next((MAKE_ALIASES.get(compact(item), item) for item in sorted(MAKES, key=len, reverse=True) if compact(name).startswith(compact(item))), name.split()[0])
    return make, name.replace("Skoda", "Škoda")


def price_for(make: str, name: str) -> tuple[int, bool]:
    normalized = words(name).replace("ё", "е")
    for pattern, result in EXACT_PRICES.items():
        if pattern in normalized:
            return result
    base = MAKE_BASE.get(make, 3_500_000)
    if SUV_HINT.search(normalized): base *= 1.22
    if SPORT_HINT.search(normalized): base *= 1.55
    if re.search(r"\b(van|transit|sprinter|ducato|boxer|transporter|multivan|pickup|hilux|ranger|amarok)\b", normalized): base *= 1.15
    if re.search(r"\b(flagship|turbo s|performante|svj|competition|black series|speed|mulliner|autobiography)\b", normalized): base *= 1.35
    collectible = bool(re.search(r"\b(type|gt40|cobra|daytona|miura|countach|testarossa|eb110|zonda|f40|f50|enzo|mc12|e type|db5|959|2000gt)\b", normalized))
    return round(max(500_000, min(2_000_000_000, base)) / 10_000) * 10_000, collectible


def tier_for(price: int, name: str, collectible: bool) -> str:
    normalized = words(name)
    if collectible or price >= 45_000_000:
        return "premium"
    if SPORT_HINT.search(normalized) and price >= 5_000_000:
        return "performance"
    if price <= 1_600_000:
        return "cheap"
    return "middle"


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"Source folder not found: {SOURCE}")
    known = load_old_names()
    OUTPUT_IMAGES.mkdir(parents=True, exist_ok=True)
    candidates: dict[str, tuple[Path, str, str]] = {}
    rejected: list[str] = []
    for photo in sorted(SOURCE.glob("*.webp"), key=lambda p: p.name.casefold()):
        parsed = make_and_name(photo.stem, known)
        if not parsed:
            rejected.append(photo.name)
            continue
        make, name = parsed
        key = compact(name)
        # Prefer the clean filename over the duplicate __hash variant.
        if key not in candidates or "__" in candidates[key][0].stem:
            candidates[key] = (photo, make, name)

    rows = []
    for key, (source, make, name) in sorted(candidates.items(), key=lambda item: item[1][2].casefold()):
        price, collectible = price_for(make, name)
        tier = tier_for(price, name, collectible)
        target_name = f"{hashlib.sha1(key.encode()).hexdigest()[:14]}.webp"
        target = OUTPUT_IMAGES / target_name
        with Image.open(source) as image:
            image = ImageOps.fit(image.convert("RGB"), (720, 405), method=Image.Resampling.LANCZOS)
            image.save(target, "WEBP", quality=74, method=6, optimize=True)
        rows.append({
            "АВТОМОБИЛЬ": name, "ССЫЛКА_НА_ФОТО": f"/car-photos/{target_name}", "СТАТУС": "LOCAL",
            "ИСТОЧНИК": f"LOCAL · {source.name}", "ЦЕНА_2026": price, "КОЛЛЕКЦИОННАЯ": "1" if collectible else "0",
            "КОНТЕЙНЕР": tier,
        })

    with OUTPUT_TSV.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]), delimiter="\t")
        writer.writeheader(); writer.writerows(rows)
    report = ROOT / "ОТЧЕТ_КАТАЛОГ_МАШИН.txt"
    counts = {tier: sum(row["КОНТЕЙНЕР"] == tier for row in rows) for tier in ("cheap", "middle", "performance", "premium")}
    report.write_text(
        "ЛОКАЛЬНЫЙ КАТАЛОГ МАШИН\n\n" + f"Принято: {len(rows)}\nОтклонено из-за нераспознаваемого имени: {len(rejected)}\n" +
        "\n".join(f"Контейнер {key}: {value}" for key, value in counts.items()) +
        "\n\nНЕРАСПОЗНАННЫЕ ФАЙЛЫ\n" + "\n".join(rejected), encoding="utf-8-sig"
    )
    print(f"Catalog: {len(rows)} cars; rejected: {len(rejected)}; tiers: {counts}")


if __name__ == "__main__":
    main()
