import hashlib
import os
import re
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
DB_PATH = DATA / "crm.db"
UPLOADS = DATA / "uploads"


def connect():
    DATA.mkdir(parents=True, exist_ok=True)
    UPLOADS.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.create_function("py_lower", 1, lambda v: str(v or "").casefold())
    return conn


# Колонки, добавленные в registry по сравнению с первой версией схемы.
# Используются для миграции существующей БД (ALTER TABLE ADD COLUMN).
_NEW_REGISTRY_COLUMNS = {
    "funding_source": "TEXT",
    "gender": "TEXT",
    "course_provider": "TEXT",
    "incoming_letter": "TEXT",
    "response_letter": "TEXT",
    "do_order": "TEXT",
    "cro_letter": "TEXT",
    "certificate_series": "TEXT",
    "certificate_reg": "TEXT",
    "is_expert": "INTEGER NOT NULL DEFAULT 0",
    "source_sheet": "TEXT",
    "source_row": "INTEGER",
}


def init_db():
    conn = connect()
    # Сначала мигрируем существующие таблицы (добавляем недостающие колонки),
    # потом выполняем schema.sql — там CREATE TABLE IF NOT EXISTS (пропустит
    # существующую) и CREATE INDEX (теперь колонки уже есть).
    existing = {r[1] for r in conn.execute("PRAGMA table_info(registry)").fetchall()}
    for col, decl in _NEW_REGISTRY_COLUMNS.items():
        if col not in existing:
            conn.execute(f"ALTER TABLE registry ADD COLUMN {col} {decl}")
    imports_cols = {r[1] for r in conn.execute("PRAGMA table_info(imports)").fetchall()}
    if "source_path" not in imports_cols:
        conn.execute("ALTER TABLE imports ADD COLUMN source_path TEXT")
    conn.commit()
    conn.executescript((ROOT / "schema.sql").read_text(encoding="utf-8"))
    conn.commit()
    return conn


def _norm(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


# Соответствие полей БД -> паттерны заголовков Excel (регистронезависимо).
_HEADER_PATTERNS = {
    "number": [r"^№", r"^n"],
    "year": [r"^год"],
    "period": [r"срок"],
    "course": [r"^курс"],
    "funding_source": [r"источник финансирования"],
    "date_start": [r"дата начала"],
    "date_end": [r"дата окончания"],
    "district": [r"район"],
    "org_type": [r"тип оу"],
    "workplace": [r"место работы"],
    "name": [r"фио"],
    "position": [r"должность"],
    "gender": [r"^пол"],
    "course_provider": [r"кто проводит"],
    "incoming_letter": [r"вх иро", r"вх др"],
    "response_letter": [r"ответ иро", r"ответ др"],
    "do_order": [r"приказ до"],
    "cro_letter": [r"письмо цро"],
    "certificate_series": [r"серия.*№.*удостовер", r"^серия"],
    "certificate_reg": [r"рег.*№.*удостовер", r"^рег"],
}

# Поля, значения которых — обычный текст (нормализуются через _norm).
_TEXT_FIELDS = [
    "name", "workplace", "position", "course", "period", "district",
    "org_type", "funding_source", "gender", "course_provider",
    "incoming_letter", "response_letter", "do_order", "cro_letter",
    "certificate_series", "certificate_reg",
]
# Поля-даты (нормализуются через _norm_date).
_DATE_FIELDS = ["date_start", "date_end"]


def _excel_date(serial):
    """Convert Excel serial date number to DD.MM.YYYY string."""
    try:
        serial = float(serial)
    except (TypeError, ValueError):
        return ""
    if serial <= 0:
        return ""
    # Excel epoch: 1900-01-01 = serial 1, but with 1900 leap year bug
    base = datetime(1899, 12, 30)
    try:
        dt = base + timedelta(days=serial)
        return dt.strftime("%d.%m.%Y")
    except (OverflowError, ValueError):
        return ""


def _norm_date(val):
    """Нормализует значение даты из Excel в строку DD.MM.YYYY.

    Поддерживает: объекты datetime/date, числовые Excel-сериалы, строки
    в форматах ISO и DD.MM.YYYY."""
    if val is None:
        return ""
    if isinstance(val, datetime):
        return val.strftime("%d.%m.%Y")
    try:
        from datetime import date as _date
        if isinstance(val, _date):
            return val.strftime("%d.%m.%Y")
    except Exception:
        pass
    s = str(val).strip()
    if not s:
        return ""
    # Числовой Excel-серий
    try:
        f = float(s)
        if f > 0 and f < 200000:
            return _excel_date(f)
    except (TypeError, ValueError):
        pass
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d", "%d.%m.%Y", "%d.%m.%y"):
        try:
            return datetime.strptime(s, fmt).strftime("%d.%m.%Y")
        except ValueError:
            continue
    return s


def _build_col_map(headers):
    """Сопоставляет заголовки листа с полями БД по паттернам."""
    col_map = {}
    for i, h in enumerate(headers):
        hl = h.lower()
        for field, patterns in _HEADER_PATTERNS.items():
            if field in col_map:
                continue
            if any(re.search(p, hl) for p in patterns):
                col_map[field] = i
                break
    return col_map


def _parse_year(val):
    """Извлекает 4-значный год из значения."""
    if val is None or val == "":
        return None
    try:
        return int(float(val))
    except (TypeError, ValueError):
        m = re.search(r"(20\d{2})", str(val))
        return int(m.group(1)) if m else None


def _sheet_meta(sheet_name):
    """Определяет год и признак эксперта из названия листа."""
    sn = (sheet_name or "").lower()
    is_expert = "эксперт" in sn
    m = re.search(r"(20\d{2})", sn)
    sheet_year = int(m.group(1)) if m else None
    return sheet_year, is_expert


def _row_to_dict(cells, col_map, sheet_year, is_expert, sheet_name=None, row_num=None):
    """Превращает строку ячеек в словарь записи. Возвращает None для пустых/служебных строк.
    sheet_name и row_num сохраняются для последующей записи обратно в Excel."""
    if not any(_norm(c) if c is not None else "" for c in cells):
        return None

    def get(field):
        idx = col_map.get(field)
        if idx is None or idx >= len(cells):
            return ""
        val = cells[idx]
        return val if val is not None else ""

    row = {}
    for f in _TEXT_FIELDS:
        row[f] = _norm(str(get(f)))
    for f in _DATE_FIELDS:
        row[f] = _norm_date(get(f))

    # Год: из ячейки, иначе из названия листа
    year = _parse_year(get("year"))
    if not year or not (1990 <= year <= 2100):
        year = sheet_year
    if not year:
        return None  # без года запись бесполезна

    num_val = get("number")
    try:
        number = int(float(num_val)) if num_val != "" else None
    except (TypeError, ValueError):
        number = None

    # Пропускаем «служебную» строку с номерами колонок (1, 2, 3 …):
    # в ней ФИО и курс содержат только цифры (номера колонок), а даты —
    # маленькие Excel-сериалы (5, 6, 7…). Реальные ФИО всегда содержат буквы.
    if not row["name"] and not row["course"]:
        return None
    if row["name"].isdigit() and row["course"].isdigit():
        return None

    row["number"] = number
    row["year"] = year
    row["is_expert"] = 1 if is_expert else 0
    row["source_sheet"] = sheet_name
    row["source_row"] = row_num
    return row


def _read_xls(file_path):
    """Читает .xls или .xlsx файл (все листы) и возвращает список записей.

    Каждый лист обрабатывается отдельно: год и признак эксперта определяются
    по названию листа (например «2024», «Эксперты 2026») и могут быть
    переопределены значениями в строке."""
    file_path = Path(file_path)
    ext = file_path.suffix.lower()
    if ext == ".xlsx":
        return _read_xlsx(file_path)
    return _read_xls_xlrd(file_path)


def _read_xlsx(file_path):
    """Читает .xlsx (все листы) через openpyxl."""
    from openpyxl import load_workbook

    wb = load_workbook(str(file_path), read_only=True, data_only=True)
    rows = []
    for sh in wb.worksheets:
        sheet_year, is_expert = _sheet_meta(sh.title)
        rows_raw = list(sh.iter_rows(values_only=True))
        if not rows_raw:
            continue
        headers = [_norm(str(c)) if c is not None else "" for c in rows_raw[0]]
        col_map = _build_col_map(headers)
        for row_idx, cells in enumerate(rows_raw[1:], start=2):  # Excel-нумерация с 1, данные со 2
            row = _row_to_dict(cells, col_map, sheet_year, is_expert, sh.title, row_idx)
            if row:
                rows.append(row)
    wb.close()
    return rows


def _read_xls_xlrd(file_path):
    """Читает .xls (все листы) через xlrd."""
    import xlrd

    wb = xlrd.open_workbook(str(file_path), encoding_override="cp1251")
    rows = []
    for sh in wb.sheets():
        sheet_year, is_expert = _sheet_meta(sh.name)
        if sh.nrows < 1:
            continue
        headers = [_norm(sh.cell_value(0, c)) for c in range(sh.ncols)]
        col_map = _build_col_map(headers)
        for r in range(1, sh.nrows):
            cells = [sh.cell_value(r, c) for c in range(sh.ncols)]
            row = _row_to_dict(cells, col_map, sheet_year, is_expert, sh.name, r + 1)
            if row:
                rows.append(row)
    return rows


def import_xls(conn, file_path, file_name=None, source_path=None):
    """Импорт .xls/.xlsx в БД с защитой от дубликатов и конфликтов.

    source_path — путь к исходному файлу (например, в папке exel), куда
    будут перезаписываться изменения при редактировании. Если None —
    записи будут перезаписываться только в копию в uploads/.

    Проверки:
      1. Файл существует и не пустой.
      2. Расширение .xls/.xlsx.
      3. Дубликат по хэшу файла (точная копия уже загружена).
      4. Файл содержит данные и обязательные колонки (ФИО, год).
      5. Дубликаты записей (имя+год+курс) — пропускаются, считаются.

    Возвращает dict с детальным отчётом."""
    file_path = Path(file_path)
    file_name = file_name or file_path.name

    # --- 1. Проверка файла ---
    if not file_path.exists():
        raise ValueError(f"Файл не найден: {file_path}")
    raw = file_path.read_bytes()
    if not raw:
        raise ValueError("Файл пустой")

    ext = file_path.suffix.lower()
    if ext not in (".xls", ".xlsx"):
        raise ValueError(f"Неподдерживаемый формат: {ext}. Допускаются только .xls и .xlsx")

    # --- 2. Дубликат по хэшу (точная копия) ---
    file_hash = hashlib.sha256(raw).hexdigest()
    existing = conn.execute(
        "SELECT id, original_name, uploaded_at, source_path FROM imports WHERE file_hash = ?",
        (file_hash,),
    ).fetchone()
    if existing:
        # Если передан source_path, обновим его у существующего импорта
        # (например, при реимпорте из папки exel — чтобы редактирование
        # писало в оригинальный файл, а не только в копию)
        if source_path and not existing["source_path"]:
            conn.execute(
                "UPDATE imports SET source_path = ? WHERE id = ?",
                (source_path, existing["id"]),
            )
            conn.commit()
        return {
            "duplicate": True,
            "message": f"Файл уже загружен: {existing['original_name']} ({existing['uploaded_at']})",
            "import_id": existing["id"],
        }

    # --- 3. Чтение и валидация содержимого ---
    rows = _read_xls(file_path)
    if not rows:
        raise ValueError("В файле нет данных или не удалось распознать колонки")

    # Проверка обязательных полей: хотя бы ФИО и год должны быть в большинстве строк
    with_name = sum(1 for r in rows if r.get("name"))
    with_year = sum(1 for r in rows if r.get("year"))
    total = len(rows)
    if with_name < total * 0.5:
        raise ValueError(
            f"В большинстве строк отсутствует ФИО ({with_name}/{total}). "
            f"Проверьте, что в файле есть колонка «ФИО слушателя»."
        )
    if with_year < total * 0.5:
        raise ValueError(
            f"В большинстве строк отсутствует год ({with_year}/{total}). "
            f"Проверьте, что в файле есть колонка «Год» или год в названии листа."
        )

    # --- 4. Определение года для записи в imports ---
    year = rows[0].get("year")
    if not year:
        m = re.search(r"(\d{4})", file_name)
        year = int(m.group(1)) if m else None

    # --- 5. Фильтрация дубликатов записей (имя + год + курс + is_expert) ---
    # Сначала собираем существующие ключи из БД, чтобы не дублировать.
    # is_expert включается в ключ — один и тот же человек может быть и в реестре,
    # и в экспертах (разные записи, не дубликаты).
    existing_keys = set()
    for r in conn.execute("SELECT name, year, course, is_expert FROM registry").fetchall():
        existing_keys.add((r["name"], r["year"], r["course"], r["is_expert"]))

    seen_in_this_import = set()
    unique_rows = []
    skipped_dupes = 0
    for row in rows:
        key = (row["name"], row["year"], row["course"], row.get("is_expert", 0))
        if key in existing_keys or key in seen_in_this_import:
            skipped_dupes += 1
            continue
        seen_in_this_import.add(key)
        unique_rows.append(row)

    # --- 6. Сохранение файла и импорт ---
    stored_path = UPLOADS / f"{datetime.now().strftime('%Y%m%d%H%M%S')}_{file_name}"
    stored_path.write_bytes(raw)

    cur = conn.execute(
        "INSERT INTO imports (original_name, stored_path, source_path, file_hash, year) VALUES (?, ?, ?, ?, ?)",
        (file_name, str(stored_path), source_path, file_hash, year),
    )
    import_id = cur.lastrowid

    experts = 0
    for row in unique_rows:
        if row.get("is_expert"):
            experts += 1
        conn.execute(
            """
            INSERT INTO registry (
                number, name, workplace, position, course, year,
                period, date_start, date_end, district, org_type,
                funding_source, gender, course_provider, incoming_letter,
                response_letter, do_order, cro_letter, certificate_series,
                certificate_reg, is_expert, import_id, source_sheet, source_row
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["number"], row["name"], row["workplace"], row["position"],
                row["course"], row["year"], row["period"], row["date_start"],
                row["date_end"], row["district"], row["org_type"],
                row.get("funding_source", ""), row.get("gender", ""),
                row.get("course_provider", ""), row.get("incoming_letter", ""),
                row.get("response_letter", ""), row.get("do_order", ""),
                row.get("cro_letter", ""), row.get("certificate_series", ""),
                row.get("certificate_reg", ""), row.get("is_expert", 0),
                import_id, row.get("source_sheet"), row.get("source_row"),
            ),
        )

    conn.commit()
    return {
        "ok": True,
        "import_id": import_id,
        "rows": len(unique_rows),
        "total_read": total,
        "skipped_duplicates": skipped_dupes,
        "experts": experts,
        "year": year,
        "file_name": file_name,
        "data": unique_rows,
    }


def list_years(conn):
    rows = conn.execute(
        "SELECT DISTINCT year FROM registry WHERE year IS NOT NULL ORDER BY year DESC"
    ).fetchall()
    return [r["year"] for r in rows]


def list_courses(conn, year, filters=None):
    """List courses for a year, optionally filtered by participant attributes.
    Only courses that have at least one matching participant are returned.
    The count reflects the number of matching participants, not total.
    filters может содержать is_expert (0/1/None) для разделения реестр/эксперты."""
    expert_clause = ""
    if filters and filters.get("is_expert") is not None:
        expert_clause = " AND is_expert = ?"
        expert_param = [filters["is_expert"]]
    else:
        expert_param = []

    if not filters or not any(filters.get(k) for k in
            ("district", "org_type", "position", "date_from", "date_to", "course")):
        # Основной запрос: WHERE year = ? [AND is_expert = ?]
        # Подзапрос COUNT: [AND is_expert = ?] (тем же значением)
        if expert_clause:
            rows = conn.execute(
                f"""
                SELECT DISTINCT course, period, date_start, date_end,
                       (SELECT COUNT(*) FROM registry r2
                        WHERE r2.course = registry.course AND r2.year = registry.year
                        {expert_clause}) AS count
                FROM registry
                WHERE year = ? {expert_clause}
                ORDER BY course
                """,
                (expert_param[0], year, expert_param[0]),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT DISTINCT course, period, date_start, date_end,
                       (SELECT COUNT(*) FROM registry r2
                        WHERE r2.course = registry.course AND r2.year = registry.year) AS count
                FROM registry
                WHERE year = ?
                ORDER BY course
                """,
                (year,),
            ).fetchall()
        return [dict(r) for r in rows]

    # Build WHERE for matching participants
    where = "WHERE year = ?"
    params = [year]
    where += expert_clause
    params.extend(expert_param)

    if filters.get("district"):
        where += " AND district = ?"
        params.append(filters["district"])
    if filters.get("org_type"):
        where += " AND org_type = ?"
        params.append(filters["org_type"])
    if filters.get("position"):
        where += " AND position = ?"
        params.append(filters["position"])
    if filters.get("date_from"):
        where += " AND " + _ISO_DATE_EXPR.format(col="date_start") + " >= ?"
        params.append(_date_to_iso(filters["date_from"]).replace("-", ""))
    if filters.get("date_to"):
        where += " AND " + _ISO_DATE_EXPR.format(col="date_end") + " <= ?"
        params.append(_date_to_iso(filters["date_to"]).replace("-", ""))

    # Get matching participants grouped by course
    rows = conn.execute(
        f"""
        SELECT course, period, date_start, date_end, COUNT(*) as count
        FROM registry
        {where}
        GROUP BY course
        ORDER BY course
        """,
        params,
    ).fetchall()

    result = [dict(r) for r in rows]
    # Course filter — substring match (case-insensitive, Cyrillic-safe via Python)
    if filters.get("course"):
        cf = filters["course"].lower()
        result = [r for r in result if cf in (r.get("course") or "").lower()]
    return result


def list_participants(conn, year, course, query="", is_expert=None):
    expert_clause = ""
    params = [year, course]
    if is_expert is not None:
        expert_clause = " AND is_expert = ?"
        params.append(is_expert)
    if query:
        q_lower = query.lower()
        rows = conn.execute(
            f"SELECT * FROM registry WHERE year = ? AND course = ?{expert_clause} ORDER BY number",
            params,
        ).fetchall()
        result = []
        for r in rows:
            item = dict(r)
            searchable = ' '.join([
                item.get('name', ''), item.get('workplace', ''),
                item.get('position', ''), item.get('district', ''),
            ]).lower()
            if q_lower in searchable:
                result.append(item)
        return result
    else:
        rows = conn.execute(
            f"SELECT * FROM registry WHERE year = ? AND course = ?{expert_clause} ORDER BY number",
            params,
        ).fetchall()
    return [dict(r) for r in rows]


def list_imports(conn):
    rows = conn.execute(
        "SELECT id, original_name, year, uploaded_at FROM imports ORDER BY uploaded_at DESC"
    ).fetchall()
    return [dict(r) for r in rows]


def wipe_registry(conn, delete_files=False):
    """Wipe registry data. If delete_files=True, also delete uploaded .xls files.
    Сбрасывает автоинкремент (sqlite_sequence) и уплотняет БД (VACUUM)."""
    deleted_files = []
    if delete_files:
        for f in UPLOADS.glob("*"):
            if f.is_file():
                try:
                    f.unlink()
                    deleted_files.append(f.name)
                except Exception:
                    pass
    conn.execute("DELETE FROM registry")
    conn.execute("DELETE FROM imports")
    # Сбрасываем автоинкремент, чтобы ID начинались с 1
    try:
        conn.execute("DELETE FROM sqlite_sequence WHERE name IN ('registry', 'imports')")
    except Exception:
        pass  # sqlite_sequence может не существовать, если таблицы были созданы без AUTOINCREMENT
    conn.commit()
    # Уплотняем файл БД — освобождаем место на диске
    try:
        conn.execute("VACUUM")
    except Exception:
        pass
    return {"ok": True, "deleted_files": deleted_files}


def count_by_year(conn, year, is_expert=None):
    if is_expert is not None:
        row = conn.execute(
            "SELECT COUNT(*) AS c FROM registry WHERE year = ? AND is_expert = ?",
            (year, is_expert),
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT COUNT(*) AS c FROM registry WHERE year = ?", (year,)
        ).fetchone()
    return row["c"] if row else 0


def get_participant(conn, participant_id):
    row = conn.execute(
        "SELECT * FROM registry WHERE id = ?", (participant_id,)
    ).fetchone()
    if not row:
        return {"error": "Запись не найдена"}, 404
    person = dict(row)
    # Имя исходного Excel-файла (для отображения в карточке/редактировании)
    if person.get("import_id"):
        imp = conn.execute(
            "SELECT original_name, stored_path FROM imports WHERE id = ?",
            (person["import_id"],),
        ).fetchone()
        if imp:
            person["import_name"] = imp["original_name"]
            person["import_path"] = imp["stored_path"]
    # Find all records for the same person (by name) — full history
    history = conn.execute(
        """
        SELECT id, year, course, period, date_start, date_end, position, workplace, district, org_type
        FROM registry
        WHERE name = ? AND id != ?
        ORDER BY year DESC, date_start
        """,
        (person["name"], participant_id),
    ).fetchall()
    person["history"] = [dict(h) for h in history]
    return person


def list_filter_options(conn, year=None, is_expert=None):
    """Return unique districts, org_types, positions, courses for filtering.
    is_expert (0/1/None) ограничивает выборку реестром или экспертами."""
    clauses = []
    params = []
    if year:
        clauses.append("year = ?")
        params.append(year)
    if is_expert is not None:
        clauses.append("is_expert = ?")
        params.append(is_expert)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""

    def _distinct(col):
        extra = f"{col} != ''"
        if where:
            return [r[0] for r in conn.execute(
                f"SELECT DISTINCT {col} FROM registry {where} AND {extra} ORDER BY {col}", params
            ).fetchall()]
        return [r[0] for r in conn.execute(
            f"SELECT DISTINCT {col} FROM registry WHERE {extra} ORDER BY {col}"
        ).fetchall()]

    return {
        "districts": _distinct("district"),
        "org_types": _distinct("org_type"),
        "positions": _distinct("position"),
        "courses": _distinct("course"),
        "workplaces": _distinct("workplace"),
        "funding_sources": _distinct("funding_source"),
        "course_providers": _distinct("course_provider"),
        "periods": _distinct("period"),
    }


def add_participant(conn, data):
    """Add a new record to the registry."""
    cur = conn.execute(
        """
        INSERT INTO registry (
            number, name, workplace, position, course, year,
            period, date_start, date_end, district, org_type,
            funding_source, gender, course_provider, incoming_letter,
            response_letter, do_order, cro_letter, certificate_series,
            certificate_reg, is_expert
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            data.get("number"),
            data.get("name", ""),
            data.get("workplace", ""),
            data.get("position", ""),
            data.get("course", ""),
            data.get("year"),
            data.get("period", ""),
            data.get("date_start", ""),
            data.get("date_end", ""),
            data.get("district", ""),
            data.get("org_type", ""),
            data.get("funding_source", ""),
            data.get("gender", ""),
            data.get("course_provider", ""),
            data.get("incoming_letter", ""),
            data.get("response_letter", ""),
            data.get("do_order", ""),
            data.get("cro_letter", ""),
            data.get("certificate_series", ""),
            data.get("certificate_reg", ""),
            int(data.get("is_expert", 0) or 0),
        ),
    )
    conn.commit()
    return {"ok": True, "id": cur.lastrowid}


def global_search(conn, query, limit=50, is_expert=None, year=None):
    """Search across all registry records by name, workplace, position, course, district, org_type.
    Дополнительно фильтрует по is_expert и/или year."""
    q_lower = query.lower()
    where_parts = []
    params = []
    if is_expert is not None:
        where_parts.append("is_expert = ?")
        params.append(is_expert)
    if year is not None:
        where_parts.append("year = ?")
        params.append(year)
    where = ("WHERE " + " AND ".join(where_parts)) if where_parts else ""
    rows = conn.execute(
        f"""
        SELECT id, name, year, course, position, workplace, district, org_type,
               period, date_start, date_end, is_expert
        FROM registry
        {where}
        ORDER BY year DESC, name
        """,
        params,
    ).fetchall()
    results = []
    for r in rows:
        item = dict(r)
        searchable = ' '.join([
            item.get('name', ''), item.get('workplace', ''), item.get('position', ''),
            item.get('course', ''), item.get('district', ''), item.get('org_type', ''),
        ]).lower()
        if q_lower in searchable:
            results.append(item)
            if len(results) >= limit:
                break
    return results


# ===== Редактирование записи и запись обратно в Excel-файл =====

# Соответствие полей БД -> номера колонок в Excel (по заголовкам v4).
# Используется для записи значений в правильные колонки исходного файла.
_EXCEL_COL_FIELDS = [
    "number", "year", "period", "course", "funding_source",
    "date_start", "date_end", "district", "org_type", "workplace",
    "name", "position", "gender", "course_provider", "incoming_letter",
    "response_letter", "do_order", "cro_letter", "certificate_series", "certificate_reg",
]

# Заголовки, по которым определяем колонки в Excel (должны совпадать с _HEADER_ALIASES)
_EXCEL_HEADER_NAMES = {
    "number": "№ п/п",
    "year": "Год",
    "period": "Сроки обучения",
    "course": "Курс",
    "funding_source": "Источник финансирования",
    "date_start": "Дата начала курса",
    "date_end": "Дата окончания курса",
    "district": "Район",
    "org_type": "Тип ОУ",
    "workplace": "Место работы слушателя",
    "name": "ФИО слушателя",
    "position": "Должность слушателя",
    "gender": "Пол",
    "course_provider": "Кто проводит курсы",
    "incoming_letter": "ВХ ИРО или ДР",
    "response_letter": "ОТВЕТ ИРО или ДР",
    "do_order": "ПРИКАЗ ДО",
    "cro_letter": "ПИСЬМО ЦРО О НАПРАВЛЕНИИ ПРИКАЗА ДО",
    "certificate_series": "Серия, № удостоверения",
    "certificate_reg": "Рег. № удостоверения",
}


def _build_excel_col_map_from_headers(headers):
    """Строит карту field -> column_index (0-based) по заголовкам листа Excel.
    Использует те же паттерны, что и _build_col_map."""
    col_map = {}
    for idx, h in enumerate(headers):
        hl = _norm(str(h)).lower() if h else ""
        if not hl:
            continue
        for field, patterns in _HEADER_PATTERNS.items():
            if field in col_map:
                continue
            if any(re.search(p, hl) for p in patterns):
                col_map[field] = idx
                break
    return col_map


def _write_row_to_xlsx(file_path, sheet_name, row_num, data):
    """Записывает значения полей из data в строку row_num листа sheet_name файла .xlsx.
    row_num — 1-based (как в Excel). Заголовки в строке 1."""
    from openpyxl import load_workbook

    wb = load_workbook(str(file_path))
    if sheet_name and sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
    else:
        ws = wb.worksheets[0]

    # Читаем заголовки из первой строки
    headers = []
    for c in range(1, ws.max_column + 1):
        v = ws.cell(row=1, column=c).value
        headers.append(v)
    col_map = _build_excel_col_map_from_headers(headers)

    # Записываем каждое поле в соответствующую колонку
    for field, value in data.items():
        if field not in col_map:
            continue
        col_idx = col_map[field] + 1  # openpyxl — 1-based
        ws.cell(row=row_num, column=col_idx, value=value if value is not None else "")

    wb.save(str(file_path))
    wb.close()


def _append_row_to_xlsx(file_path, sheet_name, data):
    """Добавляет новую строку в лист sheet_name файла .xlsx.
    Возвращает номер добавленной строки (1-based).
    Копирует стиль ячеек из последней строки с данными, чтобы новая строка
    выглядела так же, как остальные (шрифт, границы, выравнивание, заливка)."""
    from openpyxl import load_workbook
    from copy import copy

    wb = load_workbook(str(file_path))
    if sheet_name and sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
    else:
        ws = wb.worksheets[0]

    headers = []
    for c in range(1, ws.max_column + 1):
        v = ws.cell(row=1, column=c).value
        headers.append(v)
    col_map = _build_excel_col_map_from_headers(headers)

    # Находим последнюю строку с данными (для копирования стиля)
    last_data_row = ws.max_row
    while last_data_row > 1 and all(
        ws.cell(row=last_data_row, column=c).value in (None, "")
        for c in range(1, ws.max_column + 1)
    ):
        last_data_row -= 1

    new_row = last_data_row + 1

    # Авто-номер
    if "number" in col_map:
        col_idx = col_map["number"] + 1
        max_num = 0
        for r in range(2, last_data_row + 1):
            v = ws.cell(row=r, column=col_idx).value
            try:
                max_num = max(max_num, int(float(v)))
            except (TypeError, ValueError):
                pass
        data["number"] = max_num + 1

    # Копируем стиль из последней строки с данными в новую строку
    style_source_row = last_data_row if last_data_row > 1 else 1
    for c in range(1, ws.max_column + 1):
        src_cell = ws.cell(row=style_source_row, column=c)
        dst_cell = ws.cell(row=new_row, column=c)
        dst_cell.font = copy(src_cell.font)
        dst_cell.border = copy(src_cell.border)
        dst_cell.fill = copy(src_cell.fill)
        dst_cell.alignment = copy(src_cell.alignment)
        dst_cell.number_format = src_cell.number_format
        dst_cell.protection = copy(src_cell.protection)

    # Записываем значения
    for field, value in data.items():
        if field not in col_map:
            continue
        col_idx = col_map[field] + 1
        ws.cell(row=new_row, column=col_idx, value=value if value is not None else "")

    # Копируем высоту строки из источника стиля
    if style_source_row > 1 and ws.row_dimensions[style_source_row].height:
        ws.row_dimensions[new_row].height = ws.row_dimensions[style_source_row].height

    wb.save(str(file_path))
    wb.close()
    return new_row


def update_participant(conn, participant_id, data):
    """Обновляет запись в БД и в исходном Excel-файле (если возможно)."""
    row = conn.execute("SELECT * FROM registry WHERE id = ?", (participant_id,)).fetchone()
    if not row:
        return {"error": "Запись не найдена"}, 404

    # Поля, которые можно обновлять
    updatable = [
        "number", "name", "workplace", "position", "course", "year",
        "period", "date_start", "date_end", "district", "org_type",
        "funding_source", "gender", "course_provider", "incoming_letter",
        "response_letter", "do_order", "cro_letter", "certificate_series",
        "certificate_reg", "is_expert",
    ]
    sets = []
    params = []
    for f in updatable:
        if f in data:
            val = data[f]
            if f == "is_expert":
                val = int(val or 0)
            if f == "year":
                try:
                    val = int(val) if val else None
                except (TypeError, ValueError):
                    val = None
            if f == "number":
                try:
                    val = int(val) if val else None
                except (TypeError, ValueError):
                    val = None
            sets.append(f"{f} = ?")
            params.append(val)

    if not sets:
        return {"ok": True, "id": participant_id, "changed": False}

    params.append(participant_id)
    conn.execute(f"UPDATE registry SET {', '.join(sets)} WHERE id = ?", params)
    conn.commit()

    # Пытаемся записать обратно в Excel
    excel_written = False
    excel_error = None
    imp = conn.execute("SELECT stored_path, source_path FROM imports WHERE id = ?", (row["import_id"],)).fetchone()
    if imp:
        # Цели для записи: оригинальный файл (source_path) и копия (stored_path)
        targets = []
        if imp["source_path"]:
            targets.append(Path(imp["source_path"]))
        if imp["stored_path"] and Path(imp["stored_path"]) not in targets:
            targets.append(Path(imp["stored_path"]))
        sheet_name = row["source_sheet"]
        row_num = row["source_row"]
        # Готовим данные для записи
        excel_data = {}
        for f in updatable:
            if f in data:
                excel_data[f] = data[f]
        errors = []
        wrote_any = False
        for target in targets:
            if not target.exists():
                continue
            if target.suffix.lower() != ".xlsx":
                errors.append(f"{target.name}: .xls не поддерживается")
                continue
            try:
                if row_num:
                    _write_row_to_xlsx(target, sheet_name, row_num, excel_data)
                else:
                    new_row = _append_row_to_xlsx(target, sheet_name, excel_data)
                    conn.execute("UPDATE registry SET source_row = ? WHERE id = ?",
                                  (new_row, participant_id))
                    conn.commit()
                wrote_any = True
            except Exception as e:
                errors.append(f"{target.name}: {e}")
        excel_written = wrote_any
        if errors:
            excel_error = "; ".join(errors)

    return {
        "ok": True,
        "id": participant_id,
        "changed": True,
        "excel_written": excel_written,
        "excel_error": excel_error,
    }


def add_participant_to_excel(conn, data, import_id=None):
    """Добавляет запись в БД и в Excel-файл указанного импорта.
    Пишет в оригинальный файл (source_path) и в копию (stored_path).
    Если import_id не указан, берёт последний импорт с .xlsx файлом."""
    if import_id is None:
        # Выбираем импорт с наибольшим числом записей (обычно это основной файл,
        # который пользователь импортирует — например v4, а не v2/v3)
        imp = conn.execute(
            "SELECT i.id, i.stored_path, i.source_path, i.original_name, "
            "(SELECT COUNT(*) FROM registry r WHERE r.import_id = i.id) AS cnt "
            "FROM imports i "
            "WHERE i.stored_path LIKE '%.xlsx' "
            "ORDER BY cnt DESC, i.uploaded_at DESC LIMIT 1"
        ).fetchone()
        if not imp:
            raise ValueError("Нет загруженных .xlsx файлов для записи. Сначала загрузите Excel-файл.")
        import_id = imp["id"]
        stored_path = Path(imp["stored_path"])
        source_path = Path(imp["source_path"]) if imp["source_path"] else None
    else:
        imp = conn.execute("SELECT stored_path, source_path FROM imports WHERE id = ?", (import_id,)).fetchone()
        if not imp:
            raise ValueError(f"Импорт {import_id} не найден")
        stored_path = Path(imp["stored_path"])
        source_path = Path(imp["source_path"]) if imp["source_path"] else None

    if not stored_path.exists():
        raise ValueError(f"Файл не найден: {stored_path}")
    if stored_path.suffix.lower() != ".xlsx":
        raise ValueError("Запись в .xls файлы не поддерживается (только .xlsx)")

    # Цели для записи: оригинал + копия
    targets = [stored_path]
    if source_path and source_path.exists() and source_path != stored_path:
        targets.append(source_path)

    # Определяем лист для записи
    sheet_name = data.get("source_sheet")
    if not sheet_name:
        year = data.get("year")
        if year:
            is_expert = int(data.get("is_expert", 0) or 0)
            candidate = f"Эксперты {year}" if is_expert else str(year)
            from openpyxl import load_workbook
            wb_check = load_workbook(str(stored_path), read_only=True)
            if candidate in wb_check.sheetnames:
                sheet_name = candidate
            else:
                sheet_name = wb_check.sheetnames[0]
            wb_check.close()

    # Записываем в Excel — сначала в копию (чтобы получить new_row), потом в оригинал
    excel_data = {}
    for f in _EXCEL_COL_FIELDS:
        if f in data:
            excel_data[f] = data[f]
    new_row = _append_row_to_xlsx(stored_path, sheet_name, excel_data)
    # Теперь в оригинал — та же строка должна совпадать
    excel_errors = []
    for target in targets[1:]:
        try:
            _append_row_to_xlsx(target, sheet_name, excel_data)
        except PermissionError:
            excel_errors.append(f"{target.name}: файл заблокирован (открыт в Excel)")
        except Exception as e:
            excel_errors.append(f"{target.name}: {e}")

    # Добавляем в БД
    data["source_sheet"] = sheet_name
    data["source_row"] = new_row
    result = add_participant(conn, data)
    conn.execute("UPDATE registry SET import_id = ?, source_sheet = ?, source_row = ? WHERE id = ?",
                 (import_id, sheet_name, new_row, result["id"]))
    conn.commit()

    return {
        "ok": True,
        "id": result["id"],
        "excel_written": True,
        "sheet": sheet_name,
        "row": new_row,
        "import_id": import_id,
        "excel_errors": excel_errors,
    }


def _delete_row_from_xlsx(file_path, sheet_name, row_num):
    """Удаляет строку row_num из листа sheet_name файла .xlsx.
    Возвращает True при успехе, (False, error) при ошибке."""
    from openpyxl import load_workbook
    try:
        wb = load_workbook(str(file_path))
        ws = wb[sheet_name] if sheet_name and sheet_name in wb.sheetnames else wb.worksheets[0]
        ws.delete_rows(row_num, 1)
        wb.save(str(file_path))
        wb.close()
        return True, None
    except PermissionError:
        return False, "файл заблокирован (открыт в Excel)"
    except Exception as e:
        return False, str(e)


def delete_participant(conn, participant_id):
    """Удаляет запись из БД и из Excel-файла(ов).
    Удаляет строку из оригинала (source_path) и из копии (stored_path).
    Возвращает информацию о результате."""
    row = conn.execute(
        "SELECT r.import_id, r.source_sheet, r.source_row, r.name, "
        "i.stored_path, i.source_path, i.original_name "
        "FROM registry r LEFT JOIN imports i ON r.import_id = i.id "
        "WHERE r.id = ?",
        (participant_id,),
    ).fetchone()
    if not row:
        raise ValueError(f"Запись {participant_id} не найдена")

    name = row["name"]
    sheet_name = row["source_sheet"]
    source_row = row["source_row"]
    stored_path = row["stored_path"]
    source_path = row["source_path"]
    import_name = row["original_name"]

    excel_deleted = False
    excel_errors = []

    # Удаляем из Excel-файлов, если есть привязка
    if source_row and stored_path and stored_path.endswith(".xlsx"):
        targets = []
        sp = Path(stored_path)
        if sp.exists():
            targets.append(("копия", sp))
        if source_path:
            sp2 = Path(source_path)
            if sp2.exists() and sp2 != sp:
                targets.append(("оригинал", sp2))

        for label, path in targets:
            ok, err = _delete_row_from_xlsx(path, sheet_name, source_row)
            if ok:
                excel_deleted = True
            else:
                excel_errors.append(f"{label} ({path.name}): {err}")

        # После удаления строки из Excel остальные строки сдвигаются вверх.
        # Обновляем source_row у записей того же листа/импорта, которые были ниже.
        conn.execute(
            "UPDATE registry SET source_row = source_row - 1 "
            "WHERE import_id = ? AND source_sheet = ? AND source_row > ?",
            (row["import_id"], sheet_name, source_row),
        )

    # Удаляем из БД
    conn.execute("DELETE FROM registry WHERE id = ?", (participant_id,))
    conn.commit()

    return {
        "ok": True,
        "id": participant_id,
        "name": name,
        "excel_deleted": excel_deleted,
        "excel_errors": excel_errors,
        "import_name": import_name,
        "sheet": sheet_name,
        "row": source_row,
    }


def list_imports_with_files(conn):
    """Возвращает список импортов с путями к файлам и количеством записей."""
    rows = conn.execute(
        """
        SELECT i.id, i.original_name, i.stored_path, i.source_path, i.year, i.uploaded_at,
               (SELECT COUNT(*) FROM registry r WHERE r.import_id = i.id) AS record_count
        FROM imports i
        ORDER BY i.uploaded_at DESC
        """
    ).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        d["is_xlsx"] = d["stored_path"] and d["stored_path"].endswith(".xlsx")
        d["file_exists"] = bool(d["stored_path"] and Path(d["stored_path"]).exists())
        d["source_exists"] = bool(d["source_path"] and Path(d["source_path"]).exists())
        result.append(d)
    return result
    """Search across all registry records by name, workplace, position, course, district, org_type.
    Дополнительно фильтрует по is_expert и/или year."""
    q_lower = query.lower()
    where_parts = []
    params = []
    if is_expert is not None:
        where_parts.append("is_expert = ?")
        params.append(is_expert)
    if year is not None:
        where_parts.append("year = ?")
        params.append(year)
    where = ("WHERE " + " AND ".join(where_parts)) if where_parts else ""
    rows = conn.execute(
        f"""
        SELECT id, name, year, course, position, workplace, district, org_type,
               period, date_start, date_end, is_expert
        FROM registry
        {where}
        ORDER BY year DESC, name
        """,
        params,
    ).fetchall()
    results = []
    for r in rows:
        item = dict(r)
        searchable = ' '.join([
            item.get('name', ''), item.get('workplace', ''), item.get('position', ''),
            item.get('course', ''), item.get('district', ''), item.get('org_type', ''),
        ]).lower()
        if q_lower in searchable:
            results.append(item)
            if len(results) >= limit:
                break
    return results


def _date_to_iso(val):
    """Преобразует дату DD.MM.YYYY или YYYY-MM-DD в ISO YYYY-MM-DD для корректного
    сравнения и сортировки. Пустые/некорректные — в '' ."""
    val = (val or "").strip()
    if not val:
        return ""
    m = re.match(r"^(\d{2})\.(\d{2})\.(\d{4})", val)
    if m:
        return f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", val)
    if m:
        return val[:10]
    return ""


# Выражение SQLite, переводящее date_start/date_end (DD.MM.YYYY) в YYYYMMDD для
# корректного сравнения/сортировки. Пустые значения дают '99999999' (в конце списка).
_ISO_DATE_EXPR = (
    "CASE WHEN {col} LIKE '__.__.____' "
    "THEN substr({col},7,4)||substr({col},4,2)||substr({col},1,2) "
    "ELSE '99999999' END"
)


def filter_participants(conn, year, course, filters=None, sort_by="number", sort_dir="asc"):
    """List participants with advanced filters and sorting."""
    sql = "SELECT * FROM registry WHERE year = ? AND course = ?"
    params = [year, course]

    q_filter = None
    if filters:
        if filters.get("is_expert") is not None:
            sql += " AND is_expert = ?"
            params.append(filters["is_expert"])
        if filters.get("district"):
            sql += " AND district = ?"
            params.append(filters["district"])
        if filters.get("org_type"):
            sql += " AND org_type = ?"
            params.append(filters["org_type"])
        if filters.get("position"):
            sql += " AND position = ?"
            params.append(filters["position"])
        if filters.get("date_from"):
            sql += " AND " + _ISO_DATE_EXPR.format(col="date_start") + " >= ?"
            params.append(_date_to_iso(filters["date_from"]).replace("-", ""))
        if filters.get("date_to"):
            sql += " AND " + _ISO_DATE_EXPR.format(col="date_end") + " <= ?"
            params.append(_date_to_iso(filters["date_to"]).replace("-", ""))
        if filters.get("q"):
            q_filter = filters["q"].lower()

    sort_map = {
        "number": "number",
        "name": "name",
        "date": _ISO_DATE_EXPR.format(col="date_start"),
        "district": "district",
        "position": "position",
    }
    sort_col = sort_map.get(sort_by, "number")
    sort_order = "DESC" if sort_dir == "desc" else "ASC"
    sql += f" ORDER BY {sort_col} {sort_order}"

    rows = conn.execute(sql, params).fetchall()
    result = []
    for r in rows:
        item = dict(r)
        if q_filter:
            searchable = ' '.join([
                item.get('name', ''), item.get('workplace', ''),
                item.get('position', ''), item.get('district', ''),
            ]).lower()
            if q_filter not in searchable:
                continue
        result.append(item)
    return result


def get_main_import_file(conn, folder_path):
    """Возвращает путь к основному Excel-файлу в папке.
    Предпочитает .xlsx с наибольшим номером версии (v4 > v3 > v2),
    иначе — самый большой .xlsx по размеру."""
    import re
    folder = Path(folder_path)
    if not folder.exists():
        return None
    xlsx_files = list(folder.glob("*.xlsx"))
    if not xlsx_files:
        return None
    # Сортируем по номеру версии (v4 > v3), затем по размеру
    def version_key(f):
        m = re.search(r'_v(\d+)', f.name)
        ver = int(m.group(1)) if m else 0
        return (ver, f.stat().st_size)
    xlsx_files.sort(key=version_key, reverse=True)
    return xlsx_files[0]


def export_to_main_excel(conn, folder_path):
    """Выгружает все данные из БД в основной Excel-файл (v4.xlsx).
    Перезаписывает листы 2023-2026 и Эксперты годам данными из БД.
    Сохраняет стили ячеек (границы, шрифт, перенос, ширины колонок).
    Пишет в копию (uploads) всегда, в оригинал (exel) — если не заблокирован."""
    from openpyxl import Workbook, load_workbook
    from copy import copy
    from openpyxl.styles import Font, Alignment, Border, Side, PatternFill

    main_path = get_main_import_file(conn, folder_path)
    if not main_path:
        raise ValueError("Не найден .xlsx файл в папке exel для выгрузки")

    # Найдём копию в uploads (stored_path) — туда пишем всегда,
    # даже если оригинал заблокирован Excel.
    imp = conn.execute(
        "SELECT stored_path, source_path FROM imports WHERE original_name LIKE '%.xlsx' "
        "ORDER BY (SELECT COUNT(*) FROM registry r WHERE r.import_id = imports.id) DESC LIMIT 1"
    ).fetchone()
    stored_path = Path(imp["stored_path"]) if imp and imp["stored_path"] else None

    # Рабочий путь: копия (если есть), иначе оригинал
    work_path = stored_path if stored_path and stored_path.exists() else main_path

    # Читаем существующий файл, чтобы сохранить стили заголовков
    wb = load_workbook(str(work_path))
    existing_sheets = list(wb.sheetnames)

    # Собираем все записи из БД, сгруппированные по (year, is_expert)
    rows = conn.execute(
        "SELECT number, name, workplace, position, course, year, period, "
        "date_start, date_end, district, org_type, funding_source, gender, "
        "course_provider, incoming_letter, response_letter, do_order, "
        "cro_letter, certificate_series, certificate_reg, is_expert, "
        "source_sheet, source_row "
        "FROM registry ORDER BY year, is_expert, name"
    ).fetchall()

    # Группируем по листам
    from collections import defaultdict
    by_sheet = defaultdict(list)
    for r in rows:
        year = r["year"]
        is_expert = r["is_expert"]
        if is_expert:
            sheet_name = f"Эксперты {year}"
        else:
            sheet_name = str(year) if year else "Без года"
        by_sheet[sheet_name].append(dict(r))

    # Карта полей БД → колонки Excel (по заголовкам)
    # Читаем заголовки из первого существующего листа
    header_map = None
    ref_sheet = None
    for sn in existing_sheets:
        ws_tmp = wb[sn]
        headers = [ws_tmp.cell(row=1, column=c).value for c in range(1, ws_tmp.max_column + 1)]
        if headers and any(h for h in headers):
            header_map = headers
            ref_sheet = ws_tmp
            break

    # Если нет заголовков — используем стандартные
    if not header_map:
        header_map = [
            "№", "ФИО слушателя", "Место работы", "Должность", "Наименование курса",
            "Год", "Сроки обучения", "Дата начала", "Дата окончания", "Район",
            "Тип ОУ", "Источник финансирования", "Пол", "Кто проводит курсы",
            "ВХ ИРО/ДР", "ОТВЕТ ИРО/ДР", "ПРИКАЗ ДО", "ПИСЬМО ЦРО",
            "Серия № удостоверения", "Рег. № удостоверения",
        ]

    # Сопоставляем поля БД с заголовками через _build_excel_col_map_from_headers
    col_map = _build_excel_col_map_from_headers(header_map)

    # Поля БД, которые записываем
    db_fields = [
        "number", "name", "workplace", "position", "course", "year",
        "period", "date_start", "date_end", "district", "org_type",
        "funding_source", "gender", "course_provider", "incoming_letter",
        "response_letter", "do_order", "cro_letter", "certificate_series",
        "certificate_reg",
    ]

    # Подготовим стили для данных (на основе заголовков, но без заливки и без bold)
    data_font = Font(name="Calibri", size=11)
    thin_border = Border(
        left=Side(style="thin"),
        right=Side(style="thin"),
        top=Side(style="thin"),
        bottom=Side(style="thin"),
    )
    data_alignment = Alignment(vertical="top", wrap_text=True)

    # Сохраним ширины колонок из первого листа
    col_widths = {}
    if ref_sheet:
        from openpyxl.utils import get_column_letter
        for c in range(1, len(header_map) + 1):
            letter = get_column_letter(c)
            w = ref_sheet.column_dimensions[letter].width
            if w:
                col_widths[letter] = w

    sheets_written = {}
    for sheet_name, records in by_sheet.items():
        # Создаём лист если его нет
        if sheet_name in wb.sheetnames:
            ws = wb[sheet_name]
            # Очищаем данные (строки 2+), сохраняем заголовки
            if ws.max_row > 1:
                ws.delete_rows(2, ws.max_row - 1)
        else:
            ws = wb.create_sheet(title=sheet_name)
            # Копируем заголовки и их стиль из первого листа
            if ref_sheet:
                for c in range(1, len(header_map) + 1):
                    src_cell = ref_sheet.cell(row=1, column=c)
                    dst_cell = ws.cell(row=1, column=c, value=header_map[c - 1])
                    dst_cell.font = copy(src_cell.font)
                    dst_cell.fill = copy(src_cell.fill)
                    dst_cell.border = copy(src_cell.border)
                    dst_cell.alignment = copy(src_cell.alignment)
                    dst_cell.number_format = src_cell.number_format
            else:
                for c, h in enumerate(header_map, 1):
                    ws.cell(row=1, column=c, value=h)

        # Восстановим ширины колонок
        from openpyxl.utils import get_column_letter
        for c in range(1, len(header_map) + 1):
            letter = get_column_letter(c)
            if letter in col_widths:
                ws.column_dimensions[letter].width = col_widths[letter]

        # Записываем данные
        for row_idx, rec in enumerate(records, 2):
            for field in db_fields:
                if field in col_map:
                    col_idx = col_map[field] + 1
                    val = rec.get(field)
                    # Преобразуем даты в строку в формате ДД.ММ.ГГГГ
                    if field in ("date_start", "date_end") and val:
                        s = str(val)
                        if "-" in s and len(s) >= 10:
                            try:
                                from datetime import datetime
                                dt = datetime.fromisoformat(s.split("T")[0])
                                val = dt.strftime("%d.%m.%Y")
                            except Exception:
                                pass
                    cell = ws.cell(row=row_idx, column=col_idx, value=val if val is not None else "")
                    cell.font = copy(data_font)
                    cell.border = copy(thin_border)
                    cell.alignment = copy(data_alignment)
                    cell.number_format = "General"
            # Высота строки — адаптивно
            longest = max(
                len(str(rec.get("course", "") or "")),
                len(str(rec.get("workplace", "") or "")),
                len(str(rec.get("course_provider", "") or "")),
            )
            ws.row_dimensions[row_idx].height = max(16, min(60, 14 + (longest // 30) * 14))

        sheets_written[sheet_name] = len(records)

    # Сохраняем — сначала в копию (всегда), потом в оригинал (если не заблокирован)
    wb.save(str(work_path))
    wb.close()

    excel_errors = []
    if main_path != work_path:
        try:
            wb_orig = load_workbook(str(work_path))
            wb_orig.save(str(main_path))
            wb_orig.close()
        except PermissionError:
            excel_errors.append(f"{main_path.name}: файл заблокирован (открыт в Excel)")
        except Exception as e:
            excel_errors.append(f"{main_path.name}: {e}")

    # После выгрузки строки пересортировались — обновим source_row в БД,
    # перечитав файл и сопоставив записи по (name, year, course).
    # Используем iter_rows для скорости (cell-by-cell в read_only очень медленный).
    updated = 0
    try:
        wb2 = load_workbook(str(work_path), read_only=True)
        pos_map = {}
        for sn in wb2.sheetnames:
            ws2 = wb2[sn]
            rows_iter = ws2.iter_rows(min_row=1, max_row=ws2.max_row, values_only=False)
            try:
                header_row = next(rows_iter)
            except StopIteration:
                continue
            headers = [c.value for c in header_row]
            col_map2 = _build_excel_col_map_from_headers(headers)
            name_idx = col_map2.get("name", 10)
            year_idx = col_map2.get("year", 1)
            course_idx = col_map2.get("course", 3)
            for row_cells in rows_iter:
                r_num = row_cells[0].row if row_cells else 0
                if r_num < 2 or not row_cells:
                    continue
                nm = row_cells[name_idx].value if name_idx < len(row_cells) else None
                yr = row_cells[year_idx].value if year_idx < len(row_cells) else None
                cr = row_cells[course_idx].value if course_idx < len(row_cells) else None
                if nm:
                    pos_map[(str(nm), str(yr) if yr else "", str(cr) if cr else "")] = (sn, r_num)
        wb2.close()

        for r in conn.execute("SELECT id, name, year, course, source_sheet, source_row FROM registry").fetchall():
            key = (r["name"] or "", str(r["year"]) if r["year"] else "", r["course"] or "")
            if key in pos_map:
                new_sheet, new_row = pos_map[key]
                if r["source_sheet"] != new_sheet or r["source_row"] != new_row:
                    conn.execute(
                        "UPDATE registry SET source_sheet = ?, source_row = ? WHERE id = ?",
                        (new_sheet, new_row, r["id"]),
                    )
                    updated += 1
        conn.commit()
    except Exception:
        pass

    return {
        "ok": True,
        "file": main_path.name,
        "path": str(main_path),
        "total_records": len(rows),
        "sheets": sheets_written,
        "rows_reindexed": updated,
        "excel_errors": excel_errors,
    }


def auto_import_from_folder(conn, folder_path):
    """Auto-import all .xls files from a folder if not already imported."""
    folder = Path(folder_path)
    if not folder.exists():
        return []
    results = []
    for f in sorted(list(folder.glob("*.xls")) + list(folder.glob("*.xlsx"))):
        try:
            result = import_xls(conn, f, source_path=str(f.resolve()))
            results.append(result)
        except Exception as e:
            results.append({"error": str(e), "file_name": f.name})
    return results


def get_stats(conn):
    """Return comprehensive statistics for the dashboard."""
    years = [r["year"] for r in conn.execute(
        "SELECT DISTINCT year FROM registry WHERE year IS NOT NULL ORDER BY year"
    ).fetchall()]

    # Totals
    total_records = conn.execute("SELECT COUNT(*) as c FROM registry").fetchone()["c"]
    total_listeners = conn.execute("SELECT COUNT(DISTINCT name) as c FROM registry").fetchone()["c"]
    total_courses = conn.execute("SELECT COUNT(DISTINCT course) as c FROM registry WHERE course != ''").fetchone()["c"]
    total_workplaces = conn.execute("SELECT COUNT(DISTINCT workplace) as c FROM registry WHERE workplace != ''").fetchone()["c"]
    total_experts = conn.execute("SELECT COUNT(*) as c FROM registry WHERE is_expert = 1").fetchone()["c"]
    total_expert_listeners = conn.execute("SELECT COUNT(DISTINCT name) as c FROM registry WHERE is_expert = 1").fetchone()["c"]

    # Per-year breakdown
    by_year = []
    for y in years:
        row = conn.execute(
            "SELECT COUNT(*) as records, COUNT(DISTINCT name) as listeners, COUNT(DISTINCT course) as courses, COUNT(DISTINCT workplace) as workplaces FROM registry WHERE year = ?",
            (y,),
        ).fetchone()
        by_year.append({
            "year": y,
            "records": row["records"],
            "listeners": row["listeners"],
            "courses": row["courses"],
            "workplaces": row["workplaces"],
        })

    # By org_type
    by_org_type = [dict(r) for r in conn.execute(
        "SELECT org_type, COUNT(*) as count, COUNT(DISTINCT name) as listeners FROM registry WHERE org_type != '' GROUP BY org_type ORDER BY count DESC"
    ).fetchall()]

    # By district
    by_district = [dict(r) for r in conn.execute(
        "SELECT district, COUNT(*) as count, COUNT(DISTINCT name) as listeners FROM registry WHERE district != '' GROUP BY district ORDER BY count DESC"
    ).fetchall()]

    # All positions
    by_position = [dict(r) for r in conn.execute(
        "SELECT position, COUNT(*) as count FROM registry WHERE position != '' GROUP BY position ORDER BY count DESC"
    ).fetchall()]

    # All courses by attendance
    by_course = [dict(r) for r in conn.execute(
        "SELECT course, COUNT(*) as count, COUNT(DISTINCT name) as listeners FROM registry WHERE course != '' GROUP BY course ORDER BY count DESC"
    ).fetchall()]

    # All workplaces
    by_workplace = [dict(r) for r in conn.execute(
        "SELECT workplace, COUNT(*) as count, COUNT(DISTINCT name) as listeners FROM registry WHERE workplace != '' GROUP BY workplace ORDER BY count DESC"
    ).fetchall()]

    # All listeners (most courses taken first)
    by_top_listeners = [dict(r) for r in conn.execute(
        "SELECT name, COUNT(*) as count FROM registry GROUP BY name ORDER BY count DESC"
    ).fetchall()]

    return {
        "totals": {
            "records": total_records,
            "listeners": total_listeners,
            "courses": total_courses,
            "workplaces": total_workplaces,
            "years": len(years),
            "experts": total_experts,
            "expert_listeners": total_expert_listeners,
        },
        "years": years,
        "by_year": by_year,
        "by_org_type": by_org_type,
        "by_district": by_district,
        "by_position": by_position,
        "by_course": by_course,
        "by_workplace": by_workplace,
        "by_top_listeners": by_top_listeners,
    }
