from __future__ import annotations

import csv
import io
import json
import os
import re
import shutil
import sqlite3
import sys
import uuid
from datetime import datetime
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import pandas as pd


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
UPLOAD_DIR = ROOT / "uploads"
STATIC_DIR = ROOT / "static"
DB_PATH = DATA_DIR / "sigra_atendimento.sqlite3"

REQUIRED_COLUMNS = [
    "Número Ordem",
    "Status",
    "Nome Fantasia",
    "Data",
    "Data Agendada",
    "Data Realização",
    "Data Realizada",
]

ROW_ESSENTIAL_COLUMNS = [
    "Número Ordem",
    "Status",
    "Nome Fantasia",
    "Data",
]

DATE_COLUMNS = [
    "Data",
    "Data Aceita",
    "Data Agendamento",
    "Data Agendada",
    "Data Realização",
    "Data Realizada",
    "Data Não Realizada",
]


def blank(value) -> bool:
    if value is None:
        return True
    if pd.isna(value):
        return True
    return str(value).strip() in {"", " ", "nan", "NaT", "None"}


def text(value) -> str:
    return "" if blank(value) else str(value).strip()


def dt_or_none(value):
    if blank(value):
        return None
    parsed = pd.to_datetime(value, dayfirst=True, errors="coerce")
    if pd.isna(parsed):
        return None
    return parsed.to_pydatetime()


def dt_iso(value) -> str:
    parsed = dt_or_none(value)
    return "" if parsed is None else parsed.isoformat(timespec="seconds")


def date_label(value: str) -> str:
    if not value:
        return ""
    try:
        return datetime.fromisoformat(value).strftime("%d/%m/%Y")
    except ValueError:
        return value


def regional_from_uf(uf: str) -> str:
    uf = text(uf).upper()
    if uf in {"SP", "RJ", "MG", "ES"}:
        return "Sudeste"
    if uf in {"PR", "SC", "RS"}:
        return "Sul"
    if uf in {"BA", "PE", "CE", "MA", "PB", "PI", "RN", "SE", "AL"}:
        return "Nordeste"
    if uf in {"AM", "PA", "RO", "RR", "AC", "AP", "TO"}:
        return "Norte"
    if uf in {"GO", "MT", "MS", "DF"}:
        return "Centro-Oeste"
    return "Não informado"


def normalized_blob(*values) -> str:
    blob = " ".join(text(value).upper() for value in values)
    replacements = {
        "Á": "A",
        "À": "A",
        "Â": "A",
        "Ã": "A",
        "É": "E",
        "Ê": "E",
        "Í": "I",
        "Ó": "O",
        "Ô": "O",
        "Õ": "O",
        "Ú": "U",
        "Ç": "C",
    }
    for old, new in replacements.items():
        blob = blob.replace(old, new)
    return blob


def is_robo_programada(row: dict) -> bool:
    blob = normalized_blob(row.get("Usuário"), row.get("Solicitante"), row.get("Justificativa"), row.get("Observação"), row.get("Escopo"))
    return "ROBO.PROGRAMADA" in blob or "ROBO PROGRAMADA" in blob or "ROBO PROVISORIO" in blob or "AGENDADA AUTOMATICAMENTE" in blob


def is_confirmacao_mtr(row: dict) -> bool:
    blob = normalized_blob(row.get("Observação"), row.get("Escopo"), row.get("Justificativa"), row.get("Usuário Realizada"))
    fornecedor_flag = normalized_blob(row.get("Confirmado pelo fornecedor")) == "SIM"
    return fornecedor_flag or "CONFIRMACAO DE COLETA DA MTR" in blob or "CONFIRMACAO.COLETA" in blob


def classify_origin_and_confirmation(row: dict) -> dict:
    data_realizada = dt_iso(row.get("Data Realizada"))
    via_mtr = is_confirmacao_mtr(row)
    robo = is_robo_programada(row)

    origem_os = "Robô Programada" if robo else "Sob demanda"
    responsavel_abertura = "Robô Programada" if robo else text(row.get("Usuário"))

    if data_realizada and via_mtr:
        origem_confirmacao = "Confirmada pelo fornecedor via MTR"
        responsavel_confirmacao = "Fornecedor via MTR"
        produtividade_manual = "Não"
    elif data_realizada:
        origem_confirmacao = "Confirmada por colaborador"
        responsavel_confirmacao = text(row.get("Usuário Realizada")) or text(row.get("Usuário"))
        if normalized_blob(responsavel_confirmacao).startswith("ROBO"):
            responsavel_confirmacao = ""
            origem_confirmacao = "Confirmação sem colaborador identificado"
            produtividade_manual = "Não"
        else:
            produtividade_manual = "Sim" if responsavel_confirmacao else "Não"
    elif dt_iso(row.get("Data Realização")):
        origem_confirmacao = "Pendente de confirmação pelo atendimento"
        responsavel_confirmacao = ""
        produtividade_manual = "Não"
    else:
        origem_confirmacao = "Não confirmada"
        responsavel_confirmacao = ""
        produtividade_manual = "Não"

    processo_origem = "Confirmação de Coleta via MTR" if via_mtr else origem_os
    return {
        "origem_os": origem_os,
        "processo_origem": processo_origem,
        "responsavel_abertura": responsavel_abertura,
        "origem_confirmacao": origem_confirmacao,
        "responsavel_confirmacao": responsavel_confirmacao,
        "produtividade_manual": produtividade_manual,
    }


def normalize_status(row: dict) -> dict:
    original = text(row.get("Status")).upper()
    data_realizacao = dt_iso(row.get("Data Realização"))
    data_realizada = dt_iso(row.get("Data Realizada"))
    data_nao_realizada = dt_iso(row.get("Data Não Realizada"))
    data_agendada = dt_iso(row.get("Data Agendada"))
    atraso_agendamento = text(row.get('Atraso "Em Agendamento"')).upper() == "SIM"
    atraso_realizacao = text(row.get("Atraso na realização")).upper() == "SIM"

    if data_realizacao:
        status_operacional = "Coleta realizada pelo fornecedor"
    elif data_nao_realizada or "NÃO REALIZADA" in original or "NAO REALIZADA" in original:
        status_operacional = "Coleta não realizada"
    elif data_agendada or "AGENDADA" in original:
        status_operacional = "Coleta agendada"
    elif "EM AGENDAMENTO" in original:
        status_operacional = "Em agendamento"
    else:
        status_operacional = "Pendente"

    origin = classify_origin_and_confirmation(row)

    if data_realizada:
        status_confirmacao = "Confirmada"
    elif data_realizacao:
        status_confirmacao = "Pendente de confirmação"
    else:
        status_confirmacao = "Não confirmada"

    inconsistency = ""
    if data_realizada and not data_realizacao:
        inconsistency = "Data Realizada preenchida sem Data Realização"
        status_gerencial = "Inconsistência"
    elif data_realizacao and not data_realizada:
        status_gerencial = "Realizada fornecedor - pendente confirmação"
    elif data_realizacao and data_realizada:
        status_gerencial = "Realizada e confirmada"
    elif status_operacional == "Coleta não realizada":
        status_gerencial = "Não realizada"
    elif atraso_agendamento or atraso_realizacao:
        status_gerencial = "Em atraso"
    elif status_operacional == "Coleta agendada":
        status_gerencial = "Agendada"
    elif status_operacional == "Em agendamento":
        status_gerencial = "Em agendamento"
    else:
        status_gerencial = "Pendente"

    if atraso_agendamento and atraso_realizacao:
        prazo = "Atraso no agendamento e na realização"
    elif atraso_agendamento:
        prazo = "Atraso em agendamento"
    elif atraso_realizacao:
        prazo = "Atraso na realização"
    else:
        prazo = "Sem atraso indicado"

    is_closed = bool(data_realizacao and data_realizada)
    open_with_delay = not is_closed and (atraso_agendamento or atraso_realizacao)
    needs_action = bool(
        inconsistency
        or status_confirmacao == "Pendente de confirmação"
        or open_with_delay
        or status_gerencial in {"Não realizada", "Pendente"}
    )

    return {
        "status_operacional": status_operacional,
        "status_confirmacao": status_confirmacao,
        **origin,
        "status_gerencial": status_gerencial,
        "prazo": prazo,
        "situacao_gerencial": status_gerencial,
        "precisa_acao": "Sim" if needs_action else "Não",
        "inconsistencia": inconsistency,
    }


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    DATA_DIR.mkdir(exist_ok=True)
    UPLOAD_DIR.mkdir(exist_ok=True)
    with get_conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS imports (
                id TEXT PRIMARY KEY,
                file_name TEXT NOT NULL,
                imported_at TEXT NOT NULL,
                period_start TEXT,
                period_end TEXT,
                row_count INTEGER NOT NULL,
                unique_os_count INTEGER NOT NULL,
                duplicate_count INTEGER NOT NULL,
                missing_required_count INTEGER NOT NULL,
                inconsistency_count INTEGER NOT NULL,
                warning_count INTEGER NOT NULL,
                status TEXT NOT NULL,
                log_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                import_id TEXT NOT NULL,
                numero_os TEXT,
                cliente TEXT,
                unidade TEXT,
                regional TEXT,
                fornecedor TEXT,
                transportador TEXT,
                destinador TEXT,
                tipo_residuo TEXT,
                mtr TEXT,
                status_original TEXT,
                status_operacional TEXT,
                status_confirmacao TEXT,
                origem_os TEXT,
                processo_origem TEXT,
                responsavel_abertura TEXT,
                origem_confirmacao TEXT,
                responsavel_confirmacao TEXT,
                produtividade_manual TEXT,
                status_gerencial TEXT,
                data_abertura TEXT,
                data_agendada TEXT,
                data_realizacao TEXT,
                data_realizada TEXT,
                data_nao_realizada TEXT,
                motivo_nao_realizacao TEXT,
                usuario_responsavel TEXT,
                atendente_vinculado TEXT,
                prazo TEXT,
                situacao_gerencial TEXT,
                precisa_acao TEXT,
                observacoes TEXT,
                inconsistencias TEXT,
                raw_json TEXT NOT NULL,
                FOREIGN KEY(import_id) REFERENCES imports(id)
            );
            """
        )
        existing = {row["name"] for row in conn.execute("PRAGMA table_info(orders)").fetchall()}
        for name in [
            "origem_os",
            "processo_origem",
            "responsavel_abertura",
            "origem_confirmacao",
            "responsavel_confirmacao",
            "produtividade_manual",
        ]:
            if name not in existing:
                conn.execute(f"ALTER TABLE orders ADD COLUMN {name} TEXT")


def find_header_row(path: Path, sheet_name: str) -> int:
    raw = pd.read_excel(path, sheet_name=sheet_name, header=None, nrows=20)
    counts = raw.notna().sum(axis=1)
    return int(counts.idxmax()) if len(counts) else 0


def read_sigra_excel(path: Path) -> pd.DataFrame:
    excel = pd.ExcelFile(path)
    sheet = "Dados" if "Dados" in excel.sheet_names else excel.sheet_names[0]
    header_row = find_header_row(path, sheet)
    df = pd.read_excel(path, sheet_name=sheet, header=header_row).dropna(how="all")
    df.columns = [str(c).strip() for c in df.columns]
    return df


def choose_atendente(row: dict) -> str:
    for col in ["Usuário Realizada", "Usuário Agendada", "Usuário Aceita", "Usuário"]:
        value = text(row.get(col))
        if value:
            return value
    return ""


def import_excel(path: Path, original_name: str) -> dict:
    df = read_sigra_excel(path)
    missing_columns = [col for col in REQUIRED_COLUMNS if col not in df.columns]
    if missing_columns:
        raise ValueError(f"Campos obrigatórios ausentes: {', '.join(missing_columns)}")

    import_id = datetime.now().strftime("%Y%m%d%H%M%S") + "-" + uuid.uuid4().hex[:8]
    imported_at = datetime.now().isoformat(timespec="seconds")

    for col in DATE_COLUMNS:
        if col in df.columns:
            df[col] = pd.to_datetime(df[col].replace(" ", pd.NA), dayfirst=True, errors="coerce")

    numero_os_series = df["Número Ordem"].map(text)
    duplicates = numero_os_series[numero_os_series.duplicated(keep=False) & (numero_os_series != "")]
    period_start = dt_iso(df["Data"].min()) if "Data" in df.columns else ""
    period_end = dt_iso(df["Data"].max()) if "Data" in df.columns else ""

    orders = []
    missing_required_count = 0
    inconsistency_count = 0
    warning_count = 0
    logs = []

    for idx, row in df.iterrows():
        row_dict = row.to_dict()
        norm = normalize_status(row_dict)
        missing_required = [col for col in ROW_ESSENTIAL_COLUMNS if blank(row_dict.get(col))]
        if missing_required:
            missing_required_count += 1
            warning_count += 1
        if norm["inconsistencia"]:
            inconsistency_count += 1
            warning_count += 1

        numero_os = text(row_dict.get("Número Ordem"))
        if numero_os in set(duplicates):
            warning_count += 1

        fornecedor = text(row_dict.get("Fornecedor")) or text(row_dict.get("Transportador"))
        raw_clean = {str(k): ("" if blank(v) else str(v)) for k, v in row_dict.items()}
        order = {
            "import_id": import_id,
            "numero_os": numero_os,
            "cliente": text(row_dict.get("Nome/Razão Social Gerador")),
            "unidade": text(row_dict.get("Nome Fantasia")),
            "regional": regional_from_uf(row_dict.get("UF")),
            "fornecedor": fornecedor,
            "transportador": text(row_dict.get("Transportador")),
            "destinador": text(row_dict.get("Destinador")),
            "tipo_residuo": text(row_dict.get("Resíduo")),
            "mtr": text(row_dict.get("Número MTR")) or text(row_dict.get("Número MTR Provisório")),
            "status_original": text(row_dict.get("Status")),
            "status_operacional": norm["status_operacional"],
            "status_confirmacao": norm["status_confirmacao"],
            "origem_os": norm["origem_os"],
            "processo_origem": norm["processo_origem"],
            "responsavel_abertura": norm["responsavel_abertura"],
            "origem_confirmacao": norm["origem_confirmacao"],
            "responsavel_confirmacao": norm["responsavel_confirmacao"],
            "produtividade_manual": norm["produtividade_manual"],
            "status_gerencial": norm["status_gerencial"],
            "data_abertura": dt_iso(row_dict.get("Data")),
            "data_agendada": dt_iso(row_dict.get("Data Agendada")),
            "data_realizacao": dt_iso(row_dict.get("Data Realização")),
            "data_realizada": dt_iso(row_dict.get("Data Realizada")),
            "data_nao_realizada": dt_iso(row_dict.get("Data Não Realizada")),
            "motivo_nao_realizacao": text(row_dict.get("Motivo Recusa")) or text(row_dict.get("Justificativa")),
            "usuario_responsavel": text(row_dict.get("Usuário")),
            "atendente_vinculado": choose_atendente(row_dict),
            "prazo": norm["prazo"],
            "situacao_gerencial": norm["situacao_gerencial"],
            "precisa_acao": norm["precisa_acao"],
            "observacoes": text(row_dict.get("Observação")) or text(row_dict.get("Escopo")),
            "inconsistencias": "; ".join(filter(None, [norm["inconsistencia"], "Campos ausentes: " + ", ".join(missing_required) if missing_required else ""])),
            "raw_json": json.dumps(raw_clean, ensure_ascii=False),
        }
        orders.append(order)
        if order["inconsistencias"]:
            logs.append({"linha_excel": int(idx) + 3, "numero_os": numero_os, "alerta": order["inconsistencias"]})

    log_payload = {
        "arquivo": original_name,
        "importado_em": imported_at,
        "linhas_importadas": int(len(df)),
        "os_unicas": int(numero_os_series[numero_os_series != ""].nunique()),
        "duplicidades": sorted(set(duplicates)),
        "campos_obrigatorios_na_planilha": REQUIRED_COLUMNS,
        "campos_essenciais_por_linha": ROW_ESSENTIAL_COLUMNS,
        "alertas": logs[:500],
    }

    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO imports (
                id, file_name, imported_at, period_start, period_end, row_count,
                unique_os_count, duplicate_count, missing_required_count,
                inconsistency_count, warning_count, status, log_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                import_id,
                original_name,
                imported_at,
                period_start,
                period_end,
                int(len(df)),
                int(numero_os_series[numero_os_series != ""].nunique()),
                int(len(set(duplicates))),
                missing_required_count,
                inconsistency_count,
                warning_count,
                "Importado com alertas" if warning_count else "Importado",
                json.dumps(log_payload, ensure_ascii=False),
            ),
        )
        columns = list(orders[0].keys()) if orders else []
        if columns:
            placeholders = ", ".join("?" for _ in columns)
            conn.executemany(
                f"INSERT INTO orders ({', '.join(columns)}) VALUES ({placeholders})",
                [[order[col] for col in columns] for order in orders],
            )

    return import_summary(import_id)


def rows_to_dicts(rows) -> list[dict]:
    return [dict(row) for row in rows]


def latest_import_id(conn) -> str:
    row = conn.execute("SELECT id FROM imports ORDER BY imported_at DESC LIMIT 1").fetchone()
    return row["id"] if row else ""


def build_scope(query: dict) -> tuple[str, list, dict]:
    import_id = query.get("import_id", "latest")
    date_from = text(query.get("date_from"))
    date_to = text(query.get("date_to"))

    meta = {"mode": "import", "date_from": date_from, "date_to": date_to}
    if date_from or date_to:
        where = ["rn = 1"]
        params = []
        if date_from:
            where.append("date(data_agendada) >= date(?)")
            params.append(date_from)
        if date_to:
            where.append("date(data_agendada) <= date(?)")
            params.append(date_to)
        scope = f"""
            WITH scoped_orders AS (
                SELECT *
                FROM (
                    SELECT o.*, ROW_NUMBER() OVER (
                        PARTITION BY COALESCE(NULLIF(o.numero_os, ''), CAST(o.id AS TEXT))
                        ORDER BY i.imported_at DESC, o.id DESC
                    ) AS rn
                    FROM orders o
                    JOIN imports i ON i.id = o.import_id
                )
                WHERE {' AND '.join(where)}
            )
        """
        meta["mode"] = "date_range"
        return scope, params, meta

    if not import_id or import_id == "latest":
        with get_conn() as conn:
            import_id = latest_import_id(conn)
    meta["import_id"] = import_id
    return "WITH scoped_orders AS (SELECT * FROM orders WHERE import_id = ?)", [import_id], meta


def is_pending_confirmation_sql() -> str:
    return """
    data_agendada <> ''
    AND data_realizacao = ''
    AND data_realizada = ''
    AND status_gerencial <> 'Não realizada'
    """


def operational_owner_case_sql() -> str:
    return """
    CASE
        WHEN UPPER(unidade) LIKE '%ARAUCARIA%PR01%' THEN 'Ryan'
        WHEN UPPER(unidade) LIKE '%SC02%' THEN 'Ryan'
        WHEN UPPER(unidade) LIKE '%SP02%' THEN 'Giovanna'
        WHEN UPPER(unidade) LIKE '%RJ02%' THEN 'Ana'
        WHEN UPPER(unidade) LIKE '%SSP45%' THEN 'Dimitri'
        WHEN UPPER(unidade) LIKE '%SSP1%' THEN 'Dimitri'
        WHEN UPPER(unidade) LIKE '%SSP7%' THEN 'Dimitri'
        ELSE 'Não definido'
    END
    """


def import_summary(import_id: str) -> dict:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM imports WHERE id = ?", (import_id,)).fetchone()
        if not row:
            return {}
        item = dict(row)
        item["period_start_label"] = date_label(item["period_start"])
        item["period_end_label"] = date_label(item["period_end"])
        item["log"] = json.loads(item.pop("log_json"))
        return item


def count_by(conn, field: str, scope_sql: str, scope_params: list, limit: int = 12) -> list[dict]:
    allowed = {
        "status_gerencial",
        "status_original",
        "status_operacional",
        "status_confirmacao",
        "origem_os",
        "processo_origem",
        "responsavel_abertura",
        "origem_confirmacao",
        "responsavel_confirmacao",
        "produtividade_manual",
        "atendente_vinculado",
        "fornecedor",
        "unidade",
        "regional",
        "tipo_residuo",
        "prazo",
        "precisa_acao",
        "motivo_nao_realizacao",
    }
    if field not in allowed:
        raise ValueError("Campo de agrupamento inválido")
    rows = conn.execute(
        f"""
        {scope_sql}
        SELECT COALESCE(NULLIF({field}, ''), 'Não informado') AS label, COUNT(*) AS value
        FROM scoped_orders
        GROUP BY label
        ORDER BY value DESC, label
        LIMIT ?
        """,
        scope_params + [limit],
    ).fetchall()
    return rows_to_dicts(rows)


def count_manual_confirmations_by_attendant(conn, scope_sql: str, scope_params: list, limit: int = 12) -> list[dict]:
    rows = conn.execute(
        """
        {scope_sql}
        SELECT COALESCE(NULLIF(responsavel_confirmacao, ''), 'Não informado') AS label, COUNT(*) AS value
        FROM scoped_orders
        WHERE produtividade_manual = 'Sim'
        GROUP BY label
        ORDER BY value DESC, label
        LIMIT ?
        """.format(scope_sql=scope_sql),
        scope_params + [limit],
    ).fetchall()
    return rows_to_dicts(rows)


def performance_by(conn, field: str, scope_sql: str, scope_params: list, limit: int = 20) -> list[dict]:
    allowed = {"responsavel_confirmacao", "fornecedor", "responsavel_abertura"}
    if field not in allowed:
        raise ValueError("Campo de performance inválido")
    extra_where = " AND produtividade_manual = 'Sim'" if field == "responsavel_confirmacao" else ""
    rows = conn.execute(
        f"""
        {scope_sql}
        SELECT
            COALESCE(NULLIF({field}, ''), 'Não informado') AS label,
            COUNT(*) AS total,
            SUM(CASE WHEN status_gerencial = 'Realizada e confirmada' THEN 1 ELSE 0 END) AS confirmadas,
            SUM(CASE WHEN produtividade_manual = 'Sim' THEN 1 ELSE 0 END) AS confirmacoes_manuais,
            SUM(CASE WHEN origem_confirmacao = 'Confirmada pelo fornecedor via MTR' THEN 1 ELSE 0 END) AS confirmacoes_mtr,
            SUM(CASE WHEN status_confirmacao = 'Pendente de confirmação' THEN 1 ELSE 0 END) AS pendentes_confirmacao,
            SUM(CASE WHEN status_gerencial = 'Não realizada' THEN 1 ELSE 0 END) AS nao_realizadas,
            SUM(CASE WHEN precisa_acao = 'Sim' THEN 1 ELSE 0 END) AS precisam_acao,
            SUM(CASE WHEN inconsistencias <> '' THEN 1 ELSE 0 END) AS alertas
        FROM scoped_orders
        WHERE 1 = 1{extra_where}
        GROUP BY label
        ORDER BY total DESC, label
        LIMIT ?
        """,
        scope_params + [limit],
    ).fetchall()
    return rows_to_dicts(rows)


def performance_supplier(conn, scope_sql: str, scope_params: list, limit: int = 50) -> list[dict]:
    rows = conn.execute(
        f"""
        {scope_sql}
        SELECT
            COALESCE(NULLIF(fornecedor, ''), 'Não informado') AS label,
            COUNT(*) AS total,
            SUM(CASE WHEN data_agendada <> '' THEN 1 ELSE 0 END) AS coletas_agendadas,
            SUM(CASE WHEN status_gerencial = 'Realizada e confirmada' THEN 1 ELSE 0 END) AS confirmadas,
            SUM(CASE WHEN produtividade_manual = 'Sim' THEN 1 ELSE 0 END) AS confirmacoes_manuais,
            SUM(CASE WHEN origem_confirmacao = 'Confirmada pelo fornecedor via MTR' THEN 1 ELSE 0 END) AS confirmacoes_mtr,
            SUM(CASE WHEN data_agendada <> '' THEN 1 ELSE 0 END) - SUM(CASE WHEN origem_confirmacao = 'Confirmada pelo fornecedor via MTR' THEN 1 ELSE 0 END) AS pendentes_confirmacao,
            SUM(CASE WHEN {is_pending_confirmation_sql()} THEN 1 ELSE 0 END) AS pendentes_operacionais,
            SUM(CASE WHEN status_gerencial = 'Não realizada' THEN 1 ELSE 0 END) AS nao_realizadas,
            SUM(CASE WHEN precisa_acao = 'Sim' THEN 1 ELSE 0 END) AS precisam_acao,
            SUM(CASE WHEN inconsistencias <> '' THEN 1 ELSE 0 END) AS alertas
        FROM scoped_orders
        GROUP BY label
        ORDER BY pendentes_confirmacao DESC, total DESC, label
        LIMIT ?
        """,
        scope_params + [limit],
    ).fetchall()
    return rows_to_dicts(rows)


def performance_collaborator_unit(conn, scope_sql: str, scope_params: list) -> list[dict]:
    rows = conn.execute(
        f"""
        {scope_sql}
        SELECT
            COALESCE(NULLIF(unidade, ''), 'Não informado') AS unidade,
            COALESCE(NULLIF(responsavel_confirmacao, ''), 'Não informado') AS colaborador,
            COUNT(*) AS confirmacoes_manuais,
            SUM(CASE WHEN status_gerencial = 'Realizada e confirmada' THEN 1 ELSE 0 END) AS realizadas_confirmadas,
            SUM(CASE WHEN precisa_acao = 'Sim' THEN 1 ELSE 0 END) AS precisam_acao,
            SUM(CASE WHEN inconsistencias <> '' THEN 1 ELSE 0 END) AS alertas
        FROM scoped_orders
        WHERE produtividade_manual = 'Sim'
        GROUP BY unidade, colaborador
        ORDER BY confirmacoes_manuais DESC, unidade, colaborador
        """,
        scope_params,
    ).fetchall()
    return rows_to_dicts(rows)


def performance_unit_supplier(conn, scope_sql: str, scope_params: list) -> list[dict]:
    rows = conn.execute(
        f"""
        {scope_sql}
        SELECT
            COALESCE(NULLIF(unidade, ''), 'Não informado') AS unidade,
            COALESCE(NULLIF(fornecedor, ''), 'Não informado') AS fornecedor,
            COUNT(*) AS total,
            SUM(CASE WHEN data_agendada <> '' THEN 1 ELSE 0 END) AS coletas_agendadas,
            SUM(CASE WHEN status_gerencial = 'Realizada e confirmada' THEN 1 ELSE 0 END) AS total_confirmadas,
            SUM(CASE WHEN produtividade_manual = 'Sim' THEN 1 ELSE 0 END) AS confirmacoes_manuais,
            SUM(CASE WHEN origem_confirmacao = 'Confirmada pelo fornecedor via MTR' THEN 1 ELSE 0 END) AS confirmacoes_mtr,
            SUM(CASE WHEN data_agendada <> '' THEN 1 ELSE 0 END) - SUM(CASE WHEN origem_confirmacao = 'Confirmada pelo fornecedor via MTR' THEN 1 ELSE 0 END) AS pendentes_confirmacao_fornecedor,
            SUM(CASE WHEN {is_pending_confirmation_sql()} THEN 1 ELSE 0 END) AS pendentes_confirmacao,
            SUM(CASE WHEN status_gerencial = 'Não realizada' THEN 1 ELSE 0 END) AS nao_realizadas,
            SUM(CASE WHEN precisa_acao = 'Sim' THEN 1 ELSE 0 END) AS precisam_acao
        FROM scoped_orders
        GROUP BY unidade, fornecedor
        ORDER BY unidade, pendentes_confirmacao_fornecedor DESC, fornecedor
        """,
        scope_params,
    ).fetchall()
    return rows_to_dicts(rows)


def performance_operational_owner(conn, scope_sql: str, scope_params: list) -> list[dict]:
    owner_sql = operational_owner_case_sql()
    rows = conn.execute(
        f"""
        {scope_sql}
        SELECT
            {owner_sql} AS label,
            COUNT(*) AS total,
            SUM(CASE WHEN data_agendada <> '' THEN 1 ELSE 0 END) AS coletas_agendadas,
            SUM(CASE WHEN status_gerencial = 'Realizada e confirmada' THEN 1 ELSE 0 END) AS confirmadas,
            SUM(CASE WHEN produtividade_manual = 'Sim' THEN 1 ELSE 0 END) AS confirmacoes_manuais,
            SUM(CASE WHEN origem_confirmacao = 'Confirmada pelo fornecedor via MTR' THEN 1 ELSE 0 END) AS confirmacoes_mtr,
            SUM(CASE WHEN {is_pending_confirmation_sql()} THEN 1 ELSE 0 END) AS pendentes_confirmacao,
            SUM(CASE WHEN status_gerencial = 'Não realizada' THEN 1 ELSE 0 END) AS nao_realizadas,
            SUM(CASE WHEN precisa_acao = 'Sim' THEN 1 ELSE 0 END) AS precisam_acao,
            SUM(CASE WHEN inconsistencias <> '' THEN 1 ELSE 0 END) AS alertas
        FROM scoped_orders
        GROUP BY label
        ORDER BY pendentes_confirmacao DESC, coletas_agendadas DESC, label
        """
        ,
        scope_params,
    ).fetchall()
    return rows_to_dicts(rows)


def unit_operational_summary(conn, scope_sql: str, scope_params: list) -> list[dict]:
    owner_sql = operational_owner_case_sql()
    rows = conn.execute(
        f"""
        {scope_sql}
        SELECT
            {owner_sql} AS responsavel_operacional,
            COALESCE(NULLIF(unidade, ''), 'Não informado') AS unidade,
            SUM(CASE WHEN data_agendada <> '' THEN 1 ELSE 0 END) AS coletas_agendadas,
            SUM(CASE WHEN status_gerencial = 'Realizada e confirmada' THEN 1 ELSE 0 END) AS confirmadas,
            SUM(CASE WHEN produtividade_manual = 'Sim' THEN 1 ELSE 0 END) AS confirmacoes_manuais,
            SUM(CASE WHEN origem_confirmacao = 'Confirmada pelo fornecedor via MTR' THEN 1 ELSE 0 END) AS confirmacoes_mtr,
            SUM(CASE WHEN {is_pending_confirmation_sql()} THEN 1 ELSE 0 END) AS pendentes_confirmacao,
            SUM(CASE WHEN status_gerencial = 'Não realizada' THEN 1 ELSE 0 END) AS nao_realizadas,
            SUM(CASE WHEN precisa_acao = 'Sim' THEN 1 ELSE 0 END) AS precisam_acao
        FROM scoped_orders
        GROUP BY responsavel_operacional, unidade
        ORDER BY responsavel_operacional, coletas_agendadas DESC, unidade
        """,
        scope_params,
    ).fetchall()
    return rows_to_dicts(rows)


def pending_orders_by_unit(conn, scope_sql: str, scope_params: list) -> list[dict]:
    rows = conn.execute(
        f"""
        {scope_sql}
        SELECT
            COALESCE(NULLIF(unidade, ''), 'Não informado') AS unidade,
            id,
            numero_os,
            status_original,
            status_gerencial,
            status_operacional,
            origem_confirmacao,
            data_agendada,
            prazo,
            fornecedor,
            responsavel_abertura,
            responsavel_confirmacao
        FROM scoped_orders
        WHERE precisa_acao = 'Sim'
        ORDER BY unidade, data_agendada, numero_os
        """,
        scope_params,
    ).fetchall()
    return rows_to_dicts(rows)


def pending_confirmation_orders_by_unit(conn, scope_sql: str, scope_params: list) -> list[dict]:
    rows = conn.execute(
        f"""
        {scope_sql}
        SELECT
            COALESCE(NULLIF(unidade, ''), 'Não informado') AS unidade,
            id,
            numero_os,
            status_original,
            status_gerencial,
            status_operacional,
            origem_confirmacao,
            data_agendada,
            prazo,
            fornecedor,
            responsavel_abertura,
            responsavel_confirmacao
        FROM scoped_orders
        WHERE {is_pending_confirmation_sql()}
        ORDER BY unidade, data_agendada, numero_os
        """,
        scope_params,
    ).fetchall()
    return rows_to_dicts(rows)


def dashboard(import_id: str = "", date_from: str = "", date_to: str = "") -> dict:
    with get_conn() as conn:
        scope_sql, scope_params, scope_meta = build_scope({"import_id": import_id, "date_from": date_from, "date_to": date_to})
        import_id = scope_meta.get("import_id", import_id)
        if scope_meta["mode"] == "import" and not import_id:
            return {"has_data": False}

        if scope_meta["mode"] == "import":
            imp = import_summary(import_id)
        else:
            period = conn.execute(
                f"""
                {scope_sql}
                SELECT
                    MIN(data_agendada) AS period_start,
                    MAX(data_agendada) AS period_end,
                    COUNT(*) AS row_count,
                    COUNT(DISTINCT numero_os) AS unique_os_count
                FROM scoped_orders
                """,
                scope_params,
            ).fetchone()
            imp = {
                "id": "date-range",
                "file_name": "Histórico importado",
                "imported_at": "",
                "period_start": period["period_start"] or date_from,
                "period_end": period["period_end"] or date_to,
                "row_count": period["row_count"],
                "unique_os_count": period["unique_os_count"],
                "duplicate_count": 0,
                "missing_required_count": 0,
                "inconsistency_count": 0,
                "warning_count": 0,
                "status": "Histórico filtrado",
                "period_start_label": date_label(period["period_start"] or date_from),
                "period_end_label": date_label(period["period_end"] or date_to),
                "log": {"filtro": {"date_from": date_from, "date_to": date_to}},
            }

        total = conn.execute(f"{scope_sql} SELECT COUNT(*) AS c FROM scoped_orders", scope_params).fetchone()["c"]
        action = conn.execute(f"{scope_sql} SELECT COUNT(*) AS c FROM scoped_orders WHERE precisa_acao = 'Sim'", scope_params).fetchone()["c"]
        pending_confirmation = conn.execute(
            f"{scope_sql} SELECT COUNT(*) AS c FROM scoped_orders WHERE {is_pending_confirmation_sql()}",
            scope_params,
        ).fetchone()["c"]
        manual_confirmations = conn.execute(
            f"{scope_sql} SELECT COUNT(*) AS c FROM scoped_orders WHERE produtividade_manual = 'Sim'",
            scope_params,
        ).fetchone()["c"]
        mtr_confirmations = conn.execute(
            f"{scope_sql} SELECT COUNT(*) AS c FROM scoped_orders WHERE origem_confirmacao = 'Confirmada pelo fornecedor via MTR'",
            scope_params,
        ).fetchone()["c"]
        realized_confirmed = conn.execute(
            f"{scope_sql} SELECT COUNT(*) AS c FROM scoped_orders WHERE status_gerencial = 'Realizada e confirmada'",
            scope_params,
        ).fetchone()["c"]
        scheduled_collections = conn.execute(
            f"{scope_sql} SELECT COUNT(*) AS c FROM scoped_orders WHERE data_agendada <> ''",
            scope_params,
        ).fetchone()["c"]

        return {
            "has_data": True,
            "import": imp,
            "kpis": {
                "total_os": total,
                "os_unicas": imp["unique_os_count"],
                "coletas_agendadas": scheduled_collections,
                "realizadas_confirmadas": realized_confirmed,
                "pendentes_confirmacao": pending_confirmation,
                "confirmacoes_manuais": manual_confirmations,
                "confirmacoes_mtr": mtr_confirmations,
                "precisam_acao": action,
                "inconsistencias": imp["inconsistency_count"],
                "taxa_confirmacao": round((realized_confirmed / total) * 100, 1) if total else 0,
            },
            "charts": {
                "status_gerencial": count_by(conn, "status_gerencial", scope_sql, scope_params),
                "status_operacional": count_by(conn, "status_operacional", scope_sql, scope_params),
                "status_confirmacao": count_by(conn, "status_confirmacao", scope_sql, scope_params),
                "origem_os": count_by(conn, "origem_os", scope_sql, scope_params),
                "origem_confirmacao": count_by(conn, "origem_confirmacao", scope_sql, scope_params),
                "atendentes": count_manual_confirmations_by_attendant(conn, scope_sql, scope_params),
                "aberturas": count_by(conn, "responsavel_abertura", scope_sql, scope_params),
                "fornecedores": count_by(conn, "fornecedor", scope_sql, scope_params),
                "unidades": count_by(conn, "unidade", scope_sql, scope_params),
                "residuos": count_by(conn, "tipo_residuo", scope_sql, scope_params),
                "motivos": count_by(conn, "motivo_nao_realizacao", scope_sql, scope_params),
            },
            "performance": {
                "atendentes": performance_by(conn, "responsavel_confirmacao", scope_sql, scope_params),
                "aberturas": performance_by(conn, "responsavel_abertura", scope_sql, scope_params),
                "fornecedores": performance_supplier(conn, scope_sql, scope_params),
                "responsaveis_operacionais": performance_operational_owner(conn, scope_sql, scope_params),
                "colaborador_unidade": performance_collaborator_unit(conn, scope_sql, scope_params),
                "colaborador_unidade_fornecedor": performance_unit_supplier(conn, scope_sql, scope_params),
                "unidades": unit_operational_summary(conn, scope_sql, scope_params),
                "pendencias_unidade": pending_orders_by_unit(conn, scope_sql, scope_params),
                "pendentes_confirmacao_unidade": pending_confirmation_orders_by_unit(conn, scope_sql, scope_params),
            },
        }


def list_imports() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM imports ORDER BY imported_at DESC").fetchall()
    items = []
    for row in rows:
        item = dict(row)
        item.pop("log_json", None)
        item["period_start_label"] = date_label(item["period_start"])
        item["period_end_label"] = date_label(item["period_end"])
        items.append(item)
    return items


def list_orders(query: dict) -> dict:
    import_id = query.get("import_id", ["latest"])[0]
    search = query.get("search", [""])[0].strip()
    status = query.get("status", [""])[0].strip()
    action = query.get("action", [""])[0].strip()
    limit = min(int(query.get("limit", ["200"])[0] or 200), 1000)

    with get_conn() as conn:
        if not import_id or import_id == "latest":
            import_id = latest_import_id(conn)
        if not import_id:
            return {"rows": [], "total": 0}

        where = ["import_id = ?"]
        params = [import_id]
        if search:
            where.append("(numero_os LIKE ? OR unidade LIKE ? OR fornecedor LIKE ? OR atendente_vinculado LIKE ? OR responsavel_abertura LIKE ? OR responsavel_confirmacao LIKE ? OR tipo_residuo LIKE ?)")
            needle = f"%{search}%"
            params.extend([needle] * 7)
        if status:
            where.append("status_gerencial = ?")
            params.append(status)
        if action:
            where.append("precisa_acao = ?")
            params.append(action)

        where_sql = " AND ".join(where)
        total = conn.execute(f"SELECT COUNT(*) AS c FROM orders WHERE {where_sql}", params).fetchone()["c"]
        rows = conn.execute(
            f"""
            SELECT id, numero_os, unidade, regional, fornecedor, tipo_residuo, mtr,
                   status_original, status_operacional, status_confirmacao, status_gerencial,
                   origem_os, processo_origem, responsavel_abertura, origem_confirmacao,
                   responsavel_confirmacao, produtividade_manual,
                   data_abertura, data_agendada, data_realizacao, data_realizada,
                   data_nao_realizada, motivo_nao_realizacao, usuario_responsavel,
                   atendente_vinculado, prazo, situacao_gerencial, precisa_acao,
                   observacoes, inconsistencias, import_id
            FROM orders
            WHERE {where_sql}
            ORDER BY precisa_acao DESC, data_abertura DESC, numero_os DESC
            LIMIT ?
            """,
            params + [limit],
        ).fetchall()
        return {"rows": rows_to_dicts(rows), "total": total, "import_id": import_id}


def get_order(order_id: str) -> dict:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
        if not row:
            return {}
        item = dict(row)
        item["raw"] = json.loads(item.pop("raw_json"))
        return item


def export_orders_csv(query: dict) -> bytes:
    result = list_orders({**query, "limit": ["1000"]})
    output = io.StringIO()
    if not result["rows"]:
        return b""
    writer = csv.DictWriter(output, fieldnames=list(result["rows"][0].keys()), delimiter=";")
    writer.writeheader()
    writer.writerows(result["rows"])
    return output.getvalue().encode("utf-8-sig")


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, message, status=HTTPStatus.BAD_REQUEST):
        self.send_json({"error": message}, status)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        query = parse_qs(parsed.query)
        try:
            if path == "/":
                self.path = "/static/index.html"
                return super().do_GET()
            if path == "/api/imports":
                return self.send_json({"imports": list_imports()})
            if path == "/api/dashboard":
                return self.send_json(dashboard(
                    query.get("import_id", ["latest"])[0],
                    query.get("date_from", [""])[0],
                    query.get("date_to", [""])[0],
                ))
            if path == "/api/orders":
                return self.send_json(list_orders(query))
            if path.startswith("/api/orders/"):
                order = get_order(path.rsplit("/", 1)[-1])
                if not order:
                    return self.send_error_json("OS não encontrada", HTTPStatus.NOT_FOUND)
                return self.send_json(order)
            if path == "/api/export/orders.csv":
                data = export_orders_csv(query)
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "text/csv; charset=utf-8")
                self.send_header("Content-Disposition", "attachment; filename=base-os-sigra.csv")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            return super().do_GET()
        except Exception as exc:
            self.send_error_json(str(exc), HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/import":
            return self.send_error_json("Rota não encontrada", HTTPStatus.NOT_FOUND)

        try:
            content_type = self.headers.get("Content-Type", "")
            if "multipart/form-data" not in content_type:
                return self.send_error_json("Envie um arquivo Excel pelo campo file.")

            import cgi

            form = cgi.FieldStorage(fp=self.rfile, headers=self.headers, environ={"REQUEST_METHOD": "POST"})
            field = form["file"] if "file" in form else None
            if field is None or not getattr(field, "filename", ""):
                return self.send_error_json("Nenhum arquivo recebido.")

            safe_name = re.sub(r"[^A-Za-z0-9_. -]", "_", Path(field.filename).name)
            if not safe_name.lower().endswith((".xlsx", ".xls")):
                return self.send_error_json("O arquivo precisa ser Excel (.xlsx ou .xls).")

            target = UPLOAD_DIR / f"{datetime.now().strftime('%Y%m%d%H%M%S')}-{safe_name}"
            with target.open("wb") as f:
                shutil.copyfileobj(field.file, f)

            summary = import_excel(target, safe_name)
            self.send_json({"ok": True, "import": summary})
        except Exception as exc:
            self.send_error_json(str(exc), HTTPStatus.BAD_REQUEST)


def main():
    init_db()
    os.chdir(ROOT)
    port = int(os.environ.get("PORT", "8765"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"SIGRA Atendimento Dashboard rodando em http://127.0.0.1:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
