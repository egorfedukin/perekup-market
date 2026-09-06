#!/usr/bin/env python3
"""Import brand/model/photo folders into the deployable vehicle catalog."""

from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.util
import json
import re
from pathlib import Path

from PIL import Image, ImageFilter, ImageOps

ROOT = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("vehicle_catalog_builder", ROOT / "build-local-vehicle-catalog.py")
_builder = importlib.util.module_from_spec(_spec)
assert _spec.loader
_spec.loader.exec_module(_builder)
compact, price_for, tier_for = _builder.compact, _builder.price_for, _builder.tier_for

CATALOG = ROOT / "vehicle-catalog.tsv"
YEARS = ROOT / "vehicle-production-years.json"
OUTPUT = ROOT / "public" / "car-photos"
EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".avif", ".bmp"}
BRAND_NAMES = {"Bmw": "BMW"}


def prepare(source: Path, target: Path) -> None:
    with Image.open(source) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
        background = ImageOps.fit(image, (720, 405), method=Image.Resampling.LANCZOS)
        background = background.filter(ImageFilter.GaussianBlur(14))
        background = Image.blend(background, Image.new("RGB", background.size, (24, 27, 31)), 0.16)
        foreground = ImageOps.contain(image, (720, 405), method=Image.Resampling.LANCZOS)
        background.paste(foreground, ((720 - foreground.width) // 2, (405 - foreground.height) // 2))
        temporary = target.with_suffix(".tmp.webp")
        background.save(temporary, "WEBP", quality=76, method=6, optimize=True, exif=b"")
        temporary.replace(target)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    args = parser.parse_args()
    source_root = args.source.resolve()
    if not source_root.is_dir():
        raise SystemExit(f"Folder not found: {source_root}")

    with CATALOG.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle, delimiter="\t"))
    years = json.loads(YEARS.read_text(encoding="utf-8")) if YEARS.exists() else {}
    known_years = {compact(key): value for key, value in years.items()}
    by_key = {compact(row["АВТОМОБИЛЬ"]): row for row in rows}
    imported = updated = 0
    OUTPUT.mkdir(parents=True, exist_ok=True)

    for brand_dir in sorted((item for item in source_root.iterdir() if item.is_dir()), key=lambda item: item.name.casefold()):
        make = BRAND_NAMES.get(brand_dir.name, brand_dir.name)
        for model_dir in sorted((item for item in brand_dir.iterdir() if item.is_dir()), key=lambda item: item.name.casefold()):
            photos = sorted(item for item in model_dir.rglob("*") if item.is_file() and item.suffix.casefold() in EXTENSIONS)
            if not photos:
                continue
            name = f"{make} {model_dir.name}".strip()
            key = compact(name)
            target_name = f"{hashlib.sha1(key.encode()).hexdigest()[:14]}.webp"
            target = OUTPUT / target_name
            prepare(photos[0], target)
            price, collectible = price_for(make, name)
            row = {
                "АВТОМОБИЛЬ": name,
                "ССЫЛКА_НА_ФОТО": f"/car-photos/{target_name}",
                "СТАТУС": "LOCAL",
                "ИСТОЧНИК": f"LOCAL · {make}/{model_dir.name}/{photos[0].name}",
                "ЦЕНА_2026": str(price),
                "КОЛЛЕКЦИОННАЯ": "1" if collectible else "0",
                "КОНТЕЙНЕР": tier_for(price, name, collectible),
            }
            if key not in known_years:
                model_lower = model_dir.name.casefold()
                start = 2000
                if re.search(r"\b(19|20)\d{2}\b", model_lower):
                    start = int(re.search(r"\b((?:19|20)\d{2})\b", model_lower).group(1))
                elif any(token in model_lower for token in ("concept", "prototype")):
                    start = 2010
                elif re.search(r"\b(i{1,3}|iv|v|vi|vii)\b", model_lower):
                    start = 2005
                years[name] = {"startYear": start, "endYear": 2026}
                known_years[key] = years[name]
            if key in by_key:
                by_key[key].update(row); updated += 1
            else:
                rows.append(row); by_key[key] = row; imported += 1

    rows.sort(key=lambda row: row["АВТОМОБИЛЬ"].casefold())
    with CATALOG.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]), delimiter="\t")
        writer.writeheader(); writer.writerows(rows)
    YEARS.write_text(json.dumps(years, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Imported: {imported}; updated: {updated}; catalog total: {len(rows)}")


if __name__ == "__main__":
    main()
