#!/usr/bin/env python3
"""Массовая подготовка фотографий автомобилей для игры.

Пример:
  python prepare-car-photos.py "D:\Фото машин" --output "D:\Фото машин готовые"

Требуется Pillow:
  python -m pip install Pillow
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
import unicodedata
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageFilter, ImageOps, UnidentifiedImageError


SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".avif"}
GENERATION_PATTERN = re.compile(
    r"^(?:mk|gen)?\d{1,2}$|^[a-z]{1,3}\d{1,4}[a-z]?$|^\d{1,3}[a-z]{1,3}$|^(?:19|20)\d{2}$",
    re.IGNORECASE,
)
NOISE_WORDS = {
    "photo", "foto", "image", "img", "picture", "pic", "car", "auto", "vehicle",
    "фото", "фотография", "картинка", "машина", "авто", "автомобиль",
    "front", "rear", "side", "back", "left", "right", "вид", "спереди", "сзади",
    "copy", "копия", "final", "new", "новая", "оригинал", "original",
}


@dataclass
class PhotoRecord:
    source: Path
    relative_source: Path
    display_name: str
    duplicate_key: str
    output: Path | None = None
    source_size: tuple[int, int] | None = None
    output_size: tuple[int, int] | None = None
    source_format: str = ""
    bytes_before: int = 0
    bytes_after: int = 0
    status: str = "ожидает"
    error: str = ""


def natural_key(value: str) -> list[object]:
    return [int(part) if part.isdigit() else part.casefold() for part in re.split(r"(\d+)", value)]


def clean_display_name(stem: str) -> str:
    value = unicodedata.normalize("NFKC", stem)
    value = re.sub(r"[_.,;]+", " ", value)
    value = re.sub(r"\s*[-–—]+\s*", " ", value)
    value = re.sub(r"\b(?:copy|копия)\s*\d*\b", " ", value, flags=re.IGNORECASE)
    value = re.sub(r"\s*\(\s*\d+\s*\)\s*$", "", value)
    value = re.sub(r"\b(?:img|image|photo|foto|фото)[-_ ]*\d+\b", " ", value, flags=re.IGNORECASE)
    value = re.sub(r"\b\d{3,4}\s*[xх]\s*\d{3,4}\b", " ", value, flags=re.IGNORECASE)
    value = re.sub(r"\s+", " ", value).strip()
    return value or stem


def duplicate_key(name: str) -> str:
    """Создаёт ключ машины, сохраняя модель и поколение, но игнорируя оформление имени."""
    value = unicodedata.normalize("NFKD", name.casefold())
    value = "".join(char for char in value if not unicodedata.combining(char))
    tokens = re.findall(r"[a-zа-яё0-9]+", value, flags=re.IGNORECASE)
    meaningful: list[str] = []
    for token in tokens:
        if token in NOISE_WORDS:
            continue
        if token.isdigit() and len(token) <= 2:
            # Обычно это номер фотографии: "BMW M5 F90 2".
            continue
        meaningful.append(token)
    # Порядок слов не важен: "BMW M5 F90" и "BMW F90 M5" считаются одинаковыми.
    return " ".join(sorted(meaningful, key=natural_key))


def safe_filename(name: str) -> str:
    value = unicodedata.normalize("NFKC", name).strip()
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", value)
    value = re.sub(r"\s+", " ", value).strip(" .")
    return value[:150] or "car"


def unique_output_path(output_dir: Path, display_name: str, source: Path, used: set[str]) -> Path:
    base = safe_filename(display_name)
    candidate = f"{base}.webp"
    key = candidate.casefold()
    if key not in used:
        used.add(key)
        return output_dir / candidate
    digest = hashlib.sha1(str(source).encode("utf-8", "ignore")).hexdigest()[:8]
    candidate = f"{base}__{digest}.webp"
    counter = 2
    while candidate.casefold() in used:
        candidate = f"{base}__{digest}_{counter}.webp"
        counter += 1
    used.add(candidate.casefold())
    return output_dir / candidate


def flatten_transparency(image: Image.Image) -> Image.Image:
    if image.mode in {"RGBA", "LA"} or "transparency" in image.info:
        rgba = image.convert("RGBA")
        background = Image.new("RGBA", rgba.size, (238, 235, 229, 255))
        background.alpha_composite(rgba)
        return background.convert("RGB")
    return image.convert("RGB")


def make_canvas(image: Image.Image, width: int, height: int, mode: str) -> Image.Image:
    if mode == "crop":
        return ImageOps.fit(image, (width, height), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))

    # Машина остаётся видна целиком; свободное место заполняет размытая копия фотографии.
    background = ImageOps.fit(image, (width, height), method=Image.Resampling.LANCZOS)
    background = background.filter(ImageFilter.GaussianBlur(radius=max(12, width // 45)))
    background = Image.blend(background, Image.new("RGB", (width, height), (28, 29, 30)), 0.18)
    foreground = ImageOps.contain(image, (width, height), method=Image.Resampling.LANCZOS)
    x = (width - foreground.width) // 2
    y = (height - foreground.height) // 2
    background.paste(foreground, (x, y))
    return background


def process_photo(record: PhotoRecord, width: int, height: int, quality: int, mode: str, overwrite: bool) -> None:
    assert record.output is not None
    record.bytes_before = record.source.stat().st_size
    if record.output.exists() and not overwrite:
        record.status = "пропущено: уже существует"
        record.bytes_after = record.output.stat().st_size
        return
    try:
        with Image.open(record.source) as opened:
            record.source_format = opened.format or record.source.suffix.lstrip(".").upper()
            record.source_size = opened.size
            image = ImageOps.exif_transpose(opened)
            image = flatten_transparency(image)
            result = make_canvas(image, width, height, mode)
            record.output.parent.mkdir(parents=True, exist_ok=True)
            temporary = record.output.with_suffix(".tmp.webp")
            result.save(temporary, "WEBP", quality=quality, method=6, optimize=True, exif=b"")
            temporary.replace(record.output)
            record.output_size = result.size
            record.bytes_after = record.output.stat().st_size
            record.status = "готово"
    except (UnidentifiedImageError, OSError, ValueError) as error:
        record.status = "ошибка"
        record.error = str(error)


def format_size(size: tuple[int, int] | None) -> str:
    return f"{size[0]}x{size[1]}" if size else "—"


def relative_text(path: Path | None, base: Path) -> str:
    if path is None:
        return "—"
    try:
        return str(path.relative_to(base))
    except ValueError:
        return str(path)


def write_report(records: list[PhotoRecord], input_dir: Path, output_dir: Path, report_path: Path) -> None:
    groups: dict[str, list[PhotoRecord]] = defaultdict(list)
    for record in records:
        if record.duplicate_key:
            groups[record.duplicate_key].append(record)
    duplicates = {key: items for key, items in groups.items() if len(items) > 1}
    successful = sum(record.status == "готово" for record in records)
    skipped = sum(record.status.startswith("пропущено") for record in records)
    failed = [record for record in records if record.status == "ошибка"]
    before = sum(record.bytes_before for record in records)
    after = sum(record.bytes_after for record in records)

    lines = [
        "КАТАЛОГ ФОТОГРАФИЙ АВТОМОБИЛЕЙ",
        f"Создан: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"Исходная папка: {input_dir}",
        f"Готовые фотографии: {output_dir}",
        "",
        "ИТОГ",
        f"Найдено изображений: {len(records)}",
        f"Обработано: {successful}",
        f"Пропущено: {skipped}",
        f"Ошибок: {len(failed)}",
        f"Групп повторов: {len(duplicates)}",
        f"Файлов в группах повторов: {sum(len(items) for items in duplicates.values())}",
        f"Размер исходников: {before / 1024 / 1024:.1f} МБ",
        f"Размер результата: {after / 1024 / 1024:.1f} МБ",
        "",
        "ВСЕ МАШИНЫ",
        "№ | Название | Исходник | Готовый WebP | Было | Стало | Статус",
    ]
    for index, record in enumerate(records, 1):
        lines.append(
            f"{index} | {record.display_name} | {record.relative_source} | "
            f"{relative_text(record.output, output_dir)} | {format_size(record.source_size)} | "
            f"{format_size(record.output_size)} | {record.status}"
        )

    lines.extend(["", "ПОВТОРЫ", "Повтором считается одинаковый нормализованный набор: марка + модель + поколение."])
    if not duplicates:
        lines.append("Повторы не найдены.")
    else:
        for group_index, (key, items) in enumerate(sorted(duplicates.items()), 1):
            lines.extend(["", f"ПОВТОР #{group_index}: {items[0].display_name}", f"Ключ: {key}"])
            for item in items:
                lines.append(f"  - исходник: {item.relative_source} -> фото: {relative_text(item.output, output_dir)}")

    lines.extend(["", "ОШИБКИ"])
    if not failed:
        lines.append("Ошибок нет.")
    else:
        for record in failed:
            lines.append(f"- {record.relative_source}: {record.error}")

    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("\n".join(lines) + "\n", encoding="utf-8-sig")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Приводит фотографии машин к единому WebP и создаёт TXT-отчёт с повторами.")
    parser.add_argument("input", type=Path, help="Папка с исходными фотографиями")
    parser.add_argument("--output", type=Path, help="Папка для готовых WebP (по умолчанию: <input>_готовые)")
    parser.add_argument("--width", type=int, default=960, help="Ширина результата, по умолчанию 960")
    parser.add_argument("--height", type=int, default=540, help="Высота результата, по умолчанию 540")
    parser.add_argument("--quality", type=int, default=82, help="Качество WebP от 1 до 100, по умолчанию 82")
    parser.add_argument("--mode", choices=("blur", "crop"), default="blur", help="blur: машина целиком с размытым фоном; crop: заполнение с обрезкой")
    parser.add_argument("--report", type=Path, help="Путь TXT-отчёта (по умолчанию внутри выходной папки)")
    parser.add_argument("--overwrite", action="store_true", help="Перезаписывать уже существующие WebP")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    input_dir = args.input.expanduser().resolve()
    if not input_dir.is_dir():
        print(f"Ошибка: папка не найдена: {input_dir}", file=sys.stderr)
        return 2
    if args.width < 100 or args.height < 100 or not 1 <= args.quality <= 100:
        print("Ошибка: проверьте width, height и quality", file=sys.stderr)
        return 2

    output_dir = (args.output or input_dir.with_name(f"{input_dir.name}_готовые")).expanduser().resolve()
    if output_dir == input_dir or input_dir in output_dir.parents:
        print("Ошибка: выходная папка не должна находиться внутри папки исходников", file=sys.stderr)
        return 2
    output_dir.mkdir(parents=True, exist_ok=True)
    report_path = (args.report or output_dir / "КАТАЛОГ_МАШИН_И_ПОВТОРЫ.txt").expanduser().resolve()

    files = sorted(
        (path for path in input_dir.rglob("*") if path.is_file() and path.suffix.casefold() in SUPPORTED_EXTENSIONS),
        key=lambda path: natural_key(str(path.relative_to(input_dir))),
    )
    if not files:
        print("Поддерживаемые изображения не найдены.", file=sys.stderr)
        return 1

    used_names: set[str] = set()
    records: list[PhotoRecord] = []
    for source in files:
        display_name = clean_display_name(source.stem)
        record = PhotoRecord(
            source=source,
            relative_source=source.relative_to(input_dir),
            display_name=display_name,
            duplicate_key=duplicate_key(display_name),
        )
        record.output = unique_output_path(output_dir, display_name, source, used_names)
        records.append(record)

    print(f"Найдено фотографий: {len(records)}")
    for index, record in enumerate(records, 1):
        process_photo(record, args.width, args.height, args.quality, args.mode, args.overwrite)
        if index == 1 or index % 50 == 0 or index == len(records):
            print(f"[{index}/{len(records)}] {record.status}: {record.relative_source}")

    write_report(records, input_dir, output_dir, report_path)
    failed = sum(record.status == "ошибка" for record in records)
    print(f"Готово. Фотографии: {output_dir}")
    print(f"Отчёт: {report_path}")
    print(f"Ошибок: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
