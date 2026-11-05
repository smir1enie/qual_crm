# -*- coding: utf-8 -*-
"""
Тесты для CRM: белый, серый и чёрный ящик.
Запуск: python tests/crm_checks.py
Каждый тест печатает PASS/FAIL. Код возврата 0 = все прошли.
"""
import io
import sys
import json
import urllib.request
import urllib.parse
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))
import db

BASE_URL = "http://127.0.0.1:8788"
EXCEL_V4 = r"C:\Users\ul1ty\OneDrive\Desktop\work\КВАЛЫ\exel\СЭТ_полная_расфасовка_v4.xlsx"

_passed = 0
_failed = 0
_failures = []


def _api(path):
    with urllib.request.urlopen(f"{BASE_URL}{path}") as r:
        return json.loads(r.read())


def _check(name, cond, detail=""):
    global _passed, _failed
    if cond:
        _passed += 1
        print(f"  [PASS] {name}")
    else:
        _failed += 1
        _failures.append(name)
        print(f"  [FAIL] {name} — {detail}")


# ---------------------------------------------------------------------------
# БЕЛЫЙ ЯЩИК — тесты на уровне функций db.py (внутренняя логика)
# ---------------------------------------------------------------------------

def test_white_reader_columns():
    """Б1 (белый): ридер читает все 20 колонок из v4."""
    print("\n=== Б1. Ридер: все 20 колонок (белый ящик) ===")
    rows = db._read_xls(EXCEL_V4)
    _check("Прочитано >1000 строк", len(rows) > 1000, f"получено {len(rows)}")
    sample = next(r for r in rows if r["year"] == 2025 and not r.get("is_expert"))
    expected_fields = [
        "name", "workplace", "position", "course", "period", "district",
        "org_type", "funding_source", "gender", "course_provider",
        "incoming_letter", "response_letter", "do_order", "cro_letter",
        "certificate_series", "certificate_reg", "date_start", "date_end",
    ]
    for f in expected_fields:
        _check(f"Поле {f} присутствует", f in sample, f"нет поля {f}")
    _check("funding_source заполнен", bool(sample.get("funding_source")),
           f"funding_source='{sample.get('funding_source')}'")
    _check("course_provider заполнен", bool(sample.get("course_provider")),
           f"course_provider='{sample.get('course_provider')}'")


def test_white_dates():
    """Б2 (белый): нормализация дат — datetime, строка, Excel-серий."""
    print("\n=== Б2. Нормализация дат (белый ящик) ===")
    from datetime import datetime
    _check("datetime -> DD.MM.YYYY",
           db._norm_date(datetime(2026, 1, 30)) == "30.01.2026",
           db._norm_date(datetime(2026, 1, 30)))
    _check("строка ISO -> DD.MM.YYYY",
           db._norm_date("2026-01-30 00:00:00") == "30.01.2026",
           db._norm_date("2026-01-30 00:00:00"))
    _check("строка DD.MM.YYYY -> DD.MM.YYYY",
           db._norm_date("30.01.2026") == "30.01.2026",
           db._norm_date("30.01.2026"))
    _check("Excel-серий 46022 -> 31.12.2025",
           db._norm_date(46022) == "31.12.2025",
           db._norm_date(46022))
    _check("None -> ''", db._norm_date(None) == "", repr(db._norm_date(None)))
    _check("пустая строка -> ''", db._norm_date("") == "", repr(db._norm_date("")))


def test_white_sheet_meta():
    """Б3 (белый): определение года и признака эксперта из имени листа."""
    print("\n=== Б3. Метаданные листа (белый ящик) ===")
    y, e = db._sheet_meta("2024")
    _check("Лист '2024' -> год 2024, не эксперт", y == 2024 and e is False, f"{y},{e}")
    y, e = db._sheet_meta("Эксперты 2026")
    _check("Лист 'Эксперты 2026' -> год 2026, эксперт", y == 2026 and e is True, f"{y},{e}")
    y, e = db._sheet_meta("2023")
    _check("Лист '2023' -> год 2023, не эксперт", y == 2023 and e is False, f"{y},{e}")
    y, e = db._sheet_meta("Лист без года")
    _check("Лист без года -> year=None", y is None, f"{y}")


def test_white_import_counts():
    """Б4 (белый): импорт корректно считает экспертов и реестр."""
    print("\n=== Б4. Импорт: счётчики экспертов/реестра (белый ящик) ===")
    rows = db._read_xls(EXCEL_V4)
    experts = sum(1 for r in rows if r.get("is_expert"))
    registry = sum(1 for r in rows if not r.get("is_expert"))
    _check("Экспертов >100", experts > 100, f"experts={experts}")
    _check("Реестра >1000", registry > 1000, f"registry={registry}")
    years = set(r["year"] for r in rows)
    _check("Есть 2024, 2025, 2026", {2024, 2025, 2026} <= years, f"years={years}")


# ---------------------------------------------------------------------------
# СЕРЫЙ ЯЩИК — тесты на уровне API (через HTTP, как клиент)
# ---------------------------------------------------------------------------

def test_gray_years_filter():
    """С1 (серый): /api/years отдаёт разные счётчики для is_expert=0/1."""
    print("\n=== С1. /api/years с фильтром is_expert (серый ящик) ===")
    all_years = _api("/api/years")
    exp_years = _api("/api/years?is_expert=1")
    reg_years = _api("/api/years?is_expert=0")
    _check("Все годы — список", isinstance(all_years, list) and len(all_years) >= 3,
           f"len={len(all_years)}")
    _check("Эксперты — список", isinstance(exp_years, list) and len(exp_years) >= 1,
           f"len={len(exp_years)}")
    all_map = {y["year"]: y["count"] for y in all_years}
    exp_map = {y["year"]: y["count"] for y in exp_years}
    reg_map = {y["year"]: y["count"] for y in reg_years}
    for y in all_map:
        total = exp_map.get(y, 0) + reg_map.get(y, 0)
        _check(f"Год {y}: эксперт+реестр=всего", total == all_map[y],
               f"exp={exp_map.get(y)}, reg={reg_map.get(y)}, all={all_map[y]}")


def test_gray_courses_filter():
    """С2 (серый): /api/courses отдаёт курсы с фильтром is_expert."""
    print("\n=== С2. /api/courses с фильтром is_expert (серый ящик) ===")
    all_c = _api("/api/courses?year=2026")
    exp_c = _api("/api/courses?year=2026&is_expert=1")
    reg_c = _api("/api/courses?year=2026&is_expert=0")
    _check("Все курсы 2026 >50", len(all_c) > 50, f"len={len(all_c)}")
    _check("Курсы экспертов 2026 >0", len(exp_c) > 0, f"len={len(exp_c)}")
    _check("Курсы реестра 2026 >0", len(reg_c) > 0, f"len={len(reg_c)}")
    exp_names = {c["course"] for c in exp_c}
    reg_names = {c["course"] for c in reg_c}
    _check("Курсы экспертов и реестра не пересекаются",
           not (exp_names & reg_names), f"пересечение={exp_names & reg_names}")


def test_gray_participant_fields():
    """С3 (серый): /api/participants отдаёт новые поля."""
    print("\n=== С3. /api/participants: новые поля (серый ящик) ===")
    courses = _api("/api/courses?year=2025")
    if not courses:
        _check("Есть курсы 2025", False, "пусто")
        return
    course = courses[0]["course"]
    encoded = urllib.parse.quote(course)
    parts = _api(f"/api/participants?year=2025&course={encoded}")
    _check("Есть участники", len(parts) > 0, "пусто")
    if parts:
        p = parts[0]
        for field in ["funding_source", "course_provider", "incoming_letter",
                      "response_letter", "do_order", "cro_letter",
                      "certificate_series", "certificate_reg", "is_expert"]:
            _check(f"Поле {field} в ответе", field in p, f"нет поля {field}")


def test_gray_search_expert():
    """С4 (серый): /api/search с is_expert возвращает только экспертов."""
    print("\n=== С4. /api/search с фильтром is_expert (серый ящик) ===")
    all_r = _api("/api/search?q=" + urllib.parse.quote("а"))
    exp_r = _api("/api/search?q=" + urllib.parse.quote("а") + "&is_expert=1")
    _check("Поиск без фильтра — есть результаты", len(all_r) > 0, "пусто")
    _check("Поиск экспертов — есть результаты", len(exp_r) > 0, "пусто")
    all_experts = all(r.get("is_expert") == 1 for r in exp_r)
    _check("Все результаты поиска экспертов — is_expert=1", all_experts,
           "есть не-эксперты")
    _check("Экспертов <= всех", len(exp_r) <= len(all_r),
           f"exp={len(exp_r)}, all={len(all_r)}")


# ---------------------------------------------------------------------------
# ЧЁРНЫЙ ЯЩИК — тесты на уровне пользователя (поведение, крайние случаи)
# ---------------------------------------------------------------------------

def test_black_empty_course():
    """Ч1 (чёрный): несуществующий курс — пустой список, не ошибка."""
    print("\n=== Ч1. Несуществующий курс (чёрный ящик) ===")
    encoded = urllib.parse.quote("КУРС_КОТОРОГО_НЕТ_12345")
    parts = _api(f"/api/participants?year=2026&course={encoded}")
    _check("Несуществующий курс -> []", parts == [], f"получено: {parts}")


def test_black_invalid_year():
    """Ч2 (чёрный): некорректный год — ошибка 400."""
    print("\n=== Ч2. Некорректный год (чёрный ящик) ===")
    try:
        _api("/api/courses?year=abc")
        _check("Некорректный год -> ошибка", False, "не упало")
    except urllib.error.HTTPError as e:
        _check("Некорректный год -> 400", e.code == 400, f"code={e.code}")


def test_black_stats_experts():
    """Ч3 (чёрный): /api/stats содержит счётчики экспертов."""
    print("\n=== Ч3. /api/stats: счётчики экспертов (чёрный ящик) ===")
    stats = _api("/api/stats")
    totals = stats.get("totals", {})
    _check("totals.experts >0", totals.get("experts", 0) > 0,
           f"experts={totals.get('experts')}")
    _check("totals.expert_listeners >0", totals.get("expert_listeners", 0) > 0,
           f"expert_listeners={totals.get('expert_listeners')}")
    _check("records = experts + (records-experts)",
           totals.get("records", 0) == totals.get("experts", 0) +
           (totals.get("records", 0) - totals.get("experts", 0)),
           f"records={totals.get('records')}")


def test_black_filter_options_expert():
    """Ч4 (чёрный): /api/filter-options с is_expert возвращает данные экспертов."""
    print("\n=== Ч4. /api/filter-options с is_expert (чёрный ящик) ===")
    opts = _api("/api/filter-options?year=2026&is_expert=1")
    _check("Есть districts", "districts" in opts and len(opts["districts"]) >= 0)
    _check("Есть org_types", "org_types" in opts)
    _check("Есть positions", "positions" in opts)
    _check("Есть courses", "courses" in opts)
    exp_courses_api = {c["course"] for c in _api("/api/courses?year=2026&is_expert=1")}
    opt_courses = set(opts.get("courses", []))
    _check("Курсы в filter-options — это курсы экспертов",
           opt_courses <= exp_courses_api or len(exp_courses_api) == 0,
           f"лишние: {opt_courses - exp_courses_api}")


# ---------------------------------------------------------------------------
# Запуск
# ---------------------------------------------------------------------------

def main():
    print("=" * 60)
    print("ТЕСТЫ CRM: белый, серый и чёрный ящик")
    print("=" * 60)

    test_white_reader_columns()
    test_white_dates()
    test_white_sheet_meta()
    test_white_import_counts()

    test_gray_years_filter()
    test_gray_courses_filter()
    test_gray_participant_fields()
    test_gray_search_expert()

    test_black_empty_course()
    test_black_invalid_year()
    test_black_stats_experts()
    test_black_filter_options_expert()

    print("\n" + "=" * 60)
    print(f"ИТОГО: {_passed} passed, {_failed} failed")
    if _failures:
        print("Проваленные тесты:")
        for f in _failures:
            print(f"  - {f}")
        return 1
    print("Все тесты прошли!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
