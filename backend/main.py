from __future__ import annotations

import ipaddress
import io
import json
import re
import sqlite3
import tarfile
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from starlette.datastructures import UploadFile

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DB_PATH = PROJECT_ROOT / "reports.db"
DIST_DIR = PROJECT_ROOT / "dist"
USER_IP_MAP_PATH = PROJECT_ROOT / "backend" / "config" / "user_ip_map.json"
APP_CONFIG_PATH = PROJECT_ROOT / "backend" / "config" / "app_config.json"
LOCAL_DIR_CONFIG_PATH = PROJECT_ROOT / "backend" / "config" / "local_dir_config.yaml"

OWNER_KEYS = ("pkgs", "owner", "负责人", "处理人", "责任人")
FAULT_KEYS = ("desc", "fault", "fault_desc", "故障", "故障描述", "问题描述")
SUPPORTED_EXTENSIONS = {".xlsx", ".xls", ".csv"}
CSV_ENCODINGS = ("utf-8", "utf-8-sig", "gb18030", "gbk")
ARCHIVE_SUFFIXES = (
    ".zip",
    ".tar",
    ".tar.gz",
    ".tgz",
    ".tar.bz2",
    ".tbz2",
    ".tar.xz",
    ".txz",
)
TARGET_ARCHIVE_MEMBER = "alarm_local.csv"
REPORT_TYPE_NORMAL = "normal"
REPORT_TYPE_AGGREGATE_LATEST_ALL = "aggregate_latest_all"
AGGREGATE_REPORT_FILENAME = "汇总"
USER_IP_MAP: dict[str, dict[str, Any]] = {}
DEFAULT_APP_CONFIG: dict[str, Any] = {
    "archive_backup_enabled": True,
    "archive_backup_dir": "archive_backups",
    "max_upload_size_mb": 500,
    "alarm_warning_threshold": 100,
}
APP_CONFIG: dict[str, Any] = DEFAULT_APP_CONFIG.copy()

app = FastAPI(title="Fault Report Analyzer API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with get_connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                summary TEXT NOT NULL,
                raw_data TEXT,
                uploader_user TEXT,
                uploader_uid INTEGER,
                uploader_ip TEXT,
                report_type TEXT NOT NULL DEFAULT 'normal'
            )
            """
        )
        existing_columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(reports)").fetchall()
        }
        if "uploader_user" not in existing_columns:
            conn.execute("ALTER TABLE reports ADD COLUMN uploader_user TEXT")
        if "uploader_uid" not in existing_columns:
            conn.execute("ALTER TABLE reports ADD COLUMN uploader_uid INTEGER")
        if "uploader_ip" not in existing_columns:
            conn.execute("ALTER TABLE reports ADD COLUMN uploader_ip TEXT")
        if "report_type" not in existing_columns:
            conn.execute(
                "ALTER TABLE reports ADD COLUMN report_type TEXT DEFAULT 'normal'"
            )
        conn.commit()


def normalize_ip(raw_value: str | None) -> str | None:
    if raw_value is None:
        return None

    value = raw_value.strip().strip('"')
    if not value or value.lower() == "unknown":
        return None

    if value.startswith("::ffff:"):
        value = value[7:]
    if "%" in value:
        value = value.split("%", 1)[0]

    candidates = [value]
    if value.count(":") == 1 and "." in value:
        candidates.append(value.rsplit(":", 1)[0])

    for candidate in candidates:
        try:
            parsed = ipaddress.ip_address(candidate)
            if isinstance(parsed, ipaddress.IPv6Address) and parsed.ipv4_mapped:
                return str(parsed.ipv4_mapped)
            return str(parsed)
        except ValueError:
            continue
    return None


def load_user_ip_map() -> dict[str, dict[str, Any]]:
    if not USER_IP_MAP_PATH.exists():
        return {}

    try:
        entries = json.loads(USER_IP_MAP_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid JSON in {USER_IP_MAP_PATH}: {exc}") from exc

    if not isinstance(entries, list):
        raise RuntimeError(f"Invalid format in {USER_IP_MAP_PATH}: root must be a list")

    mapping: dict[str, dict[str, Any]] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        ip_value = normalize_ip(str(entry.get("ip", "")).strip())
        if not ip_value:
            continue
        mapping[ip_value] = entry
    return mapping


def load_app_config() -> dict[str, Any]:
    config = DEFAULT_APP_CONFIG.copy()
    if not APP_CONFIG_PATH.exists():
        return config

    try:
        loaded = json.loads(APP_CONFIG_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid JSON in {APP_CONFIG_PATH}: {exc}") from exc

    if not isinstance(loaded, dict):
        raise RuntimeError(f"Invalid format in {APP_CONFIG_PATH}: root must be an object")

    config.update(loaded)
    return config


def get_archive_backup_dir() -> Path:
    raw_dir = str(APP_CONFIG.get("archive_backup_dir", DEFAULT_APP_CONFIG["archive_backup_dir"])).strip()
    if not raw_dir:
        raw_dir = str(DEFAULT_APP_CONFIG["archive_backup_dir"])

    backup_dir = Path(raw_dir).expanduser()
    if not backup_dir.is_absolute():
        backup_dir = (PROJECT_ROOT / backup_dir).resolve()
    return backup_dir


def get_max_upload_size_bytes() -> int:
    value = APP_CONFIG.get("max_upload_size_mb", DEFAULT_APP_CONFIG["max_upload_size_mb"])
    try:
        size_mb = int(value)
    except (TypeError, ValueError):
        size_mb = int(DEFAULT_APP_CONFIG["max_upload_size_mb"])

    if size_mb < 1:
        size_mb = int(DEFAULT_APP_CONFIG["max_upload_size_mb"])
    return size_mb * 1024 * 1024


def get_alarm_warning_threshold() -> int:
    value = APP_CONFIG.get("alarm_warning_threshold", DEFAULT_APP_CONFIG["alarm_warning_threshold"])
    try:
        threshold = int(value)
    except (TypeError, ValueError):
        threshold = int(DEFAULT_APP_CONFIG["alarm_warning_threshold"])
    if threshold < 1:
        threshold = int(DEFAULT_APP_CONFIG["alarm_warning_threshold"])
    return threshold


def ensure_archive_backup_dir() -> None:
    if not bool(APP_CONFIG.get("archive_backup_enabled", True)):
        return
    get_archive_backup_dir().mkdir(parents=True, exist_ok=True)


def get_client_ip(request: Request) -> tuple[str | None, str]:
    xff = request.headers.get("x-forwarded-for")
    if xff:
        parts = [part.strip() for part in xff.split(",") if part.strip()]
        for part in parts:
            normalized = normalize_ip(part)
            if normalized:
                return normalized, "x-forwarded-for"

    x_real_ip = request.headers.get("x-real-ip")
    normalized_real = normalize_ip(x_real_ip)
    if normalized_real:
        return normalized_real, "x-real-ip"

    client_host = request.client.host if request.client else None
    normalized_client = normalize_ip(client_host)
    if normalized_client:
        return normalized_client, "client.host"

    return None, "unknown"


def get_requester_identity(request: Request) -> dict[str, Any]:
    client_ip, source = get_client_ip(request)
    user = USER_IP_MAP.get(client_ip) if client_ip else None
    return {
        "client_ip": client_ip,
        "ip_source": source,
        "user": user,
    }


def normalize_filename(name: str | None) -> str:
    if not name:
        return "uploaded.xlsx"
    try:
        return name.encode("latin1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return name


def clean_text(value: Any, fallback: str) -> str:
    if value is None:
        return fallback
    text = str(value).strip()
    if not text or text.lower() in {"nan", "none", "null"}:
        return fallback
    return text


def pick_value(row: dict[str, Any], keys: tuple[str, ...], fallback: str) -> str:
    for key in keys:
        if key in row:
            value = clean_text(row[key], "")
            if value:
                return value
    return fallback


def is_archive_filename(filename: str) -> bool:
    lower = filename.lower()
    return any(lower.endswith(suffix) for suffix in ARCHIVE_SUFFIXES)


def backup_archive(
    filename: str,
    content: bytes,
    requester_identity: dict[str, Any],
    report_id: int,
) -> str | None:
    if not is_archive_filename(filename):
        return None
    if not bool(APP_CONFIG.get("archive_backup_enabled", True)):
        return None

    requester_user = requester_identity.get("user")
    username = requester_user.get("user") if isinstance(requester_user, dict) else "unknown_user"
    safe_username = re.sub(r"[^A-Za-z0-9._-]+", "_", str(username).strip()) or "unknown_user"

    user_backup_dir = get_archive_backup_dir() / safe_username
    user_backup_dir.mkdir(parents=True, exist_ok=True)

    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(filename).name)
    if not safe_name:
        safe_name = "archive_upload.bin"
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    backup_path = user_backup_dir / f"{timestamp}_report_{report_id}_{safe_name}"
    backup_path.write_bytes(content)
    return str(backup_path)


def find_alarm_csv_in_zip(content: bytes) -> tuple[str, bytes]:
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as zf:
            candidates: list[zipfile.ZipInfo] = []
            for member in zf.infolist():
                if member.is_dir():
                    continue
                if Path(member.filename).name.lower() == TARGET_ARCHIVE_MEMBER:
                    candidates.append(member)
            if not candidates:
                raise HTTPException(
                    status_code=400,
                    detail="Archive does not contain alarm_local.csv",
                )

            candidates.sort(key=lambda item: (item.filename.count("/"), item.file_size))
            selected = candidates[0]
            extracted = zf.read(selected)
            if not extracted:
                raise HTTPException(status_code=400, detail="alarm_local.csv in archive is empty")
            return selected.filename, extracted
    except HTTPException:
        raise
    except zipfile.BadZipFile as exc:
        raise HTTPException(status_code=400, detail="Invalid zip archive") from exc


def find_alarm_csv_in_tar(content: bytes) -> tuple[str, bytes]:
    try:
        with tarfile.open(fileobj=io.BytesIO(content), mode="r:*") as tf:
            candidates = [
                member
                for member in tf.getmembers()
                if member.isfile() and Path(member.name).name.lower() == TARGET_ARCHIVE_MEMBER
            ]
            if not candidates:
                raise HTTPException(
                    status_code=400,
                    detail="Archive does not contain alarm_local.csv",
                )

            candidates.sort(key=lambda item: (item.name.count("/"), item.size))
            selected = candidates[0]
            extracted_file = tf.extractfile(selected)
            if extracted_file is None:
                raise HTTPException(status_code=400, detail="Failed to extract alarm_local.csv")
            extracted = extracted_file.read()
            if not extracted:
                raise HTTPException(status_code=400, detail="alarm_local.csv in archive is empty")
            return selected.name, extracted
    except HTTPException:
        raise
    except tarfile.TarError as exc:
        raise HTTPException(status_code=400, detail="Invalid tar archive") from exc


def resolve_analysis_source(filename: str, content: bytes) -> tuple[str, bytes, str | None]:
    if not is_archive_filename(filename):
        return filename, content, None

    lower = filename.lower()
    if lower.endswith(".zip"):
        inner_name, inner_content = find_alarm_csv_in_zip(content)
    else:
        inner_name, inner_content = find_alarm_csv_in_tar(content)
    return TARGET_ARCHIVE_MEMBER, inner_content, inner_name


def parse_table_rows(content: bytes, suffix: str) -> list[dict[str, Any]]:
    if suffix not in SUPPORTED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Only .xlsx/.xls/.csv files are supported")

    if suffix in {".xlsx", ".xls"}:
        try:
            workbook = pd.ExcelFile(io.BytesIO(content))
        except Exception as exc:
            raise HTTPException(status_code=400, detail="Invalid Excel file") from exc

        for sheet_name in workbook.sheet_names:
            frame = pd.read_excel(workbook, sheet_name=sheet_name, dtype=str).fillna("")
            rows = frame.to_dict(orient="records")
            if rows:
                return rows

        raise HTTPException(status_code=400, detail="Excel file contains no data rows")

    last_exc: Exception | None = None
    for encoding in CSV_ENCODINGS:
        try:
            frame = pd.read_csv(io.BytesIO(content), dtype=str, encoding=encoding).fillna("")
            rows = frame.to_dict(orient="records")
            if rows:
                return rows
            raise HTTPException(status_code=400, detail="CSV file contains no data rows")
        except UnicodeDecodeError as exc:
            last_exc = exc
            continue
        except HTTPException:
            raise
        except Exception as exc:
            last_exc = exc
            continue

    raise HTTPException(status_code=400, detail=f"Invalid CSV file: {last_exc}")


def analyze_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, int]] = {}
    for row in rows:
        owner = pick_value(row, OWNER_KEYS, "Unknown")
        fault = pick_value(row, FAULT_KEYS, "Unknown Fault")
        grouped.setdefault(owner, {})
        grouped[owner][fault] = grouped[owner].get(fault, 0) + 1

    result: list[dict[str, Any]] = []
    for owner, faults_map in grouped.items():
        faults = [{"name": name, "count": count} for name, count in faults_map.items()]
        faults.sort(key=lambda item: item["count"], reverse=True)
        total = sum(item["count"] for item in faults)
        result.append({"owner": owner, "faults": faults, "total": total})

    result.sort(key=lambda item: item["total"], reverse=True)
    return result


def merge_summary_items(summary_items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, int]] = {}
    for summary_item in summary_items:
        if not isinstance(summary_item, dict):
            continue

        owner = clean_text(summary_item.get("owner"), "Unknown")
        grouped.setdefault(owner, {})

        faults = summary_item.get("faults")
        if not isinstance(faults, list):
            continue

        for fault_item in faults:
            if not isinstance(fault_item, dict):
                continue
            fault_name = clean_text(fault_item.get("name"), "Unknown Fault")
            try:
                count = int(fault_item.get("count", 0))
            except (TypeError, ValueError):
                continue
            if count <= 0:
                continue
            grouped[owner][fault_name] = grouped[owner].get(fault_name, 0) + count

    merged: list[dict[str, Any]] = []
    for owner, faults_map in grouped.items():
        faults = [{"name": name, "count": count} for name, count in faults_map.items()]
        faults.sort(key=lambda item: item["count"], reverse=True)
        total = sum(item["count"] for item in faults)
        merged.append({"owner": owner, "faults": faults, "total": total})

    merged.sort(key=lambda item: item["total"], reverse=True)
    return merged


def parse_report_summary(summary_raw: str) -> list[dict[str, Any]]:
    try:
        parsed = json.loads(summary_raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    return [item for item in parsed if isinstance(item, dict)]


def get_uploader_identity_key(row: sqlite3.Row) -> str:
    uploader_user = clean_text(row["uploader_user"], "")
    if uploader_user:
        return f"user:{uploader_user}"
    uploader_ip = clean_text(row["uploader_ip"], "")
    if uploader_ip:
        return f"ip:{uploader_ip}"
    return "unknown:unknown"


def get_latest_reports_for_each_uploader(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    rows = conn.execute(
        """
        SELECT id, filename, created_at, summary, uploader_user, uploader_uid, uploader_ip, report_type
        FROM reports
        WHERE COALESCE(report_type, ?) != ?
        ORDER BY datetime(created_at) DESC, id DESC
        """,
        (REPORT_TYPE_NORMAL, REPORT_TYPE_AGGREGATE_LATEST_ALL),
    ).fetchall()

    latest_rows: list[sqlite3.Row] = []
    seen: set[str] = set()
    for row in rows:
        key = get_uploader_identity_key(row)
        if key in seen:
            continue
        seen.add(key)
        latest_rows.append(row)
    return latest_rows


def create_latest_aggregate_report(conn: sqlite3.Connection) -> dict[str, Any]:
    latest_rows = get_latest_reports_for_each_uploader(conn)
    if not latest_rows:
        raise HTTPException(status_code=400, detail="No reports available for aggregation")

    all_summary_items: list[dict[str, Any]] = []
    source_reports: list[dict[str, Any]] = []
    for row in latest_rows:
        summary_items = parse_report_summary(row["summary"])
        all_summary_items.extend(summary_items)
        source_reports.append(
            {
                "id": row["id"],
                "filename": row["filename"],
                "created_at": row["created_at"],
                "uploader_user": row["uploader_user"],
                "uploader_uid": row["uploader_uid"],
                "uploader_ip": row["uploader_ip"],
            }
        )

    merged_summary = merge_summary_items(all_summary_items)
    raw_data_payload = {
        "aggregation_type": "latest_report_per_uploader",
        "source_count": len(source_reports),
        "source_reports": source_reports,
    }
    existing_rows = conn.execute(
        """
        SELECT id
        FROM reports
        WHERE report_type = ?
        ORDER BY id ASC
        """,
        (REPORT_TYPE_AGGREGATE_LATEST_ALL,),
    ).fetchall()

    if existing_rows:
        report_id = int(existing_rows[0]["id"])
        conn.execute(
            """
            UPDATE reports
            SET filename = ?,
                created_at = CURRENT_TIMESTAMP,
                summary = ?,
                raw_data = ?,
                uploader_user = ?,
                uploader_uid = ?,
                uploader_ip = ?,
                report_type = ?
            WHERE id = ?
            """,
            (
                AGGREGATE_REPORT_FILENAME,
                json.dumps(merged_summary, ensure_ascii=False),
                json.dumps(raw_data_payload, ensure_ascii=False),
                "system",
                None,
                None,
                REPORT_TYPE_AGGREGATE_LATEST_ALL,
                report_id,
            ),
        )

        # Keep exactly one aggregate report record.
        extra_ids = [int(row["id"]) for row in existing_rows[1:]]
        if extra_ids:
            conn.executemany(
                "DELETE FROM reports WHERE id = ?",
                [(item_id,) for item_id in extra_ids],
            )
    else:
        cursor = conn.execute(
            """
            INSERT INTO reports (filename, summary, raw_data, uploader_user, uploader_uid, uploader_ip, report_type)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                AGGREGATE_REPORT_FILENAME,
                json.dumps(merged_summary, ensure_ascii=False),
                json.dumps(raw_data_payload, ensure_ascii=False),
                "system",
                None,
                None,
                REPORT_TYPE_AGGREGATE_LATEST_ALL,
            ),
        )
        report_id = int(cursor.lastrowid)

    conn.commit()
    report = get_report_by_id(conn, report_id)
    if report is None:
        raise HTTPException(status_code=500, detail="Failed to build aggregate report")
    return report


def to_report_payload(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "filename": row["filename"],
        "created_at": row["created_at"],
        "summary": json.loads(row["summary"]),
        "uploader_user": row["uploader_user"],
        "uploader_uid": row["uploader_uid"],
        "uploader_ip": row["uploader_ip"],
        "report_type": row["report_type"],
    }


def get_report_by_id(conn: sqlite3.Connection, report_id: int) -> dict[str, Any] | None:
    row = conn.execute(
        """
        SELECT id, filename, created_at, summary, uploader_user, uploader_uid, uploader_ip, report_type
        FROM reports
        WHERE id = ?
        """,
        (report_id,),
    ).fetchone()
    if row is None:
        return None
    return to_report_payload(row)


def analyze_and_store(filename: str, content: bytes, requester_identity: dict[str, Any]) -> dict[str, Any]:
    analysis_filename, analysis_content, archive_member = resolve_analysis_source(filename, content)
    suffix = Path(analysis_filename).suffix.lower()
    rows = parse_table_rows(analysis_content, suffix)
    summary = analyze_rows(rows)
    uploader = requester_identity.get("user")
    uploader_user = uploader.get("user") if isinstance(uploader, dict) else None
    uploader_uid = uploader.get("uid") if isinstance(uploader, dict) else None
    uploader_ip = requester_identity.get("client_ip")
    raw_data_payload: dict[str, Any] = {
        "rowCount": len(rows),
        "archive_member": archive_member,
        "archive_backup_path": None,
    }

    with get_connection() as conn:
        cursor = conn.execute(
            """
            INSERT INTO reports (filename, summary, raw_data, uploader_user, uploader_uid, uploader_ip, report_type)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                filename,
                json.dumps(summary, ensure_ascii=False),
                json.dumps(raw_data_payload, ensure_ascii=False),
                uploader_user,
                uploader_uid,
                uploader_ip,
                REPORT_TYPE_NORMAL,
            ),
        )
        report_id = int(cursor.lastrowid)
        archive_backup_path = backup_archive(filename, content, requester_identity, report_id)
        raw_data_payload["archive_backup_path"] = archive_backup_path
        conn.execute(
            "UPDATE reports SET raw_data = ? WHERE id = ?",
            (json.dumps(raw_data_payload, ensure_ascii=False), report_id),
        )
        conn.commit()
        report = get_report_by_id(conn, report_id)

    if report is None:
        raise HTTPException(status_code=500, detail="Failed to load inserted report")
    return report


async def process_upload(file: UploadFile, requester_identity: dict[str, Any]) -> dict[str, Any]:
    filename = normalize_filename(file.filename)
    content = await file.read()
    max_upload_size_bytes = get_max_upload_size_bytes()

    if not content:
        raise HTTPException(status_code=400, detail='No file uploaded. Use form-data field "file".')
    if len(content) > max_upload_size_bytes:
        max_upload_size_mb = max_upload_size_bytes // (1024 * 1024)
        raise HTTPException(status_code=413, detail=f"File is too large (max {max_upload_size_mb}MB)")

    return analyze_and_store(filename, content, requester_identity)


def process_file_path(file_path: str, requester_identity: dict[str, Any]) -> dict[str, Any]:
    path = Path(file_path.strip()).expanduser()
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=400, detail=f"File path not found: {file_path}")

    max_upload_size_bytes = get_max_upload_size_bytes()
    size = path.stat().st_size
    if size <= 0:
        raise HTTPException(status_code=400, detail="File is empty")
    if size > max_upload_size_bytes:
        max_upload_size_mb = max_upload_size_bytes // (1024 * 1024)
        raise HTTPException(status_code=413, detail=f"File is too large (max {max_upload_size_mb}MB)")

    content = path.read_bytes()
    return analyze_and_store(path.name, content, requester_identity)


async def process_form_file_input(request: Request) -> dict[str, Any]:
    requester_identity = get_requester_identity(request)
    form = await request.form(max_part_size=get_max_upload_size_bytes())
    if "file" not in form:
        raise HTTPException(status_code=400, detail='No file uploaded. Use form-data field "file".')

    payload = form.get("file")
    if isinstance(payload, UploadFile):
        return await process_upload(payload, requester_identity)
    if isinstance(payload, str):
        return process_file_path(payload, requester_identity)

    raise HTTPException(
        status_code=400,
        detail='Unsupported "file" field type. Use -F "file=@/path/report.xlsx" or -F "file=/path/report.csv"',
    )


@app.on_event("startup")
async def startup_event() -> None:
    global USER_IP_MAP, APP_CONFIG
    init_db()
    APP_CONFIG = load_app_config()
    ensure_archive_backup_dir()
    USER_IP_MAP = load_user_ip_map()


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/requester")
async def requester(request: Request) -> dict[str, Any]:
    return get_requester_identity(request)


@app.get("/api/ui-config")
async def ui_config() -> dict[str, Any]:
    return {
        "alarm_warning_threshold": get_alarm_warning_threshold(),
    }


@app.get("/api/local-dir-config")
async def local_dir_config() -> dict[str, Any]:
    if not LOCAL_DIR_CONFIG_PATH.exists():
        raise HTTPException(
            status_code=404,
            detail=f"Config file not found: {LOCAL_DIR_CONFIG_PATH}",
        )
    try:
        content = LOCAL_DIR_CONFIG_PATH.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        content = LOCAL_DIR_CONFIG_PATH.read_text(encoding="utf-8", errors="replace")
    return {
        "path": str(LOCAL_DIR_CONFIG_PATH),
        "content": content,
    }


@app.get("/api/reports")
async def list_reports() -> list[dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT id, filename, created_at, summary, uploader_user, uploader_uid, uploader_ip, report_type
            FROM reports
            ORDER BY datetime(created_at) DESC, id DESC
            """
        ).fetchall()
    return [to_report_payload(row) for row in rows]


@app.get("/api/reports/{report_id}")
async def get_report(report_id: int) -> dict[str, Any]:
    with get_connection() as conn:
        report = get_report_by_id(conn, report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="Report not found")
    return report


@app.delete("/api/reports/{report_id}")
async def delete_report(report_id: int) -> dict[str, bool]:
    with get_connection() as conn:
        cursor = conn.execute("DELETE FROM reports WHERE id = ?", (report_id,))
        conn.commit()
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Report not found")
    return {"success": True}


@app.post("/api/reports/analyze")
async def analyze_report(request: Request) -> dict[str, Any]:
    return await process_form_file_input(request)


@app.post("/api/reports/analyze-archive")
async def analyze_archive(request: Request) -> dict[str, Any]:
    return await process_form_file_input(request)


@app.post("/api/reports/aggregate-latest")
async def aggregate_latest_reports() -> dict[str, Any]:
    with get_connection() as conn:
        return create_latest_aggregate_report(conn)


@app.post("/api/upload")
async def upload_legacy(request: Request) -> dict[str, Any]:
    return await process_form_file_input(request)


if DIST_DIR.exists():
    dist_root = DIST_DIR.resolve()
    index_file = dist_root / "index.html"

    @app.get("/", include_in_schema=False)
    async def serve_index() -> FileResponse:
        return FileResponse(index_file)

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str) -> FileResponse:
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not Found")

        candidate = (dist_root / full_path).resolve()
        if candidate.is_file():
            try:
                candidate.relative_to(dist_root)
                return FileResponse(candidate)
            except ValueError:
                pass

        return FileResponse(index_file)
