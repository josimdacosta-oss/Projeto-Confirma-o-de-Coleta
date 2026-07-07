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
DASHBOARD_CACHE: dict[tuple[str, str, str], dict] = {}

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

CUSTOMER_FIELD_ALIASES = {
    "grupo_contratual": ["Grupo Contratual", "Grupo contratual", "Grupo", "Contrato"],
    "codigo_cliente": ["Código Cliente", "Codigo Cliente", "Código", "Codigo"],
    "cnpj": ["CPF/CNPJ", "CNPJ", "CPF CNPJ", "Documento"],
    "cliente": ["Nome/Razão Social", "Nome Razão Social", "Razão Social", "Cliente"],
    "unidade": ["Nome Resumido", "Nome Fantasia", "Unidade", "Cliente"],
    "status_unidade": ["Status", "Status da unidade"],
    "cidade": ["Munícipio", "Município", "Cidade"],
    "estado": ["UF", "Estado"],
    "carteira": ["Carteira", "Segmento", "Operação"],
    "responsavel": ["Responsável", "Responsavel", "Analista", "Atendente"],
}

PORTFOLIO_FIELD_ALIASES = {
    "razao_social": ["RAZÃO SOCIAL:", "RAZÃO SOCIAL", "Razão Social", "Razao Social", "Cliente"],
    "grupo_contratual": ["Grupo Contratual", "Grupo contratual", "Grupo", "Contrato"],
    "unidade": ["Unidade", "Nome Fantasia", "Nome Resumido"],
    "sigla_unidade": ["Sigla", "Sigla Unidade", "Código Unidade", "Codigo Unidade"],
    "cs": ["CS", "Customer Success"],
    "atendimento": ["ATENDIMENTO", "Atendimento", "Atendente"],
    "assistente_atendimento": ["ASS DE ATENDIMENTO", "Ass de Atendimento", "Assistente de Atendimento", "Assistente"],
    "analista": ["Analista"],
    "responsavel_confirmacao_unidade": ["Responsável Confirmação", "Responsavel Confirmacao", "Responsável pela Confirmação", "Responsável pela confirmação da unidade"],
    "cobertura": ["Cobertura", "COBERTURA", "Coleta", "COLETA"],
    "categoria": ["Categoria", "CATEGORIA"],
    "complexidade": ["Complexidade", "COMPLEXIDADE"],
}


def blank(value) -> bool:
    if value is None:
        return True
    if pd.isna(value):
        return True
    return str(value).strip() in {"", " ", "nan", "NaT", "None"}


def text(value) -> str:
    return "" if blank(value) else str(value).strip()


def clear_dashboard_cache() -> None:
    DASHBOARD_CACHE.clear()


def same_person(left: str, right: str) -> bool:
    left_key = normalize_key(left)
    right_key = normalize_key(right)
    if not left_key or not right_key:
        return False
    if left_key == right_key:
        return True
    left_parts = set(left_key.split())
    right_parts = set(right_key.split())
    if left_parts & right_parts:
        return True
    return left_key in right_key or right_key in left_key


def confirmation_execution_fields(responsavel_sigra: str, origem_confirmacao: str, produtividade_manual: str, responsavel_carteira: str) -> dict:
    origem_key = normalize_key(origem_confirmacao)
    user_key = normalize_key(responsavel_sigra)
    is_mtr = "FORNECEDOR VIA MTR" in origem_key or user_key == "CONFIRMACAO COLETA"
    if is_mtr:
        return {
            "tipo_confirmacao": "Fornecedor via MTR",
            "feita_pelo_responsavel": "Não",
            "feita_por_outro_atendente": "Não",
        }
    if text(produtividade_manual) == "Sim" and text(responsavel_sigra):
        if not text(responsavel_carteira):
            return {
                "tipo_confirmacao": "Atendente sem carteira identificada",
                "feita_pelo_responsavel": "Não",
                "feita_por_outro_atendente": "Não",
            }
        if same_person(responsavel_sigra, responsavel_carteira):
            return {
                "tipo_confirmacao": "Atendente responsável pela carteira",
                "feita_pelo_responsavel": "Sim",
                "feita_por_outro_atendente": "Não",
            }
        return {
            "tipo_confirmacao": "Outro atendente / apoio",
            "feita_pelo_responsavel": "Não",
            "feita_por_outro_atendente": "Sim",
        }
    if user_key and ("ROBO" in user_key or "SISTEMA" in user_key):
        return {
            "tipo_confirmacao": "Sistema/Robô",
            "feita_pelo_responsavel": "Não",
            "feita_por_outro_atendente": "Não",
        }
    return {
        "tipo_confirmacao": "Sem confirmação",
        "feita_pelo_responsavel": "Não",
        "feita_por_outro_atendente": "Não",
    }


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


def normalize_key(value: str) -> str:
    normalized = normalized_blob(value)
    normalized = re.sub(r"[^A-Z0-9]+", " ", normalized)
    return re.sub(r"\s+", " ", normalized).strip()


def only_digits(value: str) -> str:
    return re.sub(r"\D+", "", text(value))


def extract_unit_code(value: str) -> str:
    normalized = normalize_key(value)
    if not normalized:
        return ""
    matches = re.findall(r"\b(?:PR|SC|SP|RJ|SSP|XSP|RC|SRJ|SPI|SPC)[A-Z0-9]*\d{1,3}\b", normalized)
    if matches:
        return matches[-1]
    tokens = normalized.split()
    return tokens[-1] if tokens else ""


def split_group_contract(value: str) -> tuple[str, str]:
    raw = text(value)
    if not raw:
        return "", ""
    match = re.match(r"^\s*(\d+)\s*[-–]\s*(.+)$", raw)
    if match:
        return match.group(1).strip(), match.group(2).strip()
    return "", raw


def pick_column(columns: list[str], aliases: list[str]) -> str:
    normalized = {normalize_key(column): column for column in columns}
    for alias in aliases:
        found = normalized.get(normalize_key(alias))
        if found:
            return found
    return ""


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

            CREATE TABLE IF NOT EXISTS customers_registry_imports (
                id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                imported_at TEXT NOT NULL,
                rows_count INTEGER NOT NULL,
                status TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1,
                notes TEXT,
                mapped_fields_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS customer_units (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                import_id TEXT NOT NULL,
                cliente TEXT,
                unidade TEXT,
                unidade_normalizada TEXT,
                sigla_unidade TEXT,
                grupo_contratual TEXT,
                grupo_contratual_codigo TEXT,
                grupo_contratual_nome TEXT,
                regional TEXT,
                carteira TEXT,
                responsavel TEXT,
                status_unidade TEXT,
                cnpj TEXT,
                cidade TEXT,
                estado TEXT,
                raw_json TEXT NOT NULL,
                FOREIGN KEY(import_id) REFERENCES customers_registry_imports(id)
            );

            CREATE TABLE IF NOT EXISTS service_portfolio_imports (
                id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                imported_at TEXT NOT NULL,
                rows_count INTEGER NOT NULL,
                status TEXT NOT NULL,
                notes TEXT,
                mapped_fields_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS service_portfolios (
                id TEXT PRIMARY KEY,
                import_id TEXT,
                link_type TEXT NOT NULL,
                razao_social TEXT,
                razao_social_normalizada TEXT,
                cliente TEXT,
                grupo_contratual TEXT,
                unidade TEXT,
                sigla_unidade TEXT,
                cs TEXT,
                atendimento TEXT,
                assistente_atendimento TEXT,
                analista TEXT,
                categoria TEXT,
                complexidade TEXT,
                status TEXT NOT NULL,
                start_date TEXT,
                end_date TEXT,
                source TEXT NOT NULL,
                notes TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                raw_json TEXT,
                FOREIGN KEY(import_id) REFERENCES service_portfolio_imports(id)
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
            "grupo_contratual",
            "grupo_contratual_codigo",
            "grupo_contratual_nome",
            "regional_cadastral",
            "carteira",
            "responsavel_cadastral",
            "status_unidade",
            "unidade_normalizada",
            "sigla_unidade",
            "cadastro_cliente",
            "cadastro_match",
            "cadastro_alerta",
            "carteira_cs",
            "carteira_atendimento",
            "carteira_assistente",
            "carteira_analista",
            "carteira_responsavel_confirmacao",
            "carteira_cobertura",
            "carteira_link_type",
            "carteira_identificada",
            "carteira_alerta",
            "tipo_confirmacao",
            "confirmacao_pelo_responsavel_carteira",
            "confirmacao_por_outro_atendente",
        ]:
            if name not in existing:
                conn.execute(f"ALTER TABLE orders ADD COLUMN {name} TEXT")
        portfolio_existing = {row["name"] for row in conn.execute("PRAGMA table_info(service_portfolios)").fetchall()}
        for name in ["responsavel_confirmacao_unidade", "cobertura"]:
            if name not in portfolio_existing:
                conn.execute(f"ALTER TABLE service_portfolios ADD COLUMN {name} TEXT")
        conn.executescript(
            """
            CREATE INDEX IF NOT EXISTS idx_orders_import ON orders(import_id);
            CREATE INDEX IF NOT EXISTS idx_orders_import_agendada ON orders(import_id, data_agendada);
            CREATE INDEX IF NOT EXISTS idx_orders_import_unidade ON orders(import_id, unidade);
            CREATE INDEX IF NOT EXISTS idx_orders_import_fornecedor ON orders(import_id, fornecedor);
            CREATE INDEX IF NOT EXISTS idx_orders_import_status_gerencial ON orders(import_id, status_gerencial);
            CREATE INDEX IF NOT EXISTS idx_orders_import_precisa_acao ON orders(import_id, precisa_acao);
            CREATE INDEX IF NOT EXISTS idx_orders_import_cadastro_match ON orders(import_id, cadastro_match);
            CREATE INDEX IF NOT EXISTS idx_orders_cadastro_match ON orders(cadastro_match);
            CREATE INDEX IF NOT EXISTS idx_orders_import_grupo ON orders(import_id, grupo_contratual);
            CREATE INDEX IF NOT EXISTS idx_orders_import_regional_cadastral ON orders(import_id, regional_cadastral);
            CREATE INDEX IF NOT EXISTS idx_orders_import_carteira ON orders(import_id, carteira);
            CREATE INDEX IF NOT EXISTS idx_orders_import_status_unidade ON orders(import_id, status_unidade);
            CREATE INDEX IF NOT EXISTS idx_customer_units_import_sigla ON customer_units(import_id, sigla_unidade);
            CREATE INDEX IF NOT EXISTS idx_customer_units_import_unidade ON customer_units(import_id, unidade_normalizada);
            CREATE INDEX IF NOT EXISTS idx_customer_imports_active ON customers_registry_imports(active, imported_at);
            CREATE INDEX IF NOT EXISTS idx_service_portfolios_status_type ON service_portfolios(status, link_type);
            CREATE INDEX IF NOT EXISTS idx_service_portfolios_cliente ON service_portfolios(status, razao_social_normalizada);
            CREATE INDEX IF NOT EXISTS idx_service_portfolios_grupo ON service_portfolios(status, grupo_contratual);
            CREATE INDEX IF NOT EXISTS idx_service_portfolios_unidade ON service_portfolios(status, sigla_unidade, unidade);
            CREATE INDEX IF NOT EXISTS idx_orders_import_carteira_atendimento ON orders(import_id, carteira_atendimento);
            CREATE INDEX IF NOT EXISTS idx_orders_import_tipo_confirmacao ON orders(import_id, tipo_confirmacao);
            CREATE INDEX IF NOT EXISTS idx_orders_import_carteira_responsavel ON orders(import_id, carteira_responsavel_confirmacao);
            """
        )


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


def find_customer_header_row(path: Path, sheet_name: str) -> int:
    raw = pd.read_excel(path, sheet_name=sheet_name, header=None, nrows=30, dtype=str)
    for index, row in raw.iterrows():
        values = [normalize_key(value) for value in row.tolist()]
        if "GRUPO CONTRATUAL" in values and ("CPF CNPJ" in values or "CODIGO CLIENTE" in values):
            return int(index)
    return find_header_row(path, sheet_name)


def read_customer_excel(path: Path) -> pd.DataFrame:
    excel = pd.ExcelFile(path)
    sheet = excel.sheet_names[0]
    header_row = find_customer_header_row(path, sheet)
    df = pd.read_excel(path, sheet_name=sheet, header=header_row, dtype=str).dropna(how="all").fillna("")
    df.columns = [str(c).strip() for c in df.columns]
    return df


def customer_column_map(columns: list[str]) -> dict[str, str]:
    return {field: pick_column(columns, aliases) for field, aliases in CUSTOMER_FIELD_ALIASES.items()}


def find_portfolio_header_row(path: Path, sheet_name: str) -> int:
    raw = pd.read_excel(path, sheet_name=sheet_name, header=None, nrows=30, dtype=str)
    for index, row in raw.iterrows():
        values = [normalize_key(value) for value in row.tolist()]
        if any(value in {"RAZAO SOCIAL", "RAZAO SOCIAL CLIENTE", "CLIENTE"} for value in values) and "ATENDIMENTO" in values:
            return int(index)
    return find_header_row(path, sheet_name)


def read_portfolio_excel(path: Path) -> pd.DataFrame:
    excel = pd.ExcelFile(path)
    sheet = "Proposta" if "Proposta" in excel.sheet_names else excel.sheet_names[0]
    header_row = find_portfolio_header_row(path, sheet)
    df = pd.read_excel(path, sheet_name=sheet, header=header_row, dtype=str).dropna(how="all").fillna("")
    df.columns = [str(c).strip() for c in df.columns]
    return df


def portfolio_column_map(columns: list[str]) -> dict[str, str]:
    return {field: pick_column(columns, aliases) for field, aliases in PORTFOLIO_FIELD_ALIASES.items()}


def active_customer_import_id(conn) -> str:
    row = conn.execute(
        "SELECT id FROM customers_registry_imports WHERE active = 1 ORDER BY imported_at DESC LIMIT 1"
    ).fetchone()
    return row["id"] if row else ""


def build_customer_match_index(units: list[dict]) -> dict:
    exact: dict[str, dict] = {}
    sigla: dict[str, list[dict]] = {}
    for unit in units:
        unit["_cliente_key"] = normalize_key(unit.get("cliente"))
        unit["_grupo_key"] = normalize_key(unit.get("grupo_contratual_nome"))
        unit_key = text(unit.get("unidade_normalizada"))
        unit_sigla = text(unit.get("sigla_unidade"))
        if unit_key and unit_key not in exact:
            exact[unit_key] = unit
        if unit_sigla:
            sigla.setdefault(unit_sigla, []).append(unit)
    return {"exact": exact, "sigla": sigla}


def match_customer_unit(order: dict, units: list[dict], index: dict | None = None) -> dict | None:
    if not units:
        return None
    order_unit = text(order.get("unidade"))
    order_client = text(order.get("cliente"))
    order_unit_key = normalize_key(order_unit)
    order_client_key = normalize_key(order_client)
    order_sigla = extract_unit_code(order_unit)
    index = index or build_customer_match_index(units)

    def client_bonus(unit: dict) -> int:
        client_key = unit.get("_cliente_key") or normalize_key(unit.get("cliente"))
        group_name_key = unit.get("_grupo_key") or normalize_key(unit.get("grupo_contratual_nome"))
        if order_client_key and (order_client_key == client_key or order_client_key == group_name_key):
            return 2
        if order_client_key and (order_client_key in client_key or order_client_key in group_name_key):
            return 1
        return 0

    candidates: list[tuple[int, dict]] = []
    exact_match = index["exact"].get(order_unit_key)
    if exact_match:
        candidates.append((100 + client_bonus(exact_match), exact_match))
    for unit in index["sigla"].get(order_sigla, []):
        candidates.append((80 + client_bonus(unit), unit))
    if candidates:
        candidates.sort(key=lambda item: item[0], reverse=True)
        return candidates[0][1]

    # Fallback limitado para nomes divergentes; evita travar importações grandes.
    for unit in units[:2500]:
        unit_key = text(unit.get("unidade_normalizada"))
        score = 0
        if order_unit_key and unit_key and (order_unit_key in unit_key or unit_key in order_unit_key):
            score = 60
        if score:
            candidates.append((score + client_bonus(unit), unit))
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def enrich_orders_with_customer_base(conn, import_id: str | None = None) -> dict:
    active_import = active_customer_import_id(conn)
    if not active_import:
        return {"matched": 0, "unmatched": 0, "unmatched_units": []}
    units = rows_to_dicts(conn.execute(
        "SELECT * FROM customer_units WHERE import_id = ?",
        (active_import,),
    ).fetchall())
    match_index = build_customer_match_index(units)
    where = ""
    params: list = []
    if import_id:
        where = "WHERE import_id = ?"
        params.append(import_id)
    orders = rows_to_dicts(conn.execute(
        f"SELECT id, cliente, unidade FROM orders {where}",
        params,
    ).fetchall())
    matched = 0
    unmatched_units: set[str] = set()
    for order in orders:
        unit = match_customer_unit(order, units, match_index)
        if unit:
            matched += 1
            conn.execute(
                """
                UPDATE orders
                SET grupo_contratual = ?,
                    grupo_contratual_codigo = ?,
                    grupo_contratual_nome = ?,
                    regional_cadastral = ?,
                    carteira = ?,
                    responsavel_cadastral = ?,
                    status_unidade = ?,
                    unidade_normalizada = ?,
                    sigla_unidade = ?,
                    cadastro_cliente = ?,
                    cadastro_match = 'Sim',
                    cadastro_alerta = ''
                WHERE id = ?
                """,
                (
                    unit.get("grupo_contratual"),
                    unit.get("grupo_contratual_codigo"),
                    unit.get("grupo_contratual_nome"),
                    unit.get("regional"),
                    unit.get("carteira"),
                    unit.get("responsavel"),
                    unit.get("status_unidade"),
                    unit.get("unidade_normalizada"),
                    unit.get("sigla_unidade"),
                    unit.get("cliente"),
                    order["id"],
                ),
            )
        else:
            unmatched_units.add(order.get("unidade") or "Não informado")
            conn.execute(
                """
                UPDATE orders
                SET grupo_contratual = '',
                    grupo_contratual_codigo = '',
                    grupo_contratual_nome = '',
                    regional_cadastral = '',
                    carteira = '',
                    responsavel_cadastral = '',
                    status_unidade = '',
                    unidade_normalizada = ?,
                    sigla_unidade = ?,
                    cadastro_cliente = '',
                    cadastro_match = 'Não',
                    cadastro_alerta = 'Unidade sem cadastro correspondente'
                WHERE id = ?
                """,
                (normalize_key(order.get("unidade")), extract_unit_code(order.get("unidade")), order["id"]),
            )
    return {
        "matched": matched,
        "unmatched": len(orders) - matched,
        "unmatched_units": sorted(unmatched_units),
    }


def enrich_orders_with_customer_base(conn, import_id: str | None = None) -> dict:
    active_import = active_customer_import_id(conn)
    if not active_import:
        return {"matched": 0, "unmatched": 0, "unmatched_units": []}
    units = rows_to_dicts(conn.execute(
        "SELECT * FROM customer_units WHERE import_id = ?",
        (active_import,),
    ).fetchall())
    match_index = build_customer_match_index(units)
    where = ""
    params: list = []
    if import_id:
        where = "WHERE import_id = ?"
        params.append(import_id)
    orders = rows_to_dicts(conn.execute(
        f"SELECT id, cliente, unidade FROM orders {where}",
        params,
    ).fetchall())

    matched = 0
    unmatched_units: set[str] = set()
    matched_updates = []
    unmatched_updates = []

    for order in orders:
        unit = match_customer_unit(order, units, match_index)
        if unit:
            matched += 1
            matched_updates.append((
                unit.get("grupo_contratual"),
                unit.get("grupo_contratual_codigo"),
                unit.get("grupo_contratual_nome"),
                unit.get("regional"),
                unit.get("carteira"),
                unit.get("responsavel"),
                unit.get("status_unidade"),
                unit.get("unidade_normalizada"),
                unit.get("sigla_unidade"),
                unit.get("cliente"),
                order["id"],
            ))
        else:
            unmatched_units.add(order.get("unidade") or "Não informado")
            unmatched_updates.append((
                normalize_key(order.get("unidade")),
                extract_unit_code(order.get("unidade")),
                order["id"],
            ))

    if matched_updates:
        conn.executemany(
            """
            UPDATE orders
            SET grupo_contratual = ?,
                grupo_contratual_codigo = ?,
                grupo_contratual_nome = ?,
                regional_cadastral = ?,
                carteira = ?,
                responsavel_cadastral = ?,
                status_unidade = ?,
                unidade_normalizada = ?,
                sigla_unidade = ?,
                cadastro_cliente = ?,
                cadastro_match = 'Sim',
                cadastro_alerta = ''
            WHERE id = ?
            """,
            matched_updates,
        )
    if unmatched_updates:
        conn.executemany(
            """
            UPDATE orders
            SET grupo_contratual = '',
                grupo_contratual_codigo = '',
                grupo_contratual_nome = '',
                regional_cadastral = '',
                carteira = '',
                responsavel_cadastral = '',
                status_unidade = '',
                unidade_normalizada = ?,
                sigla_unidade = ?,
                cadastro_cliente = '',
                cadastro_match = 'Não',
                cadastro_alerta = 'Unidade sem cadastro correspondente'
            WHERE id = ?
            """,
            unmatched_updates,
        )
    return {
        "matched": matched,
        "unmatched": len(orders) - matched,
        "unmatched_units": sorted(unmatched_units),
    }


def import_customer_base(path: Path, original_name: str) -> dict:
    df = read_customer_excel(path)
    mapped = customer_column_map(list(df.columns))
    imported_at = datetime.now().isoformat(timespec="seconds")
    import_id = datetime.now().strftime("%Y%m%d%H%M%S") + "-clientes-" + uuid.uuid4().hex[:6]
    units: list[dict] = []
    for _, row in df.iterrows():
        row_dict = row.to_dict()
        grupo_raw = text(row_dict.get(mapped.get("grupo_contratual", "")))
        grupo_codigo, grupo_nome = split_group_contract(grupo_raw)
        unidade = text(row_dict.get(mapped.get("unidade", ""))) or text(row_dict.get(mapped.get("cliente", "")))
        estado = text(row_dict.get(mapped.get("estado", ""))).upper()
        item = {
            "import_id": import_id,
            "cliente": text(row_dict.get(mapped.get("cliente", ""))),
            "unidade": unidade,
            "unidade_normalizada": normalize_key(unidade),
            "sigla_unidade": extract_unit_code(unidade),
            "grupo_contratual": grupo_raw,
            "grupo_contratual_codigo": grupo_codigo,
            "grupo_contratual_nome": grupo_nome,
            "regional": regional_from_uf(estado),
            "carteira": text(row_dict.get(mapped.get("carteira", ""))),
            "responsavel": text(row_dict.get(mapped.get("responsavel", ""))),
            "status_unidade": text(row_dict.get(mapped.get("status_unidade", ""))),
            "cnpj": only_digits(row_dict.get(mapped.get("cnpj", ""))),
            "cidade": text(row_dict.get(mapped.get("cidade", ""))),
            "estado": estado,
            "raw_json": json.dumps({str(k): text(v) for k, v in row_dict.items()}, ensure_ascii=False),
        }
        if item["cliente"] or item["unidade"] or item["grupo_contratual"]:
            units.append(item)

    with get_conn() as conn:
        conn.execute("UPDATE customers_registry_imports SET active = 0")
        conn.execute(
            """
            INSERT INTO customers_registry_imports (
                id, filename, imported_at, rows_count, status, active, notes, mapped_fields_json
            ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
            """,
            (
                import_id,
                original_name,
                imported_at,
                len(units),
                "Ativa",
                "Base de Clientes / Grupos Contratuais",
                json.dumps(mapped, ensure_ascii=False),
            ),
        )
        if units:
            columns = list(units[0].keys())
            placeholders = ", ".join(["?"] * len(columns))
            conn.executemany(
                f"INSERT INTO customer_units ({', '.join(columns)}) VALUES ({placeholders})",
                [[row.get(column, "") for column in columns] for row in units],
            )
        enrichment = enrich_orders_with_customer_base(conn)
    clear_dashboard_cache()
    return customer_base_summary(extra={"last_enrichment": enrichment})


def active_portfolio_links(conn) -> list[dict]:
    return rows_to_dicts(conn.execute(
        """
        SELECT *
        FROM service_portfolios
        WHERE status = 'Ativo'
          AND (start_date = '' OR start_date IS NULL OR date(start_date) <= date('now'))
          AND (end_date = '' OR end_date IS NULL OR date(end_date) >= date('now'))
        ORDER BY
          CASE link_type WHEN 'unidade' THEN 1 WHEN 'grupo_contratual' THEN 2 ELSE 3 END,
          updated_at DESC
        """
    ).fetchall())


def build_portfolio_match_index(links: list[dict]) -> dict:
    by_unit: dict[str, dict] = {}
    by_group: dict[str, dict] = {}
    by_client: dict[str, dict] = {}
    for link in links:
        link_type = text(link.get("link_type")).lower()
        if link_type == "unidade":
            for key in [text(link.get("sigla_unidade")), normalize_key(link.get("unidade"))]:
                if key and key not in by_unit:
                    by_unit[key] = link
        elif link_type == "grupo_contratual":
            key = text(link.get("grupo_contratual"))
            if key and key not in by_group:
                by_group[key] = link
        else:
            for key in [text(link.get("razao_social_normalizada")), normalize_key(link.get("cliente")), normalize_key(link.get("razao_social"))]:
                if key and key not in by_client:
                    by_client[key] = link
    return {"unit": by_unit, "group": by_group, "client": by_client}


def match_portfolio_link(order: dict, index: dict) -> dict | None:
    for key in [text(order.get("sigla_unidade")), normalize_key(order.get("unidade_normalizada")), normalize_key(order.get("unidade"))]:
        if key and key in index["unit"]:
            return index["unit"][key]
    group = text(order.get("grupo_contratual"))
    if group and group in index["group"]:
        return index["group"][group]
    for key in [
        normalize_key(order.get("cadastro_cliente")),
        normalize_key(order.get("cliente")),
        normalize_key(order.get("grupo_contratual_nome")),
    ]:
        if key and key in index["client"]:
            return index["client"][key]
    return None


def enrich_orders_with_service_portfolios(conn, import_id: str | None = None) -> dict:
    links = active_portfolio_links(conn)
    if not links:
        return {"matched": 0, "unmatched": 0, "unmatched_units": []}
    index = build_portfolio_match_index(links)
    where = ""
    params: list = []
    if import_id:
        where = "WHERE import_id = ?"
        params.append(import_id)
    orders = rows_to_dicts(conn.execute(
        f"""
        SELECT id, cliente, unidade, unidade_normalizada, sigla_unidade,
               grupo_contratual, grupo_contratual_nome, cadastro_cliente,
               origem_confirmacao, responsavel_confirmacao, produtividade_manual
        FROM orders {where}
        """,
        params,
    ).fetchall())
    matched = 0
    unmatched_units: set[str] = set()
    matched_updates = []
    unmatched_updates = []
    for order in orders:
        link = match_portfolio_link(order, index)
        if link:
            matched += 1
            matched_updates.append((
                link.get("cs"),
                link.get("atendimento"),
                link.get("assistente_atendimento"),
                link.get("analista"),
                link.get("link_type"),
                order["id"],
            ))
        else:
            unmatched_units.add(order.get("unidade") or "Não informado")
            unmatched_updates.append((order["id"],))
    if matched_updates:
        conn.executemany(
            """
            UPDATE orders
            SET carteira_cs = ?,
                carteira_atendimento = ?,
                carteira_assistente = ?,
                carteira_analista = ?,
                carteira_link_type = ?,
                carteira_identificada = 'Sim',
                carteira_alerta = ''
            WHERE id = ?
            """,
            matched_updates,
        )
    if unmatched_updates:
        conn.executemany(
            """
            UPDATE orders
            SET carteira_cs = '',
                carteira_atendimento = '',
                carteira_assistente = '',
                carteira_analista = '',
                carteira_link_type = '',
                carteira_identificada = 'Não',
                carteira_alerta = 'Carteira não identificada'
            WHERE id = ?
            """,
            unmatched_updates,
        )
    return {"matched": matched, "unmatched": len(orders) - matched, "unmatched_units": sorted(unmatched_units)}


def enrich_orders_with_service_portfolios(conn, import_id: str | None = None) -> dict:
    links = active_portfolio_links(conn)
    if not links:
        return {"matched": 0, "unmatched": 0, "unmatched_units": []}
    target_sql = "import_id = ?" if import_id else "1 = 1"
    target_params = [import_id] if import_id else []
    conn.execute(
        f"""
        UPDATE orders
        SET carteira_cs = '',
            carteira_atendimento = '',
            carteira_assistente = '',
            carteira_analista = '',
            carteira_link_type = '',
            carteira_identificada = 'Não',
            carteira_alerta = 'Carteira não identificada'
        WHERE {target_sql}
        """,
        target_params,
    )
    priority = {"cliente": 1, "grupo_contratual": 2, "unidade": 3}
    for link in sorted(links, key=lambda item: priority.get(text(item.get("link_type")).lower(), 1)):
        link_type = text(link.get("link_type")).lower()
        params = [
            link.get("cs"),
            link.get("atendimento"),
            link.get("assistente_atendimento"),
            link.get("analista"),
            link_type,
        ]
        if link_type == "unidade":
            sigla = text(link.get("sigla_unidade"))
            unidade_key = normalize_key(link.get("unidade"))
            if not sigla and not unidade_key:
                continue
            condition = "(sigla_unidade = ? OR unidade_normalizada = ?)"
            params.extend([sigla, unidade_key])
        elif link_type == "grupo_contratual":
            group = text(link.get("grupo_contratual"))
            if not group:
                continue
            condition = "grupo_contratual = ?"
            params.append(group)
        else:
            razao = text(link.get("razao_social"))
            cliente = text(link.get("cliente")) or razao
            if not razao and not cliente:
                continue
            condition = """
                (
                    cadastro_cliente = ?
                    OR cliente = ?
                    OR grupo_contratual_nome = ?
                    OR cadastro_cliente LIKE ?
                    OR cliente LIKE ?
                    OR grupo_contratual_nome LIKE ?
                )
            """
            needle = f"%{razao or cliente}%"
            params.extend([razao, cliente, razao, needle, needle, needle])
        conn.execute(
            f"""
            UPDATE orders
            SET carteira_cs = ?,
                carteira_atendimento = ?,
                carteira_assistente = ?,
                carteira_analista = ?,
                carteira_link_type = ?,
                carteira_identificada = 'Sim',
                carteira_alerta = ''
            WHERE {target_sql} AND {condition}
            """,
            params[:5] + target_params + params[5:],
        )
    matched = conn.execute(f"SELECT COUNT(*) AS c FROM orders WHERE {target_sql} AND carteira_identificada = 'Sim'", target_params).fetchone()["c"]
    total = conn.execute(f"SELECT COUNT(*) AS c FROM orders WHERE {target_sql}", target_params).fetchone()["c"]
    unmatched_units = [
        row["unidade"] for row in conn.execute(
            f"""
            SELECT COALESCE(NULLIF(unidade, ''), 'Não informado') AS unidade, COUNT(*) AS total
            FROM orders
            WHERE {target_sql} AND COALESCE(carteira_identificada, '') <> 'Sim'
            GROUP BY unidade
            ORDER BY total DESC, unidade
            LIMIT 80
            """,
            target_params,
        ).fetchall()
    ]
    return {"matched": matched, "unmatched": total - matched, "unmatched_units": unmatched_units}


def enrich_orders_with_service_portfolios(conn, import_id: str | None = None) -> dict:
    links = active_portfolio_links(conn)
    if not links:
        return {"matched": 0, "unmatched": 0, "unmatched_units": []}
    unit_links: dict[str, dict] = {}
    group_links: dict[str, dict] = {}
    client_links: list[dict] = []
    for link in links:
        link_type = text(link.get("link_type")).lower()
        if link_type == "unidade":
            for key in [text(link.get("sigla_unidade")), normalize_key(link.get("unidade"))]:
                if key and key not in unit_links:
                    unit_links[key] = link
        elif link_type == "grupo_contratual":
            key = text(link.get("grupo_contratual"))
            if key and key not in group_links:
                group_links[key] = link
        else:
            link["_keys"] = [key for key in [
                normalize_key(link.get("razao_social")),
                normalize_key(link.get("cliente")),
                normalize_key(link.get("razao_social_normalizada")),
            ] if key]
            if link["_keys"]:
                client_links.append(link)

    where = ""
    params: list = []
    if import_id:
        where = "WHERE import_id = ?"
        params.append(import_id)
    orders = rows_to_dicts(conn.execute(
        f"""
        SELECT id, cliente, unidade, unidade_normalizada, sigla_unidade,
               grupo_contratual, grupo_contratual_nome, cadastro_cliente,
               origem_confirmacao, responsavel_confirmacao, produtividade_manual
        FROM orders {where}
        """,
        params,
    ).fetchall())
    matched_updates = []
    unmatched_updates = []
    unmatched_units: set[str] = set()
    for order in orders:
        order_keys = [
            normalize_key(order.get("cadastro_cliente")),
            normalize_key(order.get("cliente")),
            normalize_key(order.get("grupo_contratual_nome")),
        ]
        link = None
        for key in [text(order.get("sigla_unidade")), normalize_key(order.get("unidade_normalizada")), normalize_key(order.get("unidade"))]:
            if key and key in unit_links:
                link = unit_links[key]
                break
        if not link:
            group_key = text(order.get("grupo_contratual"))
            link = group_links.get(group_key)
        if not link:
            for candidate in client_links:
                if any(ok and ck and (ok == ck or ck in ok or ok in ck) for ok in order_keys for ck in candidate["_keys"]):
                    link = candidate
                    break
        if link:
            responsavel_carteira = text(link.get("responsavel_confirmacao_unidade")) or text(link.get("atendimento"))
            execution = confirmation_execution_fields(
                order.get("responsavel_confirmacao"),
                order.get("origem_confirmacao"),
                order.get("produtividade_manual"),
                responsavel_carteira,
            )
            matched_updates.append((
                link.get("cs"),
                link.get("atendimento"),
                link.get("assistente_atendimento"),
                link.get("analista"),
                responsavel_carteira,
                link.get("cobertura"),
                link.get("link_type"),
                execution["tipo_confirmacao"],
                execution["feita_pelo_responsavel"],
                execution["feita_por_outro_atendente"],
                order["id"],
            ))
        else:
            execution = confirmation_execution_fields(
                order.get("responsavel_confirmacao"),
                order.get("origem_confirmacao"),
                order.get("produtividade_manual"),
                "",
            )
            unmatched_units.add(order.get("unidade") or "Não informado")
            unmatched_updates.append((
                execution["tipo_confirmacao"],
                execution["feita_pelo_responsavel"],
                execution["feita_por_outro_atendente"],
                order["id"],
            ))
    if matched_updates:
        conn.executemany(
            """
            UPDATE orders
            SET carteira_cs = ?,
                carteira_atendimento = ?,
                carteira_assistente = ?,
                carteira_analista = ?,
                carteira_responsavel_confirmacao = ?,
                carteira_cobertura = ?,
                carteira_link_type = ?,
                carteira_identificada = 'Sim',
                carteira_alerta = '',
                tipo_confirmacao = ?,
                confirmacao_pelo_responsavel_carteira = ?,
                confirmacao_por_outro_atendente = ?
            WHERE id = ?
            """,
            matched_updates,
        )
    if unmatched_updates:
        conn.executemany(
            """
            UPDATE orders
            SET carteira_cs = '',
                carteira_atendimento = '',
                carteira_assistente = '',
                carteira_analista = '',
                carteira_responsavel_confirmacao = '',
                carteira_cobertura = '',
                carteira_link_type = '',
                carteira_identificada = 'Não',
                carteira_alerta = 'Carteira n?o identificada',
                tipo_confirmacao = ?,
                confirmacao_pelo_responsavel_carteira = ?,
                confirmacao_por_outro_atendente = ?
            WHERE id = ?
            """,
            unmatched_updates,
        )
    return {"matched": len(matched_updates), "unmatched": len(unmatched_updates), "unmatched_units": sorted(unmatched_units)[:80]}


def import_service_portfolio(path: Path, original_name: str) -> dict:
    df = read_portfolio_excel(path)
    mapped = portfolio_column_map(list(df.columns))
    imported_at = datetime.now().isoformat(timespec="seconds")
    import_id = datetime.now().strftime("%Y%m%d%H%M%S") + "-carteiras-" + uuid.uuid4().hex[:6]
    links: list[dict] = []
    for _, row in df.iterrows():
        row_dict = row.to_dict()
        razao = text(row_dict.get(mapped.get("razao_social", "")))
        atendimento = text(row_dict.get(mapped.get("atendimento", "")))
        cs = text(row_dict.get(mapped.get("cs", "")))
        assistente = text(row_dict.get(mapped.get("assistente_atendimento", "")))
        if not razao or not (atendimento or cs or assistente):
            continue
        grupo = text(row_dict.get(mapped.get("grupo_contratual", "")))
        unidade = text(row_dict.get(mapped.get("unidade", "")))
        sigla = text(row_dict.get(mapped.get("sigla_unidade", ""))) or extract_unit_code(unidade)
        link_type = "unidade" if unidade or sigla else ("grupo_contratual" if grupo else "cliente")
        now = datetime.now().isoformat(timespec="seconds")
        links.append({
            "id": uuid.uuid4().hex,
            "import_id": import_id,
            "link_type": link_type,
            "razao_social": razao,
            "razao_social_normalizada": normalize_key(razao),
            "cliente": razao,
            "grupo_contratual": grupo,
            "unidade": unidade,
            "sigla_unidade": sigla,
            "cs": cs,
            "atendimento": atendimento,
            "assistente_atendimento": assistente,
            "analista": text(row_dict.get(mapped.get("analista", ""))),
            "responsavel_confirmacao_unidade": text(row_dict.get(mapped.get("responsavel_confirmacao_unidade", ""))) or atendimento,
            "cobertura": text(row_dict.get(mapped.get("cobertura", ""))),
            "categoria": text(row_dict.get(mapped.get("categoria", ""))),
            "complexidade": text(row_dict.get(mapped.get("complexidade", ""))),
            "status": "Ativo",
            "start_date": "",
            "end_date": "",
            "source": "importado",
            "notes": "",
            "created_at": now,
            "updated_at": now,
            "raw_json": json.dumps({str(k): text(v) for k, v in row_dict.items()}, ensure_ascii=False),
        })
    with get_conn() as conn:
        conn.execute("UPDATE service_portfolios SET status = 'Inativo', updated_at = ? WHERE source = 'importado'", (imported_at,))
        conn.execute(
            """
            INSERT INTO service_portfolio_imports (
                id, filename, imported_at, rows_count, status, notes, mapped_fields_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (import_id, original_name, imported_at, len(links), "Importado", "Carga inicial de carteiras", json.dumps(mapped, ensure_ascii=False)),
        )
        if links:
            columns = list(links[0].keys())
            placeholders = ", ".join(["?"] * len(columns))
            conn.executemany(
                f"INSERT INTO service_portfolios ({', '.join(columns)}) VALUES ({placeholders})",
                [[row.get(column, "") for column in columns] for row in links],
            )
        enrichment = enrich_orders_with_service_portfolios(conn)
    clear_dashboard_cache()
    return service_portfolio_summary(extra={"last_enrichment": enrichment})


def upsert_service_portfolio(payload: dict) -> dict:
    now = datetime.now().isoformat(timespec="seconds")
    link_id = text(payload.get("id")) or uuid.uuid4().hex
    link_type = text(payload.get("link_type")).lower() or "cliente"
    razao = text(payload.get("razao_social") or payload.get("cliente"))
    values = {
        "id": link_id,
        "import_id": "",
        "link_type": link_type,
        "razao_social": razao,
        "razao_social_normalizada": normalize_key(razao),
        "cliente": text(payload.get("cliente")) or razao,
        "grupo_contratual": text(payload.get("grupo_contratual")),
        "unidade": text(payload.get("unidade")),
        "sigla_unidade": text(payload.get("sigla_unidade")) or extract_unit_code(payload.get("unidade")),
        "cs": text(payload.get("cs")),
        "atendimento": text(payload.get("atendimento")),
        "assistente_atendimento": text(payload.get("assistente_atendimento")),
        "analista": text(payload.get("analista")),
        "responsavel_confirmacao_unidade": text(payload.get("responsavel_confirmacao_unidade")) or text(payload.get("atendimento")),
        "cobertura": text(payload.get("cobertura")),
        "categoria": text(payload.get("categoria")),
        "complexidade": text(payload.get("complexidade")),
        "status": text(payload.get("status")) or "Ativo",
        "start_date": text(payload.get("start_date")),
        "end_date": text(payload.get("end_date")),
        "source": "manual",
        "notes": text(payload.get("notes")),
        "updated_at": now,
    }
    with get_conn() as conn:
        exists = conn.execute("SELECT id FROM service_portfolios WHERE id = ?", (link_id,)).fetchone()
        if exists:
            conn.execute(
                """
                UPDATE service_portfolios
                SET link_type = ?, razao_social = ?, razao_social_normalizada = ?, cliente = ?,
                    grupo_contratual = ?, unidade = ?, sigla_unidade = ?, cs = ?, atendimento = ?,
                    assistente_atendimento = ?, analista = ?, responsavel_confirmacao_unidade = ?, cobertura = ?, categoria = ?, complexidade = ?,
                    status = ?, start_date = ?, end_date = ?, notes = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    values["link_type"], values["razao_social"], values["razao_social_normalizada"], values["cliente"],
                    values["grupo_contratual"], values["unidade"], values["sigla_unidade"], values["cs"], values["atendimento"],
                    values["assistente_atendimento"], values["analista"], values["responsavel_confirmacao_unidade"], values["cobertura"], values["categoria"], values["complexidade"],
                    values["status"], values["start_date"], values["end_date"], values["notes"], values["updated_at"], link_id,
                ),
            )
        else:
            conn.execute(
                """
                INSERT INTO service_portfolios (
                    id, import_id, link_type, razao_social, razao_social_normalizada, cliente,
                    grupo_contratual, unidade, sigla_unidade, cs, atendimento, assistente_atendimento,
                    analista, responsavel_confirmacao_unidade, cobertura, categoria, complexidade, status, start_date, end_date, source,
                    notes, created_at, updated_at, raw_json
                ) VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, '{}')
                """,
                (
                    link_id, values["link_type"], values["razao_social"], values["razao_social_normalizada"], values["cliente"],
                    values["grupo_contratual"], values["unidade"], values["sigla_unidade"], values["cs"], values["atendimento"],
                    values["assistente_atendimento"], values["analista"], values["responsavel_confirmacao_unidade"], values["cobertura"], values["categoria"], values["complexidade"],
                    values["status"], values["start_date"], values["end_date"], values["notes"], now, values["updated_at"],
                ),
            )
        enrichment = enrich_orders_with_service_portfolios(conn)
    clear_dashboard_cache()
    return service_portfolio_summary(extra={"last_enrichment": enrichment})


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
        enrich_orders_with_customer_base(conn, import_id)
        enrich_orders_with_service_portfolios(conn, import_id)

    clear_dashboard_cache()
    return import_summary(import_id)


def rows_to_dicts(rows) -> list[dict]:
    return [dict(row) for row in rows]


def latest_import_id(conn) -> str:
    row = conn.execute("SELECT id FROM imports ORDER BY imported_at DESC LIMIT 1").fetchone()
    return row["id"] if row else ""


def customer_base_summary(extra: dict | None = None) -> dict:
    with get_conn() as conn:
        active = conn.execute(
            "SELECT * FROM customers_registry_imports WHERE active = 1 ORDER BY imported_at DESC LIMIT 1"
        ).fetchone()
        imports = rows_to_dicts(conn.execute(
            "SELECT id, filename, imported_at, rows_count, status, active, notes FROM customers_registry_imports ORDER BY imported_at DESC"
        ).fetchall())
        if not active:
            return {
                "active": None,
                "imports": imports,
                "diagnostics": {
                    "rows_count": 0,
                    "clientes": 0,
                    "unidades": 0,
                    "grupos_contratuais": 0,
                    "os_com_match": 0,
                    "os_sem_match": 0,
                    "unidades_sem_match": [],
                    "campos_mapeados": {},
                },
            }
        active_dict = dict(active)
        import_id = active_dict["id"]
        diagnostics = {
            "rows_count": active_dict["rows_count"],
            "clientes": conn.execute(
                "SELECT COUNT(DISTINCT cliente) AS c FROM customer_units WHERE import_id = ? AND cliente <> ''",
                (import_id,),
            ).fetchone()["c"],
            "unidades": conn.execute(
                "SELECT COUNT(DISTINCT unidade_normalizada) AS c FROM customer_units WHERE import_id = ? AND unidade_normalizada <> ''",
                (import_id,),
            ).fetchone()["c"],
            "grupos_contratuais": conn.execute(
                "SELECT COUNT(DISTINCT grupo_contratual) AS c FROM customer_units WHERE import_id = ? AND grupo_contratual <> ''",
                (import_id,),
            ).fetchone()["c"],
            "os_com_match": conn.execute("SELECT COUNT(*) AS c FROM orders WHERE cadastro_match = 'Sim'").fetchone()["c"],
            "os_sem_match": conn.execute("SELECT COUNT(*) AS c FROM orders WHERE COALESCE(cadastro_match, '') <> 'Sim'").fetchone()["c"],
            "unidades_sem_match": [
                row["unidade"] for row in conn.execute(
                    """
                    SELECT COALESCE(NULLIF(unidade, ''), 'Não informado') AS unidade, COUNT(*) AS total
                    FROM orders
                    WHERE COALESCE(cadastro_match, '') <> 'Sim'
                    GROUP BY unidade
                    ORDER BY total DESC, unidade
                    LIMIT 80
                    """
                ).fetchall()
            ],
            "campos_mapeados": json.loads(active_dict.get("mapped_fields_json") or "{}"),
        }
        return {"active": active_dict, "imports": imports, "diagnostics": diagnostics, **(extra or {})}


def service_portfolio_summary(extra: dict | None = None) -> dict:
    with get_conn() as conn:
        imports = rows_to_dicts(conn.execute(
            "SELECT id, filename, imported_at, rows_count, status, notes FROM service_portfolio_imports ORDER BY imported_at DESC"
        ).fetchall())
        links = rows_to_dicts(conn.execute(
            """
            SELECT *
            FROM service_portfolios
            ORDER BY status, link_type, atendimento, razao_social
            LIMIT 500
            """
        ).fetchall())
        diagnostics = {
            "total_vinculos": conn.execute("SELECT COUNT(*) AS c FROM service_portfolios").fetchone()["c"],
            "vinculos_cliente": conn.execute("SELECT COUNT(*) AS c FROM service_portfolios WHERE link_type = 'cliente'").fetchone()["c"],
            "vinculos_grupo": conn.execute("SELECT COUNT(*) AS c FROM service_portfolios WHERE link_type = 'grupo_contratual'").fetchone()["c"],
            "vinculos_unidade": conn.execute("SELECT COUNT(*) AS c FROM service_portfolios WHERE link_type = 'unidade'").fetchone()["c"],
            "vinculos_ativos": conn.execute("SELECT COUNT(*) AS c FROM service_portfolios WHERE status = 'Ativo'").fetchone()["c"],
            "vinculos_inativos": conn.execute("SELECT COUNT(*) AS c FROM service_portfolios WHERE status <> 'Ativo'").fetchone()["c"],
            "os_com_carteira": conn.execute("SELECT COUNT(*) AS c FROM orders WHERE carteira_identificada = 'Sim'").fetchone()["c"],
            "os_sem_carteira": conn.execute("SELECT COUNT(*) AS c FROM orders WHERE COALESCE(carteira_identificada, '') <> 'Sim'").fetchone()["c"],
            "unidades_sem_carteira": [
                row["unidade"] for row in conn.execute(
                    """
                    SELECT COALESCE(NULLIF(unidade, ''), 'Não informado') AS unidade, COUNT(*) AS total
                    FROM orders
                    WHERE COALESCE(carteira_identificada, '') <> 'Sim'
                    GROUP BY unidade
                    ORDER BY total DESC, unidade
                    LIMIT 80
                    """
                ).fetchall()
            ],
            "duplicidades": conn.execute(
                """
                SELECT COUNT(*) AS c
                FROM (
                    SELECT link_type, COALESCE(NULLIF(sigla_unidade, ''), unidade, grupo_contratual, razao_social_normalizada) AS chave, COUNT(*) AS total
                    FROM service_portfolios
                    WHERE status = 'Ativo'
                    GROUP BY link_type, chave
                    HAVING total > 1
                )
                """
            ).fetchone()["c"],
        }
        return {"imports": imports, "links": links, "diagnostics": diagnostics, **(extra or {})}


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
        "cliente",
        "fornecedor",
        "unidade",
        "regional",
        "grupo_contratual",
        "grupo_contratual_codigo",
        "grupo_contratual_nome",
        "regional_cadastral",
        "carteira",
        "responsavel_cadastral",
        "status_unidade",
        "sigla_unidade",
        "cadastro_match",
        "carteira_cs",
        "carteira_atendimento",
        "carteira_assistente",
        "carteira_analista",
        "carteira_responsavel_confirmacao",
        "carteira_cobertura",
        "carteira_link_type",
        "carteira_identificada",
        "tipo_confirmacao",
        "confirmacao_pelo_responsavel_carteira",
        "confirmacao_por_outro_atendente",
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
            MAX(COALESCE(NULLIF(cliente, ''), '')) AS cliente,
            MAX(COALESCE(NULLIF(grupo_contratual, ''), '')) AS grupo_contratual,
            MAX(COALESCE(NULLIF(grupo_contratual_codigo, ''), '')) AS grupo_contratual_codigo,
            MAX(COALESCE(NULLIF(grupo_contratual_nome, ''), '')) AS grupo_contratual_nome,
            MAX(COALESCE(NULLIF(regional_cadastral, ''), '')) AS regional_cadastral,
            MAX(COALESCE(NULLIF(carteira, ''), '')) AS carteira,
            MAX(COALESCE(NULLIF(responsavel_cadastral, ''), '')) AS responsavel_cadastral,
            MAX(COALESCE(NULLIF(status_unidade, ''), '')) AS status_unidade,
            MAX(COALESCE(NULLIF(sigla_unidade, ''), '')) AS sigla_unidade,
            MAX(COALESCE(NULLIF(cadastro_match, ''), '')) AS cadastro_match,
            COUNT(*) AS total,
            SUM(CASE WHEN data_agendada <> '' THEN 1 ELSE 0 END) AS coletas_agendadas,
            SUM(CASE WHEN status_gerencial = 'Realizada e confirmada' THEN 1 ELSE 0 END) AS total_confirmadas,
            SUM(CASE WHEN produtividade_manual = 'Sim' THEN 1 ELSE 0 END) AS confirmacoes_manuais,
            SUM(CASE WHEN origem_confirmacao = 'Confirmada pelo fornecedor via MTR' THEN 1 ELSE 0 END) AS confirmacoes_mtr,
            SUM(CASE WHEN confirmacao_pelo_responsavel_carteira = 'Sim' THEN 1 ELSE 0 END) AS confirmacoes_responsavel_carteira,
            SUM(CASE WHEN confirmacao_por_outro_atendente = 'Sim' THEN 1 ELSE 0 END) AS confirmacoes_outros_atendentes,
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
            MAX(COALESCE(NULLIF(cliente, ''), '')) AS cliente,
            MAX(COALESCE(NULLIF(grupo_contratual, ''), '')) AS grupo_contratual,
            MAX(COALESCE(NULLIF(grupo_contratual_codigo, ''), '')) AS grupo_contratual_codigo,
            MAX(COALESCE(NULLIF(grupo_contratual_nome, ''), '')) AS grupo_contratual_nome,
            MAX(COALESCE(NULLIF(regional_cadastral, ''), '')) AS regional_cadastral,
            MAX(COALESCE(NULLIF(carteira, ''), '')) AS carteira,
            MAX(COALESCE(NULLIF(responsavel_cadastral, ''), '')) AS responsavel_cadastral,
            MAX(COALESCE(NULLIF(status_unidade, ''), '')) AS status_unidade,
            MAX(COALESCE(NULLIF(sigla_unidade, ''), '')) AS sigla_unidade,
            MAX(COALESCE(NULLIF(cadastro_match, ''), '')) AS cadastro_match,
            MAX(COALESCE(NULLIF(cadastro_alerta, ''), '')) AS cadastro_alerta,
            MAX(COALESCE(NULLIF(carteira_cs, ''), '')) AS carteira_cs,
            MAX(COALESCE(NULLIF(carteira_atendimento, ''), '')) AS carteira_atendimento,
            MAX(COALESCE(NULLIF(carteira_assistente, ''), '')) AS carteira_assistente,
            MAX(COALESCE(NULLIF(carteira_analista, ''), '')) AS carteira_analista,
            MAX(COALESCE(NULLIF(carteira_responsavel_confirmacao, ''), '')) AS carteira_responsavel_confirmacao,
            MAX(COALESCE(NULLIF(carteira_cobertura, ''), '')) AS carteira_cobertura,
            MAX(COALESCE(NULLIF(carteira_link_type, ''), '')) AS carteira_link_type,
            MAX(COALESCE(NULLIF(carteira_identificada, ''), '')) AS carteira_identificada,
            SUM(CASE WHEN data_agendada <> '' THEN 1 ELSE 0 END) AS coletas_agendadas,
            SUM(CASE WHEN status_gerencial = 'Realizada e confirmada' THEN 1 ELSE 0 END) AS confirmadas,
            SUM(CASE WHEN produtividade_manual = 'Sim' THEN 1 ELSE 0 END) AS confirmacoes_manuais,
            SUM(CASE WHEN origem_confirmacao = 'Confirmada pelo fornecedor via MTR' THEN 1 ELSE 0 END) AS confirmacoes_mtr,
            SUM(CASE WHEN confirmacao_pelo_responsavel_carteira = 'Sim' THEN 1 ELSE 0 END) AS confirmacoes_responsavel_carteira,
            SUM(CASE WHEN confirmacao_por_outro_atendente = 'Sim' THEN 1 ELSE 0 END) AS confirmacoes_outros_atendentes,
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


def pending_orders_by_unit(conn, scope_sql: str, scope_params: list, limit: int = 1500) -> list[dict]:
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
        LIMIT ?
        """,
        scope_params + [limit],
    ).fetchall()
    return rows_to_dicts(rows)


def pending_confirmation_orders_by_unit(conn, scope_sql: str, scope_params: list, limit: int = 1500) -> list[dict]:
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
        LIMIT ?
        """,
        scope_params + [limit],
    ).fetchall()
    return rows_to_dicts(rows)


def performance_portfolio_attendant(conn, scope_sql: str, scope_params: list) -> list[dict]:
    rows = conn.execute(
        f"""
        {scope_sql}
        SELECT
            COALESCE(NULLIF(carteira_responsavel_confirmacao, ''), NULLIF(carteira_atendimento, ''), 'Carteira não identificada') AS label,
            COUNT(DISTINCT COALESCE(NULLIF(cadastro_cliente, ''), NULLIF(cliente, ''), unidade)) AS clientes,
            COUNT(DISTINCT COALESCE(NULLIF(grupo_contratual, ''), 'Não informado')) AS grupos_contratuais,
            COUNT(DISTINCT COALESCE(NULLIF(unidade, ''), 'Não informado')) AS unidades,
            COUNT(DISTINCT COALESCE(NULLIF(fornecedor, ''), 'Não informado')) AS fornecedores,
            COUNT(*) AS total_os,
            SUM(CASE WHEN status_gerencial = 'Realizada e confirmada' THEN 1 ELSE 0 END) AS confirmadas,
            SUM(CASE WHEN produtividade_manual = 'Sim' THEN 1 ELSE 0 END) AS confirmacoes_manuais,
            SUM(CASE WHEN origem_confirmacao = 'Confirmada pelo fornecedor via MTR' THEN 1 ELSE 0 END) AS confirmacoes_mtr,
            SUM(CASE WHEN confirmacao_pelo_responsavel_carteira = 'Sim' THEN 1 ELSE 0 END) AS confirmacoes_responsavel_carteira,
            SUM(CASE WHEN confirmacao_por_outro_atendente = 'Sim' THEN 1 ELSE 0 END) AS confirmacoes_outros_atendentes,
            SUM(CASE WHEN {is_pending_confirmation_sql()} THEN 1 ELSE 0 END) AS pendentes_confirmacao,
            SUM(CASE WHEN status_gerencial = 'Não realizada' THEN 1 ELSE 0 END) AS nao_realizadas,
            MAX(COALESCE(NULLIF(carteira_cs, ''), '')) AS cs,
            MAX(COALESCE(NULLIF(carteira_assistente, ''), '')) AS assistente_atendimento,
            MAX(COALESCE(NULLIF(carteira_atendimento, ''), '')) AS atendimento,
            MAX(COALESCE(NULLIF(carteira_cobertura, ''), '')) AS cobertura
        FROM scoped_orders
        GROUP BY label
        ORDER BY total_os DESC, label
        """,
        scope_params,
    ).fetchall()
    items = rows_to_dicts(rows)
    for item in items:
        total = int(item.get("total_os") or 0)
        pending = int(item.get("pendentes_confirmacao") or 0)
        units = int(item.get("unidades") or 0)
        groups = int(item.get("grupos_contratuais") or 0)
        manual_human = int(item.get("confirmacoes_manuais") or 0)
        own_confirmations = int(item.get("confirmacoes_responsavel_carteira") or 0)
        load_score = total + (units * 8) + (groups * 5) + (pending * 2)
        if load_score >= 900:
            load_label = "Muito alta"
        elif load_score >= 450:
            load_label = "Alta"
        elif load_score >= 180:
            load_label = "Média"
        else:
            load_label = "Baixa"
        coverage = float(item["confirmadas"] or 0) / total if total else 0
        manual = float(manual_human) / total if total else 0
        own_rate = float(own_confirmations) / manual_human if manual_human else 0
        if coverage >= 0.85 and pending <= max(3, total * 0.05):
            profile = "Boa performance"
        elif coverage >= 0.65:
            profile = "Atenção"
        else:
            profile = "Priorizar"
        item["carga_score"] = round(load_score, 1)
        item["carga_carteira"] = load_label
        item["taxa_confirmacao_carteira"] = round(coverage * 100, 1)
        item["taxa_confirmacao_atendente"] = round(manual * 100, 1)
        item["taxa_execucao_responsavel"] = round(own_rate * 100, 1)
        item["apoio_recebido"] = int(item.get("confirmacoes_outros_atendentes") or 0)
        item["perfil_performance"] = profile
    return items


def performance_real_sigra_user(conn, scope_sql: str, scope_params: list) -> list[dict]:
    rows = conn.execute(
        f"""
        {scope_sql}
        SELECT
            COALESCE(NULLIF(responsavel_confirmacao, ''), 'Não informado') AS label,
            COUNT(*) AS confirmacoes_realizadas,
            COUNT(DISTINCT COALESCE(NULLIF(unidade, ''), 'Não informado')) AS unidades,
            COUNT(DISTINCT COALESCE(NULLIF(cadastro_cliente, ''), NULLIF(cliente, ''), unidade)) AS clientes,
            SUM(CASE WHEN confirmacao_pelo_responsavel_carteira = 'Sim' THEN 1 ELSE 0 END) AS dentro_propria_carteira,
            SUM(CASE WHEN confirmacao_por_outro_atendente = 'Sim' THEN 1 ELSE 0 END) AS apoio_prestado,
            SUM(CASE WHEN COALESCE(carteira_identificada, '') <> 'Sim' THEN 1 ELSE 0 END) AS fora_da_carteira
        FROM scoped_orders
        WHERE produtividade_manual = 'Sim'
        GROUP BY label
        ORDER BY confirmacoes_realizadas DESC, label
        """,
        scope_params,
    ).fetchall()
    return rows_to_dicts(rows)

def dashboard(import_id: str = "", date_from: str = "", date_to: str = "") -> dict:
    cache_key = (import_id or "", date_from or "", date_to or "")
    if cache_key in DASHBOARD_CACHE:
        return DASHBOARD_CACHE[cache_key]
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

        result = {
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
                "atendentes": count_manual_confirmations_by_attendant(conn, scope_sql, scope_params),
                "aberturas": count_by(conn, "responsavel_abertura", scope_sql, scope_params),
                "unidades": count_by(conn, "unidade", scope_sql, scope_params),
                "clientes_cadastrais": count_by(conn, "cliente", scope_sql, scope_params),
                "grupos_contratuais": count_by(conn, "grupo_contratual", scope_sql, scope_params),
                "regionais_cadastrais": count_by(conn, "regional_cadastral", scope_sql, scope_params),
                "carteiras": count_by(conn, "carteira", scope_sql, scope_params),
                "status_unidade": count_by(conn, "status_unidade", scope_sql, scope_params),
                "carteira_atendimento": count_by(conn, "carteira_atendimento", scope_sql, scope_params),
                "carteira_responsavel_confirmacao": count_by(conn, "carteira_responsavel_confirmacao", scope_sql, scope_params),
                "carteira_cs": count_by(conn, "carteira_cs", scope_sql, scope_params),
                "carteira_assistente": count_by(conn, "carteira_assistente", scope_sql, scope_params),
                "carteira_cobertura": count_by(conn, "carteira_cobertura", scope_sql, scope_params),
                "tipo_confirmacao": count_by(conn, "tipo_confirmacao", scope_sql, scope_params),
            },
            "performance": {
                "carteira_atendentes": performance_portfolio_attendant(conn, scope_sql, scope_params),
                "execucao_sigra_usuarios": performance_real_sigra_user(conn, scope_sql, scope_params),
                "atendentes": performance_by(conn, "responsavel_confirmacao", scope_sql, scope_params),
                "aberturas": performance_by(conn, "responsavel_abertura", scope_sql, scope_params),
                "responsaveis_operacionais": performance_operational_owner(conn, scope_sql, scope_params),
                "colaborador_unidade": performance_collaborator_unit(conn, scope_sql, scope_params),
                "colaborador_unidade_fornecedor": performance_unit_supplier(conn, scope_sql, scope_params),
                "unidades": unit_operational_summary(conn, scope_sql, scope_params),
                "pendencias_unidade": pending_orders_by_unit(conn, scope_sql, scope_params),
                "pendentes_confirmacao_unidade": pending_confirmation_orders_by_unit(conn, scope_sql, scope_params),
            },
        }
        DASHBOARD_CACHE[cache_key] = result
        return result


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
    grupo_contratual = query.get("grupo_contratual", [""])[0].strip()
    regional_cadastral = query.get("regional_cadastral", [""])[0].strip()
    carteira = query.get("carteira", [""])[0].strip()
    status_unidade = query.get("status_unidade", [""])[0].strip()
    carteira_atendimento = query.get("carteira_atendimento", [""])[0].strip()
    limit = min(int(query.get("limit", ["200"])[0] or 200), 1000)

    with get_conn() as conn:
        if not import_id or import_id == "latest":
            import_id = latest_import_id(conn)
        if not import_id:
            return {"rows": [], "total": 0}

        where = ["import_id = ?"]
        params = [import_id]
        if search:
            where.append("(numero_os LIKE ? OR unidade LIKE ? OR fornecedor LIKE ? OR atendente_vinculado LIKE ? OR responsavel_abertura LIKE ? OR responsavel_confirmacao LIKE ? OR tipo_residuo LIKE ? OR grupo_contratual LIKE ? OR regional_cadastral LIKE ? OR carteira LIKE ? OR status_unidade LIKE ? OR sigla_unidade LIKE ? OR cadastro_alerta LIKE ? OR carteira_atendimento LIKE ? OR carteira_cs LIKE ? OR carteira_assistente LIKE ? OR carteira_responsavel_confirmacao LIKE ? OR tipo_confirmacao LIKE ?)")
            needle = f"%{search}%"
            params.extend([needle] * 18)
        if status:
            where.append("status_gerencial = ?")
            params.append(status)
        if action:
            where.append("precisa_acao = ?")
            params.append(action)
        for column, value in [
            ("grupo_contratual", grupo_contratual),
            ("regional_cadastral", regional_cadastral),
            ("carteira", carteira),
            ("status_unidade", status_unidade),
            ("carteira_atendimento", carteira_atendimento),
        ]:
            if value:
                where.append(f"{column} = ?")
                params.append(value)

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
                   observacoes, inconsistencias, grupo_contratual, grupo_contratual_codigo,
                   grupo_contratual_nome, regional_cadastral, carteira, responsavel_cadastral,
                   status_unidade, unidade_normalizada, sigla_unidade, cadastro_match,
                   cadastro_alerta, carteira_cs, carteira_atendimento, carteira_assistente,
                   carteira_analista, carteira_responsavel_confirmacao, carteira_cobertura,
                   carteira_link_type, carteira_identificada, carteira_alerta,
                   tipo_confirmacao, confirmacao_pelo_responsavel_carteira, confirmacao_por_outro_atendente,
                   import_id
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
            if path == "/api/customer-base":
                return self.send_json(customer_base_summary())
            if path == "/api/service-portfolios":
                return self.send_json(service_portfolio_summary())
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
        if parsed.path == "/api/service-portfolios":
            try:
                length = int(self.headers.get("Content-Length", "0") or 0)
                payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
                return self.send_json({"ok": True, "service_portfolios": upsert_service_portfolio(payload)})
            except Exception as exc:
                return self.send_error_json(str(exc), HTTPStatus.BAD_REQUEST)

        if parsed.path not in {"/api/import", "/api/customer-base/import", "/api/service-portfolios/import"}:
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

            if parsed.path == "/api/customer-base/import":
                summary = import_customer_base(target, safe_name)
                self.send_json({"ok": True, "customer_base": summary})
            elif parsed.path == "/api/service-portfolios/import":
                summary = import_service_portfolio(target, safe_name)
                self.send_json({"ok": True, "service_portfolios": summary})
            else:
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
