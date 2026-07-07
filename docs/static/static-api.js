(() => {
  const DB_NAME = "sigra-confirmacao-coleta-pages";
  const DB_VERSION = 6;
  const ACTIVE = "Ativa";
  const PENDING = "Pendente de conferência";
  const RULE_VERSION = "github-pages-v3-cache-memoria";
  const REQUIRED_COLUMNS = ["Número Ordem", "Nome Fantasia", "Data", "Data Agendada", "Data Realização", "Data Realizada"];
  const DATE_COLUMNS = ["Data", "Data Agendada", "Data Realização", "Data Realizada", "Data Não Realizada"];
  let officialLoadPromise = null;
  let officialMemory = null;

  const text = (value) => value === null || value === undefined ? "" : String(value).trim();
  const strip = (value) => text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  function localDateKey(value) {
    if (!value) return "";
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      const y = value.getFullYear();
      const m = String(value.getMonth() + 1).padStart(2, "0");
      const d = String(value.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
    const raw = text(value);
    const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const br = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (br) {
      const year = br[3].length === 2 ? `20${br[3]}` : br[3];
      return `${year}-${String(br[2]).padStart(2, "0")}-${String(br[1]).padStart(2, "0")}`;
    }
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return "";
    return localDateKey(d);
  }
  const formatDateBR = (value) => {
    const key = localDateKey(value);
    if (!key) return "";
    const [y, m, d] = key.split("-");
    return `${d}/${m}/${y}`;
  };
  const dateLabel = formatDateBR;
  const digits = (value) => text(value).replace(/\D/g, "");
  const shortDoc = (value) => {
    const doc = digits(value);
    return doc.length > 14 ? doc.slice(-14) : doc;
  };
  const nowIso = () => new Date().toISOString();
  const uid = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        if (!db.objectStoreNames.contains("imports")) db.createObjectStore("imports", { keyPath: "id" });
        if (!db.objectStoreNames.contains("orders")) {
          const store = db.createObjectStore("orders", { keyPath: "id" });
          store.createIndex("import_id", "import_id");
          store.createIndex("numero_os", "numero_os");
        }
        if (!db.objectStoreNames.contains("clientImports")) db.createObjectStore("clientImports", { keyPath: "id" });
        if (!db.objectStoreNames.contains("clientUnits")) db.createObjectStore("clientUnits", { keyPath: "id" });
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
        if (event.oldVersion && event.oldVersion < 6) {
          ["imports", "orders", "clientImports", "clientUnits", "meta"].forEach((name) => {
            if (db.objectStoreNames.contains(name)) req.transaction.objectStore(name).clear();
          });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function tx(storeNames, mode, callback) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeNames, mode);
      const stores = Array.isArray(storeNames)
        ? Object.fromEntries(storeNames.map((name) => [name, transaction.objectStore(name)]))
        : transaction.objectStore(storeNames);
      const result = callback(stores, transaction);
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAll(storeName) {
    const db = await openDb();
    const rows = await reqToPromise(db.transaction(storeName, "readonly").objectStore(storeName).getAll());
    const officialRows = officialMemory?.[storeName] || [];
    if (!officialRows.length) return rows;
    return [...officialRows, ...rows.filter((row) => row.source === "local")];
  }

  async function putMany(storeName, rows) {
    if (!rows.length) return;
    await tx(storeName, "readwrite", (store) => rows.forEach((row) => store.put(row)));
  }

  async function getOne(storeName, id) {
    const db = await openDb();
    return reqToPromise(db.transaction(storeName, "readonly").objectStore(storeName).get(id));
  }

  function expandTable(table) {
    if (!table) return [];
    if (Array.isArray(table)) return table;
    const columns = table.columns || [];
    const dictionary = table.dict || null;
    return (table.rows || []).map((row) => Object.fromEntries(columns.map((col, idx) => {
      const value = row[idx] ?? "";
      return [col, dictionary ? (dictionary[value] ?? "") : value];
    })));
  }

  async function deleteWhere(storeName, predicate) {
    const rows = await getAll(storeName);
    await tx(storeName, "readwrite", (store) => {
      rows.filter(predicate).forEach((row) => store.delete(row.id));
    });
  }

  async function clearOfficialCache() {
    await deleteWhere("imports", (row) => row.source !== "local");
    await deleteWhere("orders", (row) => row.source !== "local");
    await deleteWhere("clientImports", (row) => row.source !== "local");
    await deleteWhere("clientUnits", (row) => row.source !== "local");
    await putMany("meta", [{ key: "officialLoaded", value: "", loaded_at: "" }]);
  }

  async function officialManifest() {
    const response = await fetch("./data/config/importacoes.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Não foi possível carregar data/config/importacoes.json");
    return response.json();
  }

  async function fetchJson(path, fallback) {
    try {
      const response = await fetch(path, { cache: "no-store" });
      if (!response.ok) return fallback;
      return response.json();
    } catch (_) {
      return fallback;
    }
  }

  async function officialConfig() {
    const [calendars, waves, unitLinks, summary] = await Promise.all([
      fetchJson("./data/config/calendario-medicao.json", []),
      fetchJson("./data/config/ondas.json", []),
      fetchJson("./data/config/unidades-ondas.json", []),
      fetchJson("./data/config/resumo-expansao.json", {}),
    ]);
    return { calendars, waves, unitLinks, summary };
  }

  async function officialCache() {
    return fetchJson("./data/cache/official-cache.json", null);
  }

  async function processClientRows(rows, importMeta, source = "official") {
    const importId = importMeta.id || uid("clientes");
    const units = rows.map((row, idx) => {
      const groupRaw = text(row["Grupo Contratual"] || row["Código Grupo Contratual"] || row.Grupo || "");
      const codeMatch = groupRaw.match(/^\s*(\d+)/);
      const name = text(row["Nome Grupo Contratual"] || row["Nome do Grupo Contratual"] || row["Grupo Contratual Nome"] || groupRaw.replace(/^\d+\s*[-–]?\s*/, ""));
      const cliente = text(row.Cliente || row["Nome/Razão Social"] || row["Nome/Razão Social Gerador"] || row["Nome Resumido"]);
      const unidade = text(row["Nome Fantasia"] || row.Unidade || row.Estabelecimento || row["Nome Resumido"] || cliente);
      return {
        id: `${importId}-${idx}`,
        import_id: importId,
        source,
        grupo_contratual_codigo: codeMatch ? codeMatch[1] : "",
        grupo_contratual_nome: name || "Não identificado",
        cliente,
        codigo_cliente: text(row["Código Cliente"] || row["Codigo Cliente"]),
        cliente_documento: shortDoc(row["CPF/CNPJ"] || row.CNPJ || row.Documento),
        unidade,
        unidade_chave: strip(unidade),
        cliente_chave: strip(cliente),
        endereco: text(row["Endereço"] || row.Endereco || row.Logradouro),
        cidade: text(row.Cidade || row["Município"] || row["Munícipio"]),
        uf: text(row.UF || row.Estado),
        status: text(row.Status) || "Ativo",
        campos_mapeados: Object.keys(row).filter(Boolean),
      };
    }).filter((row) => row.cliente || row.unidade || row.grupo_contratual_nome !== "Não identificado");
    await putMany("clientImports", [{
      id: importId,
      source,
      file_name: importMeta.arquivo_nome || importMeta.file_name || "Base de clientes",
      imported_at: importMeta.incluido_em || nowIso(),
      row_count: rows.length,
      valid_count: units.length,
      unidentified_count: units.filter((u) => u.grupo_contratual_nome === "Não identificado").length,
      status: "Ativa",
    }]);
    await putMany("clientUnits", units);
    return units;
  }

  async function processOrderRows(rows, importMeta, source = "official") {
    const headers = Object.keys(rows[0] || {});
    const missing = REQUIRED_COLUMNS.filter((col) => !headers.includes(col));
    if (missing.length) throw new Error(`Campos obrigatórios ausentes em ${importMeta.arquivo_nome || importMeta.file_name}: ${missing.join(", ")}`);
    const clientUnits = await getAll("clientUnits");
    const clientLookup = buildClientLookup(clientUnits);
    const importId = importMeta.id || uid("sigra");
    const importedAt = importMeta.incluido_em || nowIso();
    const osSeen = new Map();
    const duplicates = new Set();
    const orders = rows.map((raw, idx) => {
      const norm = normalizeStatus(raw);
      const numero = text(raw["Número Ordem"]);
      if (numero && osSeen.has(numero)) duplicates.add(numero);
      osSeen.set(numero, true);
      const fornecedorOriginal = text(raw.Fornecedor);
      const transportador = text(raw.Transportador);
      const fornecedor = fornecedorOriginal || transportador;
      const cliente = text(raw["Nome/Razão Social Gerador"]);
      const clienteDocumento = shortDoc(raw["CPF/CNPJ Gerador"]);
      const unidade = text(raw["Nome Fantasia"]);
      const group = classifyContractGroup(cliente, unidade, clientLookup, clienteDocumento);
      return {
        id: `${importId}-${idx}`,
        import_id: importId,
        source,
        numero_os: numero,
        cliente,
        cliente_documento: clienteDocumento,
        ...group,
        unidade,
        regional: regionalFromUf(raw.UF),
        fornecedor: fornecedor || "Não informado",
        fornecedor_original: fornecedorOriginal,
        fornecedor_original_vazio: fornecedorOriginal ? "Não" : "Sim",
        fornecedor_considerado: fornecedor,
        fonte_fornecedor_considerado: fornecedorOriginal ? "Fornecedor" : transportador ? "Transportador" : "Não informado",
        transportador,
        destinador: text(raw.Destinador),
        tipo_residuo: text(raw["Resíduo"]),
        mtr: text(raw["Número MTR"]) || text(raw["Número MTR Provisório"]),
        status_original: text(raw.Status),
        data_abertura: parseDate(raw.Data),
        motivo_nao_realizacao: text(raw["Motivo Recusa"]) || text(raw.Justificativa),
        usuario_responsavel: text(raw["Usuário"]),
        atendente_vinculado: text(raw["Usuário Realizada"]) || text(raw["Usuário"]) || "Não definido",
        observacoes: text(raw["Observação"]) || text(raw.Escopo),
        inconsistencias: norm.inconsistencia,
        raw_json: JSON.stringify(raw),
        ...norm,
      };
    });
    const dates = orders.map((o) => o.data_abertura).filter(Boolean).sort();
    const normalizedStatus = strip(importMeta.status || "ativa") === "ATIVA" ? ACTIVE : text(importMeta.status || "Ativa");
    const item = {
      id: importId,
      source,
      file_name: importMeta.arquivo_nome || importMeta.file_name || importMeta.nome || "Relatório SIGRA",
      official_path: importMeta.arquivo || "",
      imported_at: importedAt,
      import_type: importMeta.tipo === "baseline" ? "Baseline" : importMeta.tipo === "analise_separada" ? "Análise separada" : "Operacional",
      tipo: importMeta.tipo || "operacional",
      cliente: importMeta.cliente || "Todos",
      competencia: importMeta.competencia || "",
      onda: importMeta.onda || "",
      period_start: importMeta.periodo_inicio || dates[0] || "",
      period_end: importMeta.periodo_fim || dates[dates.length - 1] || "",
      period_start_label: dateLabel(importMeta.periodo_inicio || dates[0]),
      period_end_label: dateLabel(importMeta.periodo_fim || dates[dates.length - 1]),
      row_count: rows.length,
      unique_os_count: [...new Set(orders.map((o) => o.numero_os).filter(Boolean))].length,
      duplicate_count: duplicates.size,
      missing_required_count: 0,
      inconsistency_count: orders.filter((o) => o.inconsistencias).length,
      warning_count: duplicates.size + orders.filter((o) => o.inconsistencias).length,
      rule_version: RULE_VERSION,
      status: normalizedStatus,
      active: normalizedStatus === ACTIVE,
      decision_log: [{ em: importedAt, acao: source === "official" ? "carga_oficial_repositorio" : "upload_local_temporario", status: normalizedStatus }],
    };
    await putMany("orders", orders);
    await putMany("imports", [item]);
    return { item, orders };
  }

  async function loadOfficialBase(force = false) {
    if (officialLoadPromise && !force) return officialLoadPromise;
    officialLoadPromise = loadOfficialBaseInner(force).finally(() => {
      officialLoadPromise = null;
    });
    return officialLoadPromise;
  }

  async function loadOfficialBaseInner(force = false) {
    if (!window.XLSX) throw new Error("Biblioteca de leitura de Excel não carregada. Verifique a conexão com a internet.");
    const manifest = await officialManifest();
    const signature = JSON.stringify({ rule: RULE_VERSION, files: manifest.map((item) => [item.id, item.arquivo, item.status, item.incluido_em]) });
    const meta = await getOne("meta", "officialLoaded").catch(() => null);
    if (!force && officialMemory?.imports?.length && meta?.value === signature) return;
    const cache = await officialCache();
    const cacheSignature = typeof cache?.signature === "string" ? JSON.stringify(JSON.parse(cache.signature)) : "";
    if (cacheSignature === signature && cache.orders) {
      officialMemory = null;
      const cachedClientImports = expandTable(cache.clientImports) || [];
      const cachedClientUnits = expandTable(cache.clientUnits) || [];
      const cachedImports = expandTable(cache.imports) || [];
      const cachedOrders = expandTable(cache.orders) || [];
      officialMemory = {
        clientImports: cachedClientImports,
        clientUnits: cachedClientUnits,
        imports: cachedImports,
        orders: cachedOrders,
      };
      await putMany("meta", [
        { key: "officialLoaded", value: signature, loaded_at: nowIso(), cache_generated_at: cache.generated_at || "" },
        { key: "dataMode", value: "official" },
      ]);
      return;
    }
    await clearOfficialCache();
    const activeOfficial = manifest.filter((item) => strip(item.status) === "ATIVA");
    for (const item of activeOfficial.filter((row) => row.tipo === "cadastro_clientes")) {
      await processClientRows(await fetchWorkbookRows(item.arquivo), item, "official");
    }
    for (const item of activeOfficial.filter((row) => row.tipo !== "cadastro_clientes")) {
      await processOrderRows(await fetchWorkbookRows(item.arquivo), item, "official");
    }
    await putMany("meta", [
      { key: "officialLoaded", value: signature, loaded_at: nowIso() },
      { key: "dataMode", value: "official" },
    ]);
  }

  async function updateOne(storeName, id, updater) {
    await tx(storeName, "readwrite", (store) => {
      const req = store.get(id);
      req.onsuccess = () => {
        const item = req.result;
        if (item) store.put(updater(item) || item);
      };
    });
  }

  function parseDate(value) {
    if (!value) return "";
    if (value instanceof Date && !Number.isNaN(value.getTime())) return localDateKey(value);
    if (typeof value === "number" && window.XLSX?.SSF) {
      const parsed = XLSX.SSF.parse_date_code(value);
      if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
    }
    const raw = text(value);
    const br = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/);
    if (br) {
      const year = Number(br[3].length === 2 ? `20${br[3]}` : br[3]);
      return `${year}-${String(br[2]).padStart(2, "0")}-${String(br[1]).padStart(2, "0")}`;
    }
    return localDateKey(raw);
  }

  function workbookRowsFromArrayBuffer(buffer) {
    const wb = XLSX.read(buffer, { type: "array", cellDates: true });
    const ws = wb.Sheets[wb.SheetNames.includes("Dados") ? "Dados" : wb.SheetNames[0]];
    const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true });
    const candidates = matrix.slice(0, 25).map((row, idx) => ({ idx, count: row.filter((cell) => text(cell)).length }));
    const headerIdx = candidates.sort((a, b) => b.count - a.count)[0]?.idx || 0;
    const headers = matrix[headerIdx].map((cell) => text(cell));
    return matrix.slice(headerIdx + 1)
      .filter((row) => row.some((cell) => text(cell)))
      .map((row) => Object.fromEntries(headers.map((header, i) => [header, row[i] ?? ""])));
  }

  function readWorkbookRows(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          resolve(workbookRowsFromArrayBuffer(reader.result));
        } catch (error) {
          reject(error);
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });
  }

  async function fetchWorkbookRows(path) {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) throw new Error(`Não foi possível carregar ${path}`);
    return workbookRowsFromArrayBuffer(await response.arrayBuffer());
  }

  function regionalFromUf(uf) {
    const value = strip(uf);
    if (["SP", "RJ", "MG", "ES"].includes(value)) return "Sudeste";
    if (["PR", "SC", "RS"].includes(value)) return "Sul";
    if (["BA", "PE", "CE", "MA", "PB", "PI", "RN", "SE", "AL"].includes(value)) return "Nordeste";
    if (["AM", "PA", "RO", "RR", "AC", "AP", "TO"].includes(value)) return "Norte";
    if (["GO", "MT", "MS", "DF"].includes(value)) return "Centro-Oeste";
    return "Não informado";
  }

  function classifyContractGroup(cliente, unidade, clientUnits = [], documento = "") {
    const key = strip(`${cliente} ${unidade}`);
    const doc = shortDoc(documento);
    const lookup = clientUnits?.byDoc ? clientUnits : buildClientLookup(clientUnits || []);
    const match = (doc && lookup.byDoc.get(doc))
      || lookup.byUnit.find((row) => row.unitKey && (key.includes(row.unitKey) || row.unitKey.includes(strip(unidade))))
      || lookup.byClient.find((row) => row.clientKey && (key.includes(row.clientKey) || row.clientKey.includes(strip(cliente))));
    if (match) {
      return {
        grupo_contratual_codigo: text(match.grupo_contratual_codigo),
        grupo_contratual_nome: text(match.grupo_contratual_nome) || "Não identificado",
        grupo_contratual_fonte: "Base de Clientes / Grupos Contratuais",
        cadastro_cliente_codigo: text(match.codigo_cliente),
        cadastro_cliente_nome: text(match.cliente),
        cadastro_unidade: text(match.unidade),
        cadastro_documento_match: doc && shortDoc(match.cliente_documento) === doc ? "Sim" : "Não",
      };
    }
    if (key.includes("MERCADO LIVRE")) {
      return {
        grupo_contratual_codigo: "1490",
        grupo_contratual_nome: "Mercado Livre",
        grupo_contratual_fonte: "Regra automática: Mercado Livre",
        cadastro_cliente_codigo: "",
        cadastro_cliente_nome: "",
        cadastro_unidade: "",
        cadastro_documento_match: "Não",
      };
    }
    return { grupo_contratual_codigo: "", grupo_contratual_nome: "Não identificado", grupo_contratual_fonte: "Sem regra cadastrada", cadastro_cliente_codigo: "", cadastro_cliente_nome: "", cadastro_unidade: "", cadastro_documento_match: "Não" };
  }

  function buildClientLookup(clientUnits = []) {
    const byDoc = new Map();
    const byUnit = [];
    const byClient = [];
    for (const row of clientUnits) {
      const doc = shortDoc(row.cliente_documento);
      if (doc && !byDoc.has(doc)) byDoc.set(doc, row);
      const unitKey = strip(row.unidade);
      const clientKey = strip(row.cliente);
      if (unitKey) byUnit.push({ ...row, unitKey });
      if (clientKey) byClient.push({ ...row, clientKey });
    }
    return { byDoc, byUnit, byClient };
  }

  function isMtr(row) {
    const blob = strip(`${row["Observação"] || ""} ${row["Escopo"] || ""} ${row["Justificativa"] || ""} ${row["Usuário Realizada"] || ""}`);
    return strip(row["Confirmado pelo fornecedor"]) === "SIM" || blob.includes("CONFIRMACAO DE COLETA DA MTR") || blob.includes("CONFIRMACAO.COLETA");
  }

  function isRobot(row) {
    const blob = strip(`${row["Usuário"] || ""} ${row["Solicitante"] || ""} ${row["Justificativa"] || ""} ${row["Observação"] || ""} ${row["Escopo"] || ""}`);
    return blob.includes("ROBO PROGRAMADA") || blob.includes("ROBO.PROGRAMADA") || blob.includes("AGENDADA AUTOMATICAMENTE");
  }

  function isSystemUser(value) {
    const v = strip(value);
    return !v || v.includes("CONFIRMACAO.COLETA") || v.includes("CONFIRMACAO COLETA") || v.includes("ROBO") || v.includes("ROBÔ");
  }

  function firstHumanUser(row, fields) {
    for (const field of fields) {
      const value = text(row[field]);
      if (value && !isSystemUser(value)) return value;
    }
    return "";
  }

  function normalizeStatus(row) {
    const status = strip(row.Status);
    const dataRealizacao = parseDate(row["Data Realização"]);
    const dataRealizada = parseDate(row["Data Realizada"]);
    const dataNaoRealizada = parseDate(row["Data Não Realizada"]);
    const dataAgendada = parseDate(row["Data Agendada"]);
    const atrasoAg = strip(row['Atraso "Em Agendamento"']) === "SIM";
    const atrasoRe = strip(row["Atraso na realização"]) === "SIM";
    const robo = isRobot(row);
    const viaMtr = isMtr(row);

    let statusOperacional = "Pendente";
    if (dataRealizacao) statusOperacional = "Coleta realizada pelo fornecedor";
    else if (dataNaoRealizada || status.includes("NAO REALIZADA") || status.includes("NÃO REALIZADA")) statusOperacional = "Coleta não realizada";
    else if (dataAgendada || status.includes("AGENDADA")) statusOperacional = "Coleta agendada";
    else if (status.includes("EM AGENDAMENTO")) statusOperacional = "Em agendamento";

    let origemConfirmacao = "Não confirmada";
    let responsavelConfirmacao = "";
    let produtividadeManual = "Não";
    if (dataRealizada && viaMtr) {
      origemConfirmacao = "Confirmada pelo fornecedor via MTR";
      responsavelConfirmacao = "Fornecedor via MTR";
    } else if (dataRealizada) {
      responsavelConfirmacao = firstHumanUser(row, ["Usuário Realizada", "Usuário Aceita", "Usuário Agendada", "Usuário", "Solicitante"]) || "Atendente não identificado";
      origemConfirmacao = responsavelConfirmacao ? "Confirmada pelo atendente" : "Confirmação sem atendente identificado";
      produtividadeManual = responsavelConfirmacao && !isSystemUser(responsavelConfirmacao) ? "Sim" : "Não";
    } else if (dataRealizacao) {
      origemConfirmacao = "Pendente de confirmação pelo atendente";
    }

    let statusGerencial = "Pendente";
    let inconsistencia = "";
    if (dataRealizada && !dataRealizacao) {
      statusGerencial = "Inconsistência";
      inconsistencia = "Data Realizada preenchida sem Data Realização";
    } else if (dataRealizacao && !dataRealizada) statusGerencial = "Realizada fornecedor - pendente confirmação";
    else if (dataRealizacao && dataRealizada) statusGerencial = "Realizada e confirmada";
    else if (statusOperacional === "Coleta não realizada") statusGerencial = "Não realizada";
    else if (atrasoAg || atrasoRe) statusGerencial = "Em atraso";
    else if (statusOperacional === "Coleta agendada") statusGerencial = "Agendada";
    else if (statusOperacional === "Em agendamento") statusGerencial = "Em agendamento";

    const statusConfirmacao = dataRealizada ? "Confirmada" : dataRealizacao ? "Pendente de confirmação" : "Não confirmada";
    const precisaAcao = inconsistencia || statusConfirmacao === "Pendente de confirmação" || (!dataRealizada && (atrasoAg || atrasoRe)) || ["Não realizada", "Pendente"].includes(statusGerencial);
    return {
      data_realizacao: dataRealizacao,
      data_realizada: dataRealizada,
      data_nao_realizada: dataNaoRealizada,
      data_agendada: dataAgendada,
      status_operacional: statusOperacional,
      status_confirmacao: statusConfirmacao,
      origem_os: robo ? "Robô Programada" : "Sob demanda",
      processo_origem: viaMtr ? "Confirmação de Coleta pelo fornecedor via MTR" : (robo ? "Robô Programada" : "Sob demanda"),
      responsavel_abertura: robo ? "Robô Programada" : (firstHumanUser(row, ["Usuário", "Usuário Agendada", "Usuário Aceita", "Solicitante"]) || "Atendente não identificado"),
      origem_confirmacao: origemConfirmacao,
      responsavel_confirmacao: responsavelConfirmacao,
      produtividade_manual: produtividadeManual,
      usuario_aceita: text(row["Usuário Aceita"]),
      usuario_agendada: text(row["Usuário Agendada"]),
      usuario_realizada: text(row["Usuário Realizada"]),
      usuario_sistemico_ignorado: isSystemUser(row["Usuário Realizada"]) || isSystemUser(row["Usuário"]) ? "Sim" : "Não",
      status_gerencial: statusGerencial,
      prazo: atrasoAg && atrasoRe ? "Atraso no agendamento e na realização" : atrasoAg ? "Atraso em agendamento" : atrasoRe ? "Atraso na realização" : "Sem atraso indicado",
      precisa_acao: precisaAcao ? "Sim" : "Não",
      inconsistencia,
    };
  }

  function isOpenScheduled(row) {
    return row.data_agendada && strip(row.status_original).includes("AGENDADA") && !row.data_realizacao && !row.data_realizada && !row.data_nao_realizada && row.origem_confirmacao !== "Confirmada pelo fornecedor via MTR" && row.status_gerencial !== "Não realizada";
  }
  const isPending = isOpenScheduled;
  const isConfirmed = (row) => row.produtividade_manual === "Sim" || row.origem_confirmacao === "Confirmada pelo fornecedor via MTR";
  const label = (value) => text(value) || "Não informado";

  async function importOrders(file, mode = "local-only") {
    if (!window.XLSX) throw new Error("Biblioteca de leitura de Excel não carregada. Verifique a conexão com a internet.");
    const rows = await readWorkbookRows(file);
    await deleteWhere("imports", (row) => row.source === "local");
    await deleteWhere("orders", (row) => row.source === "local");
    const { item } = await processOrderRows(rows, {
      id: uid("local"),
      file_name: file.name,
      arquivo_nome: file.name,
      tipo: "operacional",
      status: "ativa",
      incluido_em: nowIso(),
    }, "local");
    await putMany("meta", [{ key: "dataMode", value: mode === "combine" ? "official-local" : "local-only" }]);
    return { ok: true, import: await importDetails(item.id) };
  }

  async function importsList() {
    const imports = await getAll("imports");
    return imports.sort((a, b) => String(b.imported_at).localeCompare(String(a.imported_at))).map((item) => ({
      ...item,
      period_start_label: item.period_start_label || dateLabel(item.period_start),
      period_end_label: item.period_end_label || dateLabel(item.period_end),
      active: item.status === ACTIVE,
    }));
  }

  async function dataMode() {
    return (await getOne("meta", "dataMode").catch(() => null))?.value || "official";
  }

  async function setDataMode(mode) {
    await putMany("meta", [{ key: "dataMode", value: mode }]);
    return { ok: true, mode };
  }

  function sourceLabel(mode) {
    if (mode === "local-only") return "Análise local temporária";
    if (mode === "official-local") return "Base oficial + análise local temporária";
    return "Base oficial do repositório";
  }

  function allowedSourcesForMode(mode) {
    if (mode === "local-only") return new Set(["local"]);
    if (mode === "official-local") return new Set(["official", "local"]);
    return new Set(["official"]);
  }

  async function importDetails(id) {
    const item = await getOne("imports", id);
    if (!item) throw new Error("Importação não encontrada");
    const orders = (await getAll("orders")).filter((row) => row.import_id === id);
    const activeImports = (await importsList()).filter((imp) => imp.status === ACTIVE && imp.id !== id);
    const activeOrders = await activeScopedOrders(activeImports.map((imp) => imp.id));
    const existing = new Set(activeOrders.map((row) => row.numero_os).filter(Boolean));
    const newOs = orders.filter((row) => row.numero_os && !existing.has(row.numero_os)).length;
    const updatedOs = orders.filter((row) => row.numero_os && existing.has(row.numero_os)).length;
    const units = groupCount(orders, "unidade", "unidade", "total_os");
    const suppliers = groupCount(orders, "fornecedor", "fornecedor", "total_os");
    return {
      ...item,
      period_start_label: item.period_start_label || dateLabel(item.period_start),
      period_end_label: item.period_end_label || dateLabel(item.period_end),
      decision_log: item.decision_log || [],
      conference: {
        dados_gerais: {
          linhas: orders.length,
          os_unicas: new Set(orders.map((row) => row.numero_os).filter(Boolean)).size,
          duplicidades_internas: item.duplicate_count || 0,
          ausencias: item.missing_required_count || 0,
          inconsistencias: item.inconsistency_count || 0,
          unidades: units.length,
          fornecedores: suppliers.length,
          usuarios_atendentes: new Set(orders.map((row) => row.responsavel_confirmacao).filter(Boolean)).size,
        },
        comparacao: {
          periodo_igual: false,
          periodo_sobreposto: activeImports.some((imp) => datesOverlap(item.period_start, item.period_end, imp.period_start, imp.period_end)),
          os_existentes: updatedOs,
          os_novas: newOs,
          os_atualizadas: updatedOs,
          os_mudaram_status: 0,
          os_nao_presentes_nova_importacao: 0,
          importacoes_impactadas: activeImports.filter((imp) => datesOverlap(item.period_start, item.period_end, imp.period_start, imp.period_end)),
        },
        alertas: [
          updatedOs ? `${updatedOs} OS já existem em importações anteriores.` : "",
          item.duplicate_count ? `${item.duplicate_count} OS duplicadas no arquivo.` : "",
          item.inconsistency_count ? `${item.inconsistency_count} inconsistência(s) entre status e datas.` : "",
        ].filter(Boolean),
        unidades: units.map((row) => ({ ...row, situacao: "Encontrada" })),
        fornecedores: suppliers,
      },
    };
  }

  function datesOverlap(a1, a2, b1, b2) {
    if (!a1 || !a2 || !b1 || !b2) return false;
    return new Date(a1) <= new Date(b2) && new Date(b1) <= new Date(a2);
  }

  async function decideImport(id, action) {
    const item = await getOne("imports", id);
    if (!item) throw new Error("Importação não encontrada");
    if (action === "replace") {
      const imports = await importsList();
      await Promise.all(imports.filter((imp) => imp.status === ACTIVE && datesOverlap(item.period_start, item.period_end, imp.period_start, imp.period_end))
        .map((imp) => updateOne("imports", imp.id, (row) => ({ ...row, status: "Substituída", active: false }))));
    }
    const status = action === "cancel" ? "Cancelada" : action === "deactivate" ? "Desconsiderada do cálculo" : action === "delete" ? "Excluída logicamente" : ACTIVE;
    await updateOne("imports", id, (row) => ({ ...row, status, active: status === ACTIVE, decision_log: [...(row.decision_log || []), { em: nowIso(), acao: action, status }] }));
    return { ok: true, import: await importDetails(id) };
  }

  async function activeScopedOrders(importIds = null) {
    const mode = await dataMode();
    const allowedSources = allowedSourcesForMode(mode);
    const imports = importIds
      ? await importsList().then((list) => list.filter((imp) => importIds.includes(imp.id)))
      : (await importsList()).filter((imp) => imp.status === ACTIVE && (imp.import_type || "Operacional") === "Operacional" && allowedSources.has(imp.source || "local"));
    const activeIds = new Set(imports.map((imp) => imp.id));
    const importsById = new Map(imports.map((imp) => [imp.id, imp]));
    const orders = (await getAll("orders")).filter((row) => activeIds.has(row.import_id));
    const latestByOs = new Map();
    for (const row of orders) {
      const key = row.numero_os || row.id;
      const current = latestByOs.get(key);
      const rowImport = importsById.get(row.import_id);
      const currentImport = current ? importsById.get(current.import_id) : null;
      const rowDate = rowImport?.period_end || rowImport?.imported_at || row.import_id;
      const currentDate = currentImport?.period_end || currentImport?.imported_at || current?.import_id || "";
      if (!current || String(rowDate).localeCompare(String(currentDate)) >= 0) {
        const first = current?.primeira_importacao || current?.import_id || row.import_id;
        latestByOs.set(key, {
          ...row,
          primeira_importacao: first,
          ultima_importacao: row.import_id,
          status_primeira_aparicao: current?.status_primeira_aparicao || current?.status_gerencial || row.status_gerencial,
          status_atual: row.status_gerencial,
          houve_atualizacao_status: current && current.status_gerencial !== row.status_gerencial ? "Sim" : (current?.houve_atualizacao_status || "Não"),
        });
      }
    }
    return [...latestByOs.values()];
  }

  function filterOrders(rows, params) {
    let out = [...rows];
    const from = params.get("date_from");
    const to = params.get("date_to");
    if (from) out = out.filter((row) => localDateKey(row.data_abertura) >= from);
    if (to) out = out.filter((row) => localDateKey(row.data_abertura) <= to);
    return out;
  }

  function groupCount(rows, key, labelKey = "label", valueKey = "total") {
    const map = new Map();
    for (const row of rows) {
      const value = label(row[key]);
      map.set(value, (map.get(value) || 0) + 1);
    }
    return [...map.entries()].map(([name, total]) => ({ [labelKey]: name, [valueKey]: total })).sort((a, b) => b[valueKey] - a[valueKey]);
  }

  function summarize(rows, groupKey) {
    const map = new Map();
    for (const row of rows) {
      const key = label(row[groupKey]);
      const item = map.get(key) || { label: key, total: 0, total_os_abertas: 0, coletas_agendadas: 0, confirmadas: 0, confirmacoes_manuais: 0, confirmacoes_mtr: 0, pendentes_confirmacao: 0, pendentes_operacionais: 0, sem_confirmacao_fornecedor_mtr: 0, agendadas_vencidas_sem_evidencia: 0, agenda_futura_no_prazo: 0, nao_realizadas: 0, precisam_acao: 0, alertas: 0 };
      item.total += 1;
      item.total_os_abertas += 1;
      if (row.data_agendada) item.coletas_agendadas += 1;
      if (isConfirmed(row)) item.confirmadas += 1;
      if (row.produtividade_manual === "Sim") item.confirmacoes_manuais += 1;
      if (row.origem_confirmacao === "Confirmada pelo fornecedor via MTR") item.confirmacoes_mtr += 1;
      if (isPending(row)) item.pendentes_confirmacao += 1;
      if (isPending(row)) item.pendentes_operacionais += 1;
      if (row.origem_confirmacao !== "Confirmada pelo fornecedor via MTR") item.sem_confirmacao_fornecedor_mtr += 1;
      if (isPending(row) && row.status_gerencial === "Em atraso") item.agendadas_vencidas_sem_evidencia += 1;
      if (isPending(row) && row.status_gerencial !== "Em atraso") item.agenda_futura_no_prazo += 1;
      if (row.status_gerencial === "Não realizada") item.nao_realizadas += 1;
      if (row.precisa_acao === "Sim") item.precisam_acao += 1;
      if (row.inconsistencias) item.alertas += 1;
      map.set(key, item);
    }
    return [...map.values()].sort((a, b) => b.pendentes_confirmacao - a.pendentes_confirmacao || b.total - a.total);
  }

  function unitSummary(rows) {
    return summarize(rows, "unidade").map((row) => ({ ...row, unidade: row.label, responsavel_operacional: "Não definido", grupo_contratual_codigo: "", grupo_contratual_nome: "Não identificado", grupo_contratual_fonte: "" }));
  }

  function periodLabel(start, end) {
    return `${dateLabel(start)} a ${dateLabel(end)}`;
  }

  function monthName(date) {
    return date.toLocaleDateString("pt-BR", { month: "2-digit", year: "numeric" });
  }

  function addMonths(date, amount) {
    return new Date(date.getFullYear(), date.getMonth() + amount, date.getDate());
  }

  function cycleEndFromStart(start, endDay) {
    const monthOffset = start.getDate() > Number(endDay) ? 1 : 0;
    return new Date(start.getFullYear(), start.getMonth() + monthOffset, Number(endDay));
  }

  function generateCyclesForCalendar(calendar) {
    const cliente = calendar.cliente || "Cliente não informado";
    const startDay = Number(calendar.dia_inicial || calendar.start_day || 1);
    const endDay = Number(calendar.dia_final || calendar.end_day || 31);
    const firstStart = new Date(2026, 1, startDay);
    const cycles = [];
    const baselineStart = new Date(2026, 1, startDay);
    const baselineEnd = new Date(2026, 3, endDay);
    cycles.push({
      id: `${calendar.id || strip(cliente)}-baseline`,
      cliente,
      name: "Baseline",
      start_date: baselineStart.toISOString(),
      end_date: baselineEnd.toISOString(),
      start_label: dateLabel(baselineStart.toISOString()),
      end_label: dateLabel(baselineEnd.toISOString()),
      status: "Planejada",
      observations: "Período histórico de referência.",
    });
    for (let i = 2; i <= 7; i += 1) {
      const start = addMonths(firstStart, i);
      const end = cycleEndFromStart(start, endDay);
      cycles.push({
        id: `${calendar.id || strip(cliente)}-${start.toISOString().slice(0, 10)}`,
        cliente,
        name: `Competência ${monthName(start)}`,
        start_date: start.toISOString(),
        end_date: end.toISOString(),
        start_label: dateLabel(start.toISOString()),
        end_label: dateLabel(end.toISOString()),
        status: "Planejada",
        observations: "",
      });
    }
    return cycles;
  }

  function waveLinkMatchesOrder(link, row) {
    const unit = strip(row.unidade);
    const linkUnit = strip(link.unidade);
    const code = strip(link.codigo_unidade);
    return Boolean((linkUnit && unit.includes(linkUnit)) || (code && unit.includes(code)));
  }

  function waveRows(rows, links) {
    return rows.filter((row) => links.some((link) => waveLinkMatchesOrder(link, row)));
  }

  function findWaveLink(row, links) {
    return links.find((link) => waveLinkMatchesOrder(link, row));
  }

  function supplierMain(rows) {
    return groupCount(rows, "fornecedor", "fornecedor", "total_os")[0]?.fornecedor || "";
  }

  function dateRangeForRows(rows) {
    const dates = rows.map((row) => row.data_abertura).filter(Boolean).sort();
    return {
      primeira_data: dates[0] || "",
      ultima_data: dates[dates.length - 1] || "",
      primeira_data_label: dateLabel(dates[0]),
      ultima_data_label: dateLabel(dates[dates.length - 1]),
    };
  }

  function unitWaveRows(rows, links, wavesById) {
    const byUnit = new Map();
    for (const row of rows) {
      const key = label(row.unidade);
      if (!byUnit.has(key)) byUnit.set(key, []);
      byUnit.get(key).push(row);
    }
    return [...byUnit.entries()].map(([unidade, unitRows]) => {
      const link = findWaveLink(unitRows[0], links);
      const wave = link ? wavesById.get(link.onda_id) : null;
      const confirmed = unitRows.filter(isConfirmed).length;
      const pending = unitRows.filter(isPending).length;
      return {
        cliente: unitRows[0]?.grupo_contratual_nome || unitRows[0]?.cliente || "",
        unidade,
        total_os: unitRows.length,
        ...dateRangeForRows(unitRows),
        confirmacoes: confirmed,
        confirmacoes_atendente: unitRows.filter((row) => row.produtividade_manual === "Sim").length,
        confirmacoes_mtr: unitRows.filter((row) => row.origem_confirmacao === "Confirmada pelo fornecedor via MTR").length,
        pendencias_contingencia: pending,
        atendente_responsavel: unitRows[0]?.responsavel_abertura || "",
        atendente_relacionado: unitRows[0]?.responsavel_abertura || "",
        fornecedor_principal: supplierMain(unitRows),
        onda_id: link?.onda_id || "",
        onda_vinculada: wave ? wave.name : "",
        status_unidade_onda: link?.status || "",
        situacao: link ? "vinculada" : "sem_onda",
        historico_vinculos: link ? 1 : 0,
      };
    }).sort((a, b) => b.pendencias_contingencia - a.pendencias_contingencia || b.total_os - a.total_os);
  }

  async function wavesSummary(path = "/api/waves") {
    const params = new URL(path, location.href).searchParams;
    const includeUnits = params.get("include_units") === "1";
    const { waves, unitLinks } = await officialConfig();
    const activeLinks = unitLinks.filter((link) => strip(link.status || "ativa") !== "INATIVA");
    const wavesById = new Map(waves.map((wave) => [wave.id, {
      ...wave,
      name: wave.nome || wave.name || "",
      wave_number: wave.numero || wave.wave_number || "",
      start_date: wave.data_inicio || wave.start_date || "",
      planned_end_date: wave.data_fim_prevista || wave.planned_end_date || "",
      objective: wave.objetivo || wave.objective || "",
      observations: wave.observacoes || wave.observations || "",
    }]));
    if (!includeUnits) {
      const lightWaves = [...wavesById.values()].map((wave) => {
        const links = activeLinks.filter((link) => link.onda_id === wave.id);
        return {
          ...wave,
          cliente: wave.cliente || "Não informado",
          status: wave.status || "planejada",
          competency_start_date: wave.data_inicio || wave.start_date || "",
          competency_end_date: wave.data_fim_prevista || wave.planned_end_date || "",
          baseline_status: "Planejado",
          unidades: links.length,
          unidades_ativas: links.length,
          unidades_planejadas: links.length,
          unidades_fora_escopo: 0,
          progresso: 0,
          total_os: 0,
          confirmacoes_atendente: 0,
          confirmacoes_mtr: 0,
          pendencias_contingencia: 0,
          nao_realizadas: 0,
          precisam_acao: 0,
          unidades_com_os: 0,
          cobertura_confirmacao: 0,
        };
      });
      return {
        waves: lightWaves,
        units: [],
        units_total: activeLinks.length,
        unlinked_units: [],
        unlinked_units_total: 0,
        out_of_scope_units: [],
        out_of_scope_units_total: 0,
        options: lightWaves.map((wave) => ({ id: wave.id, label: `${wave.wave_number ? `Onda ${wave.wave_number} · ` : ""}${wave.name}` })),
      };
    }
    const rows = await activeScopedOrders();
    const normalizedWaves = [...wavesById.values()].map((wave) => {
      const links = activeLinks.filter((link) => link.onda_id === wave.id);
      const scopedRows = waveRows(rows, links);
      const manual = scopedRows.filter((row) => row.produtividade_manual === "Sim").length;
      const mtr = scopedRows.filter((row) => row.origem_confirmacao === "Confirmada pelo fornecedor via MTR").length;
      const pending = scopedRows.filter(isPending).length;
      const notDone = scopedRows.filter((row) => row.status_gerencial === "Não realizada").length;
      const confirmed = manual + mtr;
      const total = scopedRows.length;
      return {
        ...wave,
        cliente: wave.cliente || "Não informado",
        status: wave.status || "planejada",
        competency_start_date: wave.data_inicio || wave.start_date || "",
        competency_end_date: wave.data_fim_prevista || wave.planned_end_date || "",
        baseline_status: "Planejado",
        unidades: links.length,
        unidades_ativas: links.length,
        unidades_planejadas: links.length,
        unidades_fora_escopo: 0,
        progresso: links.length ? Math.round((scopedRows.length ? links.length : 0) / links.length * 100) : 0,
        total_os: total,
        confirmacoes_atendente: manual,
        confirmacoes_mtr: mtr,
        pendencias_contingencia: pending,
        nao_realizadas: notDone,
        precisam_acao: scopedRows.filter((row) => row.precisa_acao === "Sim").length,
        unidades_com_os: new Set(scopedRows.map((row) => row.unidade).filter(Boolean)).size,
        cobertura_confirmacao: total ? Math.round((confirmed / total) * 1000) / 10 : 0,
      };
    });
    const units = unitWaveRows(rows, activeLinks, wavesById);
    const unlinked = units.filter((row) => !row.onda_id);
    const outOfScope = units.filter((row) => row.onda_id && !wavesById.has(row.onda_id));
    return {
      waves: normalizedWaves,
      units: includeUnits ? units : [],
      units_total: units.length,
      unlinked_units: includeUnits ? unlinked.slice(0, 1000) : [],
      unlinked_units_total: unlinked.length,
      out_of_scope_units: includeUnits ? outOfScope.slice(0, 1000) : [],
      out_of_scope_units_total: outOfScope.length,
      options: normalizedWaves.map((wave) => ({ id: wave.id, label: `${wave.wave_number ? `Onda ${wave.wave_number} · ` : ""}${wave.name}` })),
    };
  }

  function unitSupplier(rows) {
    const map = new Map();
    for (const row of rows) {
      const key = `${label(row.unidade)}||${label(row.fornecedor)}`;
      const item = map.get(key) || { unidade: label(row.unidade), fornecedor: label(row.fornecedor), total: 0, total_os_abertas: 0, coletas_agendadas: 0, total_confirmadas: 0, confirmacoes_manuais: 0, confirmacoes_mtr: 0, pendentes_confirmacao_fornecedor: 0, pendentes_confirmacao: 0, agendadas_vencidas_sem_evidencia: 0, agenda_futura_no_prazo: 0, nao_realizadas: 0, precisam_acao: 0, grupo_contratual_codigo: row.grupo_contratual_codigo, grupo_contratual_nome: row.grupo_contratual_nome };
      item.total += 1; item.total_os_abertas += 1;
      if (row.data_agendada) item.coletas_agendadas += 1;
      if (isConfirmed(row)) item.total_confirmadas += 1;
      if (row.produtividade_manual === "Sim") item.confirmacoes_manuais += 1;
      if (row.origem_confirmacao === "Confirmada pelo fornecedor via MTR") item.confirmacoes_mtr += 1;
      if (row.origem_confirmacao !== "Confirmada pelo fornecedor via MTR") item.pendentes_confirmacao_fornecedor += 1;
      if (isPending(row)) item.pendentes_confirmacao += 1;
      if (isPending(row) && row.status_gerencial === "Em atraso") item.agendadas_vencidas_sem_evidencia += 1;
      if (isPending(row) && row.status_gerencial !== "Em atraso") item.agenda_futura_no_prazo += 1;
      if (row.status_gerencial === "Não realizada") item.nao_realizadas += 1;
      if (row.precisa_acao === "Sim") item.precisam_acao += 1;
      map.set(key, item);
    }
    return [...map.values()].sort((a, b) => b.pendentes_confirmacao - a.pendentes_confirmacao || b.total - a.total).slice(0, 700);
  }

  async function coverageHistory() {
    const mode = await dataMode();
    const allowedSources = allowedSourcesForMode(mode);
    const imports = (await importsList()).filter((item) => item.status === ACTIVE && ["Operacional", "Baseline"].includes(item.import_type || "Operacional") && allowedSources.has(item.source || "local"));
    const allOrders = await getAll("orders");
    return imports.map((imp) => {
      const rows = allOrders.filter((row) => row.import_id === imp.id);
      const scheduled = rows.filter((row) => row.data_agendada).length;
      const confirmed = rows.filter((row) => row.produtividade_manual === "Sim" || row.origem_confirmacao === "Confirmada pelo fornecedor via MTR").length;
      return {
        import_id: imp.id,
        label: `${imp.period_start_label || dateLabel(imp.period_start)} a ${imp.period_end_label || dateLabel(imp.period_end)}`,
        taxa: scheduled ? Math.round((confirmed / scheduled) * 1000) / 10 : 0,
        total: rows.length,
      };
    }).filter((row) => row.total > 0);
  }

  function metricSnapshot(rows) {
    const total = rows.length;
    const manual = rows.filter((row) => row.produtividade_manual === "Sim").length;
    const mtr = rows.filter((row) => row.origem_confirmacao === "Confirmada pelo fornecedor via MTR").length;
    const pending = rows.filter(isPending).length;
    const notDone = rows.filter((row) => row.status_gerencial === "Não realizada").length;
    const confirmed = manual + mtr;
    return {
      total,
      confirmadas: confirmed,
      confirmacoes_atendente: manual,
      confirmacoes_mtr: mtr,
      pendencias_contingencia: pending,
      nao_realizadas: notDone,
      cobertura: total ? Math.round((confirmed / total) * 1000) / 10 : 0,
    };
  }

  async function baselineComparison(currentRows) {
    const imports = await importsList();
    const baselineImports = imports.filter((imp) => imp.status === ACTIVE && (imp.import_type || "") === "Baseline");
    if (!baselineImports.length) return null;
    const baselineIds = new Set(baselineImports.map((imp) => imp.id));
    const baselineRows = (await getAll("orders")).filter((row) => baselineIds.has(row.import_id));
    if (!baselineRows.length || !currentRows.length) return null;
    const baseline = metricSnapshot(baselineRows);
    const current = metricSnapshot(currentRows);
    return {
      baseline,
      current,
      baseline_label: `${baselineImports[0].period_start_label || dateLabel(baselineImports[0].period_start)} a ${baselineImports[0].period_end_label || dateLabel(baselineImports[0].period_end)}`,
      current_label: "Período atual",
      variation_pp: Math.round((current.cobertura - baseline.cobertura) * 10) / 10,
      variation_attendant: current.confirmacoes_atendente - baseline.confirmacoes_atendente,
      variation_mtr: current.confirmacoes_mtr - baseline.confirmacoes_mtr,
      variation_pending: current.pendencias_contingencia - baseline.pendencias_contingencia,
    };
  }

  async function dashboard(path) {
    const params = new URL(path, location.href).searchParams;
    const importId = params.get("import_id") || "latest";
    const imports = await importsList();
    const mode = await dataMode();
    let rows;
    let imp;
    if ((params.get("date_from") || params.get("date_to"))) {
      rows = filterOrders(await activeScopedOrders(), params);
      imp = { id: "date-range", file_name: sourceLabel(mode), source_mode: mode, source_label: sourceLabel(mode), period_start: params.get("date_from") || "", period_end: params.get("date_to") || "", period_start_label: dateLabel(params.get("date_from")), period_end_label: dateLabel(params.get("date_to")), row_count: rows.length, unique_os_count: new Set(rows.map((r) => r.numero_os)).size, inconsistency_count: rows.filter((r) => r.inconsistencias).length, warning_count: 0 };
    } else if (importId === "latest") {
      rows = await activeScopedOrders();
      const operational = imports.filter((item) => item.status === ACTIVE && (item.import_type || "Operacional") === "Operacional" && allowedSourcesForMode(mode).has(item.source || "local"));
      const starts = operational.map((item) => item.period_start).filter(Boolean).sort();
      const ends = operational.map((item) => item.period_end).filter(Boolean).sort();
      imp = {
        id: "latest",
        file_name: sourceLabel(mode),
        source_mode: mode,
        source_label: sourceLabel(mode),
        period_start: starts[0] || "",
        period_end: ends[ends.length - 1] || "",
        period_start_label: dateLabel(starts[0]),
        period_end_label: dateLabel(ends[ends.length - 1]),
        row_count: rows.length,
        unique_os_count: new Set(rows.map((r) => r.numero_os)).size,
        inconsistency_count: rows.filter((r) => r.inconsistencias).length,
        warning_count: 0,
      };
    } else {
      imp = imports.find((item) => item.id === importId);
      if (!imp) return { has_data: false };
      rows = (await getAll("orders")).filter((row) => row.import_id === imp.id);
    }
    const total = rows.length;
    const scheduled = rows.filter((r) => r.data_agendada).length;
    const manual = rows.filter((r) => r.produtividade_manual === "Sim").length;
    const mtr = rows.filter((r) => r.origem_confirmacao === "Confirmada pelo fornecedor via MTR").length;
    const confirmed = manual + mtr;
    const pending = rows.filter(isPending).length;
    const realizedConfirmed = rows.filter(isConfirmed).length;
    const attendantBase = Math.max(0, scheduled - mtr);
    return {
      has_data: true,
      analysis: { mode: "static", data_mode: mode, source_label: sourceLabel(mode), date_ref: "abertura", rule_version: RULE_VERSION },
      import: { ...imp, source_mode: mode, source_label: sourceLabel(mode), period_start_label: imp.period_start_label || dateLabel(imp.period_start), period_end_label: imp.period_end_label || dateLabel(imp.period_end) },
      period_buckets: { backlog_anterior: 0, coletas_periodo: total, agenda_futura: 0 },
      kpis: {
        total_os: total,
        os_unicas: new Set(rows.map((r) => r.numero_os).filter(Boolean)).size,
        coletas_agendadas: scheduled,
        realizadas_confirmadas: realizedConfirmed,
        pendentes_confirmacao: pending,
        agendadas_vencidas_sem_evidencia: rows.filter((r) => isPending(r) && r.status_gerencial === "Em atraso").length,
        agenda_futura_no_prazo: rows.filter((r) => isPending(r) && r.status_gerencial !== "Em atraso").length,
        confirmacoes_manuais: manual,
        confirmacoes_mtr: mtr,
        precisam_acao: rows.filter((r) => r.precisa_acao === "Sim").length,
        inconsistencias: rows.filter((r) => r.inconsistencias).length,
        taxa_confirmacao: total ? Math.round((realizedConfirmed / total) * 1000) / 10 : 0,
        taxa_confirmacao_total: scheduled ? Math.round((confirmed / scheduled) * 1000) / 10 : 0,
        taxa_confirmacao_manual: attendantBase ? Math.round((manual / attendantBase) * 1000) / 10 : 0,
        backlog_anterior: 0,
        coletas_periodo: total,
        agenda_futura: 0,
      },
      charts: {
        status_gerencial: groupCount(rows, "status_gerencial"),
        status_operacional: groupCount(rows, "status_operacional"),
        status_confirmacao: groupCount(rows, "status_confirmacao"),
        origem_os: groupCount(rows, "origem_os"),
        origem_confirmacao: groupCount(rows, "origem_confirmacao"),
        atendentes: groupCount(rows.filter((r) => r.produtividade_manual === "Sim"), "responsavel_confirmacao"),
        aberturas: groupCount(rows, "responsavel_abertura"),
        fornecedores: groupCount(rows, "fornecedor"),
        unidades: groupCount(rows, "unidade"),
        residuos: groupCount(rows, "tipo_residuo"),
        motivos: groupCount(rows, "motivo_nao_realizacao"),
        coverage_history: await coverageHistory(),
        baseline_comparison: await baselineComparison(rows),
      },
      performance: {
        atendentes: summarize(rows.filter((r) => r.produtividade_manual === "Sim"), "responsavel_confirmacao"),
        aberturas: summarize(rows, "responsavel_abertura"),
        fornecedores: summarize(rows, "fornecedor").slice(0, 50),
        atendentes_executivo: summarize(rows, "responsavel_abertura").map((r) => ({ ...r, atendente: r.label, total_os: r.total, coletas_carteira: r.coletas_agendadas, confirmacoes_atendente: r.confirmacoes_manuais, confirmacoes_mtr: r.confirmacoes_mtr, pendencias_contingencia: r.pendentes_confirmacao, unidades: 0, clientes: 0, fornecedores: 0 })),
        responsaveis_operacionais: summarize(rows, "responsavel_abertura"),
        colaborador_unidade: summarize(rows.filter((r) => r.produtividade_manual === "Sim"), "responsavel_confirmacao").map((r) => ({ colaborador: r.label, unidade: "Todas", confirmacoes_manuais: r.confirmacoes_manuais, realizadas_confirmadas: r.confirmadas, precisam_acao: r.precisam_acao, alertas: r.alertas })),
        colaborador_unidade_fornecedor: unitSupplier(rows),
        unidades: unitSummary(rows).slice(0, 700),
        pendencias_unidade: rows.filter(isPending).slice(0, 500),
        pendentes_confirmacao_unidade: rows.filter(isPending).slice(0, 500),
      },
    };
  }

  async function defaultMeasurement() {
    const { calendars, waves } = await officialConfig();
    const imports = await importsList();
    const normalizedCalendars = calendars.map((row) => ({
      id: row.id,
      cliente: row.cliente,
      cycle_type: row.tipo_ciclo || row.cycle_type,
      start_day: row.dia_inicial || row.start_day,
      end_day: row.dia_final || row.end_day,
      rule_description: row.descricao || row.rule_description,
      status: strip(row.status) === "ATIVO" ? "Ativo" : "Inativo",
    }));
    const cycles = normalizedCalendars.flatMap(generateCyclesForCalendar);
    const baselines = imports.filter((item) => (item.import_type || "") === "Baseline").map((item) => {
      const wave = waves.find((row) => strip(row.observacoes).includes("PR01") || strip(row.nome).includes("PILOTO")) || waves[0];
      return {
        id: `baseline-${item.id}`,
        name: item.file_name || item.nome || "Baseline",
        scope_type: item.cliente && item.cliente !== "Todos" ? "Cliente" : "Projeto",
        cliente: item.cliente || "Todos",
        period_start: item.period_start,
        period_end: item.period_end,
        period_start_label: item.period_start_label || dateLabel(item.period_start),
        period_end_label: item.period_end_label || dateLabel(item.period_end),
        wave_number: wave?.numero || "",
        wave_name: wave?.nome || "",
        import_file: item.file_name,
        import_id: item.id,
        status: item.status === ACTIVE ? "Disponível" : item.status,
      };
    });
    return { calendars: normalizedCalendars, cycles, baselines };
  }

  async function importClientBase(file) {
    const rows = await readWorkbookRows(file);
    const importId = uid("clientes");
    const units = rows.map((row, idx) => {
      const groupRaw = text(row["Grupo Contratual"] || row["Código Grupo Contratual"] || row.Grupo || "");
      const codeMatch = groupRaw.match(/^\s*(\d+)/);
      const name = text(row["Nome Grupo Contratual"] || row["Nome do Grupo Contratual"] || row["Grupo Contratual Nome"] || groupRaw.replace(/^\d+\s*[-–]?\s*/, ""));
      const cliente = text(row.Cliente || row["Nome/Razão Social"] || row["Nome/Razão Social Gerador"] || row["Nome Resumido"]);
      const unidade = text(row["Nome Fantasia"] || row.Unidade || row.Estabelecimento || row["Nome Resumido"] || cliente);
      return {
        id: `${importId}-${idx}`,
        import_id: importId,
        source: "local",
        grupo_contratual_codigo: codeMatch ? codeMatch[1] : "",
        grupo_contratual_nome: name || "Não identificado",
        cliente,
        codigo_cliente: text(row["Código Cliente"] || row["Codigo Cliente"]),
        cliente_documento: shortDoc(row["CPF/CNPJ"] || row.CNPJ || row.Documento),
        unidade,
        unidade_chave: strip(unidade),
        cliente_chave: strip(cliente),
        endereco: text(row["Endereço"] || row.Endereco || row.Logradouro),
        cidade: text(row.Cidade || row["Município"] || row["Munícipio"]),
        uf: text(row.UF || row.Estado),
        status: text(row.Status) || "Ativo",
      };
    }).filter((row) => row.cliente || row.unidade || row.grupo_contratual_nome !== "Não identificado");
    await putMany("clientImports", [{ id: importId, source: "local", file_name: file.name, imported_at: nowIso(), row_count: rows.length, valid_count: units.length, unidentified_count: units.filter((u) => u.grupo_contratual_nome === "Não identificado").length, status: "Ativa" }]);
    await putMany("clientUnits", units);
    return { ok: true };
  }

  async function clientBase() {
    const imports = await getAll("clientImports");
    const units = await getAll("clientUnits");
    const groupMap = new Map();
    for (const row of units) {
      const key = `${row.grupo_contratual_codigo}|${row.grupo_contratual_nome}`;
      const item = groupMap.get(key) || { codigo: row.grupo_contratual_codigo, nome: row.grupo_contratual_nome, unidades: 0 };
      item.unidades += 1;
      groupMap.set(key, item);
    }
    return { imports, units: units.slice(0, 1000), groups: [...groupMap.values()] };
  }

  async function dataSourceSummary() {
    const imports = await importsList();
    const orders = await getAll("orders");
    const clientImports = await getAll("clientImports");
    const clientUnits = await getAll("clientUnits");
    const mode = await dataMode();
    const meta = await getOne("meta", "officialLoaded").catch(() => null);
    const matchedByClientBase = orders.filter((row) => row.grupo_contratual_fonte === "Base de Clientes / Grupos Contratuais").length;
    const plausibleUser = (value) => {
      const raw = text(value);
      const v = strip(raw);
      return raw && !isSystemUser(raw) && raw !== "Fornecedor via MTR" && raw !== "Robô Programada" && raw !== "Atendente não identificado"
        && !/\d{2}\.\d{3}\.\d{3}\//.test(raw) && !/\d{8,}/.test(raw)
        && !/(ADMINISTRADOR ADMIN| LTDA| S\/A| SOCIEDADE| COMERCIO| TRANSPORTE| RESIDUOS| AMBIENTAL| AMBIENSYS| CNPJ)/.test(v);
    };
    const humanUsers = new Set(orders.flatMap((row) => [row.responsavel_confirmacao, row.responsavel_abertura])
      .filter(plausibleUser));
    const systemIgnored = orders.filter((row) => [row.usuario_realizada, row.usuario_responsavel, row.atendente_vinculado, row.responsavel_confirmacao, row.responsavel_abertura].some((value) => text(value) && isSystemUser(value))).length;
    const { waves, unitLinks } = await officialConfig();
    const waveDiag = await wavesSummary("/api/waves?include_units=1");
    return {
      mode,
      source_label: sourceLabel(mode),
      official_loaded_at: meta?.loaded_at || "",
      origin: mode === "official" ? "Repositório GitHub" : mode === "official-local" ? "Repositório GitHub + Cache local" : "Cache local",
      diagnostics: {
        arquivos_carregados: imports.length + clientImports.length,
        os_lidas: orders.length,
        os_unicas: new Set(orders.map((row) => row.numero_os).filter(Boolean)).size,
        clientes: {
          importacoes: clientImports.length,
          linhas_lidas: clientImports.reduce((sum, row) => sum + Number(row.row_count || 0), 0),
          unidades_cadastrais: clientUnits.length,
          unidades_os_com_match: matchedByClientBase,
          unidades_os_sem_match: Math.max(0, orders.length - matchedByClientBase),
          campos_mapeados: clientUnits[0]?.campos_mapeados || ["Grupo Contratual", "Código Cliente", "CPF/CNPJ", "Nome/Razão Social", "Nome Resumido", "Status", "Endereço", "Munícipio", "UF"],
        },
        usuarios: {
          humanos_encontrados: humanUsers.size,
          lista: [...humanUsers].sort(),
          sistemicos_ignorados: systemIgnored,
          os_sem_usuario: orders.filter((row) => row.responsavel_abertura === "Atendente não identificado" || row.responsavel_confirmacao === "Atendente não identificado").length,
        },
        ondas: {
          ondas_configuradas: waves.length,
          vinculos_configurados: unitLinks.length,
          onda_0_unidades: unitLinks.filter((row) => row.onda_id === "onda-0-pr01").length,
          onda_1_unidades: unitLinks.filter((row) => row.onda_id === "onda-1-ampliacao").length,
          unidades_sem_onda: waveDiag.unlinked_units_total,
          os_por_onda: waveDiag.waves.map((wave) => ({ id: wave.id, nome: wave.name, unidades: wave.unidades, os: wave.total_os, cobertura: wave.cobertura_confirmacao })),
        },
      },
      imports: imports.map((imp) => {
        const rows = orders.filter((row) => row.import_id === imp.id);
        const byOs = new Map();
        let changed = 0;
        for (const row of rows) {
          const prev = byOs.get(row.numero_os);
          if (prev && prev.status_gerencial !== row.status_gerencial) changed += 1;
          byOs.set(row.numero_os, row);
        }
        return {
          id: imp.id,
          arquivo: imp.file_name,
          caminho: imp.official_path || "",
          tipo: imp.import_type || imp.tipo,
          source: imp.source || "local",
          periodo: `${imp.period_start_label || dateLabel(imp.period_start)} a ${imp.period_end_label || dateLabel(imp.period_end)}`,
          status: imp.status,
          os_lidas: rows.length,
          os_unicas: new Set(rows.map((row) => row.numero_os).filter(Boolean)).size,
          os_atualizadas: 0,
          mudanca_status: changed,
        };
      }),
      client_imports: clientImports.map((item) => ({
        id: item.id,
        arquivo: item.file_name,
        source: item.source || "local",
        tipo: "cadastro_clientes",
        linhas_lidas: item.row_count || 0,
        unidades_identificadas: item.valid_count || 0,
        status: item.status,
      })),
    };
  }

  async function exportLocalAnalysis() {
    return {
      exported_at: nowIso(),
      imports: (await getAll("imports")).filter((row) => row.source === "local"),
      orders: (await getAll("orders")).filter((row) => row.source === "local"),
    };
  }

  async function staticApi(path, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    const params = new URL(path, location.href).searchParams;
    const lightweight = path.startsWith("/api/data-mode")
      || path.startsWith("/api/measurement")
      || (path.startsWith("/api/waves") && params.get("include_units") !== "1" && method === "GET");
    if (!lightweight) await loadOfficialBase(false);
    if (path.startsWith("/api/data-source")) return dataSourceSummary();
    if (path.startsWith("/api/data-mode")) {
      if (method === "POST") {
        const payload = JSON.parse(options.body || "{}");
        return setDataMode(payload.mode || "official");
      }
      const mode = await dataMode();
      return { mode, label: sourceLabel(mode) };
    }
    if (path.startsWith("/api/reload-official")) {
      await loadOfficialBase(true);
      await setDataMode("official");
      return { ok: true, source: await dataSourceSummary() };
    }
    if (path.startsWith("/api/local-analysis/clear")) {
      await deleteWhere("imports", (row) => row.source === "local");
      await deleteWhere("orders", (row) => row.source === "local");
      await setDataMode("official");
      return { ok: true };
    }
    if (path.startsWith("/api/local-analysis/export")) return exportLocalAnalysis();
    if (path.startsWith("/api/measurement")) return defaultMeasurement();
    if (path.startsWith("/api/waves") && method === "POST") return { ok: true };
    if (path.startsWith("/api/waves")) return wavesSummary(path);
    if (path === "/api/imports") return { imports: await importsList() };
    if (path.startsWith("/api/imports/") && method === "GET") return importDetails(path.split("/").pop());
    if (path.startsWith("/api/imports/") && method === "POST") {
      const parts = path.split("/");
      return decideImport(parts[3], parts[4]);
    }
    if (path.startsWith("/api/dashboard")) return dashboard(path);
    if (path.startsWith("/api/orders/") && method === "GET") return getOne("orders", path.split("/").pop());
    if (path.startsWith("/api/orders")) {
      const params = new URL(path, location.href).searchParams;
      const requestedImportId = params.get("import_id");
      let rows = requestedImportId === "latest" || !requestedImportId
        ? await activeScopedOrders()
        : (await getAll("orders")).filter((row) => row.import_id === requestedImportId);
      const search = strip(params.get("search"));
      if (search) rows = rows.filter((row) => strip(Object.values(row).join(" ")).includes(search));
      return { rows: rows.slice(0, Number(params.get("limit") || 500)) };
    }
    if (path === "/api/import" && method === "POST") return importOrders(options.body.get("file"), options.body.get("mode") || "local-only");
    if (path === "/api/client-base") return clientBase();
    if (path === "/api/client-base/import" && method === "POST") return importClientBase(options.body.get("file"));
    throw new Error(`Rota estática não implementada: ${path}`);
  }

  window.sigraStaticApi = staticApi;
})();



