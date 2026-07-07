let currentImportId = "latest";
let dashboardData = null;
let currentOrders = [];
let sortState = { key: "", dir: "asc" };
let dateFilter = { from: "", to: "" };

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function fmtDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("pt-BR");
}

function fmtDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("pt-BR");
}

function showAlert(message, type = "info") {
  const box = $("#alerts");
  box.textContent = message;
  box.classList.remove("hidden");
  box.style.borderLeftColor = type === "error" ? "#b42318" : "#b56a00";
}

function hideAlert() {
  $("#alerts").classList.add("hidden");
}

async function api(path, options) {
  const response = await fetch(path, options);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(payload.error || "Erro na solicitação");
  return payload;
}

function activateView(view) {
  $$(".nav").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $$(".view").forEach((section) => section.classList.toggle("active", section.id === view));
}

function applySidebarState() {
  const collapsed = localStorage.getItem("sigraSidebarCollapsed") === "true";
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  const button = $("#sidebarToggle");
  if (button) {
    button.setAttribute("aria-label", collapsed ? "Expandir menu lateral" : "Recolher menu lateral");
    button.title = collapsed ? "Expandir menu lateral" : "Recolher menu lateral";
  }
}

function renderKpis(kpis = {}) {
  const total = Number(kpis.coletas_agendadas ?? kpis.total_os ?? 0);
  const confirmed = Number(kpis.confirmacoes_manuais ?? 0) + Number(kpis.confirmacoes_mtr ?? 0);
  const coverage = pct(confirmed, total);
  const items = [
    ["OK", "% de Coletas Confirmadas", `${coverage}%`, `${confirmed} coletas confirmadas de ${total} consideradas`, "good"],
    ["AT", "Confirmações do Atendente", kpis.confirmacoes_manuais ?? 0, "Ação direta de usuário humano/atendente", "blue"],
    ["MTR", "Fornecedor via MTR", kpis.confirmacoes_mtr ?? 0, "Confirmações feitas pelo link da MTR", "green"],
    ["!", "Pendências de Contingência", kpis.pendentes_confirmacao ?? 0, "Sem fornecedor via MTR e sem atendente", "warn"],
    ["OS", "OS no período", kpis.coletas_agendadas ?? kpis.total_os ?? 0, "Ordens de serviço consideradas no filtro", "neutral"],
    ["A", "Precisam de ação", kpis.precisam_acao ?? 0, "Pendências, vencidas e inconsistências críticas", "danger"],
    ["UN", "Unidades no escopo", dashboardData?.charts?.unidades?.length ?? 0, "Unidades encontradas no período filtrado", "blue"],
    ["+", "Evolução vs baseline", "Baseline não definido", "Cadastre o baseline para medir variação", "neutral"],
  ];
  $("#kpiGrid").innerHTML = items.map(([icon, label, value, detail, tone]) => `
    <article class="kpi ${tone}">
      <b>${icon}</b>
      <span>${label}</span>
      <strong>${value}</strong>
      <small>${detail}</small>
    </article>
  `).join("");
  renderOverviewComposition(kpis);
  renderOverviewPriorities(kpis);
}

function renderBars(selector, rows = []) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  const html = rows.length ? rows.map((row) => {
    const width = Math.max(4, Math.round((row.value / max) * 100));
    return `
      <div class="bar-row" title="${row.label}">
        <span>${row.label || "Não informado"}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
        <strong>${row.value}</strong>
      </div>
    `;
  }).join("") : `<p>Nenhum dado importado.</p>`;
  $(selector).innerHTML = html;
}

function performanceClass(rate, pending = 0) {
  const value = Number(rate) || 0;
  if (pending > 0 || value < 70) return "is-bad";
  if (value < 85) return "is-mid";
  return "is-good";
}

function performanceLabel(klass) {
  if (klass === "is-good") return "Bom";
  if (klass === "is-mid") return "Atenção";
  return "Crítico";
}

function supplierClass(row) {
  const rate = Number(pct(row.confirmacoes_mtr, row.coletas_agendadas || row.total));
  if (rate >= 80) return "is-good";
  if (rate >= 50) return "is-mid";
  return "is-bad";
}

function supplierBucket(row) {
  const klass = supplierClass(row);
  if (klass === "is-good") return "good";
  if (klass === "is-mid") return "attention";
  return "critical";
}

function supplierRecommendation(row) {
  const rate = Number(pct(row.confirmacoes_mtr, row.coletas_agendadas || row.total));
  if (Number(row.pendentes_confirmacao || 0) === 0) return "Manter rotina";
  if (rate < 50) return "Acionar fornecedor";
  if (rate < 80) return "Reforçar rotina MTR";
  return "Monitorar";
}

function shortSupplierName(label = "") {
  return label
    .replace(/^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\s*-\s*/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function renderPerformance(selector, rows = []) {
  $(selector).innerHTML = rows.map((row) => `
    <tr class="${performanceClass(pct(row.confirmadas, row.coletas_agendadas), row.pendentes_confirmacao)}">
      <td>${row.label}</td>
      <td>${row.total}</td>
      <td>${row.confirmadas}</td>
      <td>${row.confirmacoes_manuais}</td>
      <td>${row.confirmacoes_mtr}</td>
      <td>${row.pendentes_confirmacao}</td>
      <td>${row.nao_realizadas}</td>
      <td>${pill(row.precisam_acao)}</td>
      <td>${pill(row.alertas)}</td>
    </tr>
  `).join("");
}

function renderSupplierPerformance(rows = []) {
  if (!$("#supplierOverview") || !$("#supplierDecision") || !$("#supplierRanking") || !$("#suppliersTable")) return;
  const missingSupplier = rows.find((row) => row.label === "Não informado");
  const supplierRows = rows.filter((row) => row.label !== "Não informado");
  const sorted = [...supplierRows].sort((a, b) => {
    const left = Number(a.confirmacoes_mtr || 0) / Math.max(1, Number(a.coletas_agendadas || a.total || 0));
    const right = Number(b.confirmacoes_mtr || 0) / Math.max(1, Number(b.coletas_agendadas || b.total || 0));
    return left - right || Number(b.total || 0) - Number(a.total || 0);
  });
  const totals = {
    fornecedores: supplierRows.length,
    critical: supplierRows.filter((row) => supplierBucket(row) === "critical").length,
    attention: supplierRows.filter((row) => supplierBucket(row) === "attention").length,
    good: supplierRows.filter((row) => supplierBucket(row) === "good").length,
    semMtr: supplierRows.reduce((sum, row) => sum + Number(row.pendentes_confirmacao || 0), 0),
    pendencias: supplierRows.reduce((sum, row) => sum + Number(row.pendentes_operacionais || 0), 0),
    semFornecedor: Number(missingSupplier?.coletas_agendadas || missingSupplier?.total || 0),
  };
  $("#supplierOverview").innerHTML = `
    <article><span>Fornecedores</span><strong>${totals.fornecedores}</strong></article>
    <article class="is-bad"><span>Críticos</span><strong>${totals.critical}</strong></article>
    <article class="is-mid"><span>Atenção</span><strong>${totals.attention}</strong></article>
    <article class="is-good"><span>Aderentes</span><strong>${totals.good}</strong></article>
    <article><span>Sem MTR</span><strong>${totals.semMtr}</strong></article>
    <article><span>Pendência operacional</span><strong>${totals.pendencias}</strong></article>
    <article class="is-mid"><span>Sem fornecedor</span><strong>${totals.semFornecedor}</strong></article>
  `;

  const visible = supplierViewFilter === "all" ? sorted : sorted.filter((row) => supplierBucket(row) === supplierViewFilter);
  const topImpact = [...supplierRows].sort((a, b) => Number(b.pendentes_confirmacao || 0) - Number(a.pendentes_confirmacao || 0)).slice(0, 3);
  const best = [...supplierRows]
    .filter((row) => Number(row.coletas_agendadas || row.total || 0) > 0)
    .sort((a, b) => (Number(b.confirmacoes_mtr || 0) / Number(b.coletas_agendadas || b.total || 1)) - (Number(a.confirmacoes_mtr || 0) / Number(a.coletas_agendadas || a.total || 1)))
    .slice(0, 3);
  $("#supplierDecision").innerHTML = `
    <section>
      <h3>Prioridade de ação</h3>
      ${topImpact.map((row) => `<div><strong>${shortSupplierName(row.label)}</strong><span>${row.pendentes_confirmacao} sem MTR · ${row.pendentes_operacionais} pendências operacionais</span></div>`).join("")}
    </section>
    <section>
      <h3>Melhor aderência</h3>
      ${best.map((row) => `<div><strong>${shortSupplierName(row.label)}</strong><span>${pct(row.confirmacoes_mtr, row.coletas_agendadas || row.total)}% via MTR · ${row.confirmacoes_mtr} confirmações</span></div>`).join("")}
    </section>
  `;

  $("#supplierRanking").innerHTML = visible.slice(0, 6).map((row, index) => {
    const base = Number(row.coletas_agendadas || row.total || 0);
    const rate = pct(row.confirmacoes_mtr, base);
    const manualRate = Math.min(100, Number(pct(row.confirmacoes_manuais, base)));
    const mtrRate = Math.min(100, Number(rate));
    const missingRate = Math.max(0, 100 - mtrRate - manualRate);
    const klass = supplierClass(row);
    const recommendation = supplierRecommendation(row);
    return `
      <article class="supplier-rank ${klass}">
        <div class="rank-number">${index + 1}</div>
        <div>
          <h3>${row.label}</h3>
          <div class="supplier-meta">
            <span>${base} coletas</span>
            <span>${row.confirmacoes_mtr} via MTR</span>
            <span>${row.confirmacoes_manuais} manuais</span>
            <strong>${row.pendentes_confirmacao} sem confirmação MTR</strong>
            <span>${row.pendentes_operacionais} pendências operacionais</span>
          </div>
          <div class="supplier-stack" title="Verde: via MTR | Laranja: manual | Vermelho: sem MTR">
            <span class="mtr" style="width:${mtrRate}%"></span>
            <span class="manual" style="width:${manualRate}%"></span>
            <span class="missing" style="width:${missingRate}%"></span>
          </div>
          <div class="rank-score">
            <strong>${rate}%</strong>
            <span>${recommendation}</span>
          </div>
        </div>
      </article>
    `;
  }).join("") || `<p>Nenhum fornecedor encontrado.</p>`;

  $("#suppliersTable").innerHTML = visible.map((row) => {
    const base = Number(row.coletas_agendadas || row.total || 0);
    const rate = pct(row.confirmacoes_mtr, base);
    return `
      <tr class="${supplierClass(row)}">
        <td>${row.label}</td>
        <td>${base}</td>
        <td><strong>${rate}%</strong></td>
        <td>${row.confirmacoes_mtr}</td>
        <td>${pill(row.pendentes_confirmacao)}</td>
        <td>${row.confirmacoes_manuais}</td>
        <td>${pill(row.pendentes_operacionais)}</td>
        <td>${row.nao_realizadas}</td>
        <td>${pill(row.precisam_acao)}</td>
        <td>${supplierRecommendation(row)}</td>
      </tr>
    `;
  }).join("");
}

function pct(part, total) {
  if (!total) return "0.0";
  return ((part / total) * 100).toFixed(1);
}

function populateSelect(selector, values, defaultLabel) {
  const select = $(selector);
  const current = select.value;
  const clean = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  select.innerHTML = `<option value="">${defaultLabel}</option>` + clean.map((value) => (
    `<option value="${value}">${value}</option>`
  )).join("");
  select.value = clean.includes(current) ? current : "";
}

function selectedValues(selector) {
  return Array.from($(selector).selectedOptions || []).map((option) => option.value).filter(Boolean);
}

function populateMultiSelect(selector, values) {
  const select = $(selector);
  const current = selectedValues(selector);
  const clean = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  select.innerHTML = clean.map((value) => `<option value="${value}">${value}</option>`).join("");
  current.filter((value) => clean.includes(value)).forEach((value) => {
    const option = Array.from(select.options).find((item) => item.value === value);
    if (option) option.selected = true;
  });
}

function sumRows(rows, fields) {
  return fields.reduce((acc, field) => {
    acc[field] = rows.reduce((total, row) => total + Number(row[field] || 0), 0);
    return acc;
  }, {});
}

function aggregateBy(rows, keyField, fields) {
  const grouped = new Map();
  rows.forEach((row) => {
    const key = row[keyField] || "Não informado";
    if (!grouped.has(key)) grouped.set(key, { label: key, [keyField]: key });
    const target = grouped.get(key);
    fields.forEach((field) => {
      target[field] = Number(target[field] || 0) + Number(row[field] || 0);
    });
  });
  return Array.from(grouped.values());
}

function renderCollaboratorUnit() {
  const rows = dashboardData?.performance?.colaborador_unidade || [];
  const supplierRows = dashboardData?.performance?.colaborador_unidade_fornecedor || [];
  const ownerRows = dashboardData?.performance?.responsaveis_operacionais || [];
  const units = dashboardData?.performance?.unidades || [];
  const pending = dashboardData?.performance?.pendencias_unidade || [];
  const pendingConfirmation = dashboardData?.performance?.pendentes_confirmacao_unidade || [];
  const owners = selectedValues("#ownerFilter");
  const selectedUnits = selectedValues("#unitFilter");
  const suppliers = selectedValues("#supplierFilter");
  const manualUsers = selectedValues("#manualUserFilter");
  const hasAny = (selected, value) => !selected.length || selected.includes(value);
  const unitOwner = new Map(units.map((row) => [row.unidade, row.responsavel_operacional]));
  const ownerUnitScope = units.filter((row) => (
    hasAny(owners, row.responsavel_operacional) &&
    hasAny(selectedUnits, row.unidade)
  ));
  const ownerUnitNames = new Set(ownerUnitScope.map((row) => row.unidade));
  const supplierScopedRows = supplierRows.filter((row) => (
    ownerUnitNames.has(row.unidade) &&
    hasAny(suppliers, row.fornecedor)
  ));
  const unitsMatchingSupplier = new Set(supplierScopedRows.map((row) => row.unidade));
  const manualRowsInScope = rows.filter((row) => (
    ownerUnitNames.has(row.unidade) &&
    hasAny(manualUsers, row.colaborador) &&
    (!suppliers.length || unitsMatchingSupplier.has(row.unidade))
  ));
  const unitsMatchingManual = new Set(manualRowsInScope.map((row) => row.unidade));
  const filteredUnits = ownerUnitScope.filter((row) => (
    (!suppliers.length || unitsMatchingSupplier.has(row.unidade)) &&
    (!manualUsers.length || unitsMatchingManual.has(row.unidade))
  ));
  const filteredUnitNames = new Set(filteredUnits.map((row) => row.unidade));
  const filteredRows = manualRowsInScope.filter((row) => filteredUnitNames.has(row.unidade));
  const filteredSupplierRows = supplierScopedRows.filter((row) => filteredUnitNames.has(row.unidade));
  const computedUnits = filteredUnits.map((row) => {
    const supplierScope = filteredSupplierRows.filter((item) => item.unidade === row.unidade);
    const manualScope = filteredRows.filter((item) => item.unidade === row.unidade);
    if (!supplierScope.length) {
      if (!manualUsers.length) return row;
      const manualTotals = sumRows(manualScope, ["confirmacoes_manuais", "realizadas_confirmadas"]);
      return {
        ...row,
        confirmadas: manualTotals.realizadas_confirmadas + Number(row.confirmacoes_mtr || 0),
        confirmacoes_manuais: manualTotals.confirmacoes_manuais,
      };
    }
    const totals = sumRows(supplierScope, ["coletas_agendadas", "total_confirmadas", "confirmacoes_manuais", "confirmacoes_mtr", "pendentes_confirmacao_fornecedor", "pendentes_confirmacao", "nao_realizadas", "precisam_acao"]);
    const manualTotals = manualUsers.length ? sumRows(manualScope, ["confirmacoes_manuais"]) : {};
    return {
      ...row,
      coletas_agendadas: totals.coletas_agendadas,
      confirmadas: (manualUsers.length ? Number(manualTotals.confirmacoes_manuais || 0) + Number(totals.confirmacoes_mtr || 0) : totals.total_confirmadas),
      confirmacoes_manuais: (manualUsers.length ? manualTotals.confirmacoes_manuais : totals.confirmacoes_manuais),
      confirmacoes_mtr: totals.confirmacoes_mtr,
      pendentes_confirmacao: totals.pendentes_confirmacao,
      pendentes_confirmacao_fornecedor: totals.pendentes_confirmacao_fornecedor,
      nao_realizadas: totals.nao_realizadas,
      precisam_acao: totals.precisam_acao,
    };
  });
  const filteredOwners = aggregateBy(computedUnits, "responsavel_operacional", ["coletas_agendadas", "confirmadas", "confirmacoes_manuais", "confirmacoes_mtr", "pendentes_confirmacao", "nao_realizadas"]);
  const scopeTotals = sumRows(computedUnits, ["coletas_agendadas", "confirmadas", "confirmacoes_manuais", "confirmacoes_mtr", "pendentes_confirmacao", "pendentes_confirmacao_fornecedor"]);

  $("#scopeSummary").innerHTML = `
    <article><span>Unidades no filtro</span><strong>${computedUnits.length}</strong></article>
    <article><span>Coletas</span><strong>${scopeTotals.coletas_agendadas || 0}</strong></article>
    <article><span>Confirmadas</span><strong>${scopeTotals.confirmadas || 0}</strong></article>
    <article><span>Atendente</span><strong>${scopeTotals.confirmacoes_manuais || 0}</strong></article>
    <article class="is-warn"><span>Pendências de Contingência</span><strong>${scopeTotals.pendentes_confirmacao || 0}</strong></article>
    <article class="is-bad"><span>Sem confirmação do fornecedor via MTR</span><strong>${scopeTotals.pendentes_confirmacao_fornecedor || 0}</strong></article>
  `;

  $("#ownerTable").innerHTML = filteredOwners.map((row) => `
    <tr>
      <td>${row.responsavel_operacional}</td>
      <td>${row.coletas_agendadas}</td>
      <td>${row.confirmadas}</td>
      <td>${row.confirmacoes_manuais}</td>
      <td>${row.confirmacoes_mtr}</td>
      <td>${pill(row.pendentes_confirmacao)}</td>
      <td>${row.nao_realizadas}</td>
    </tr>
  `).join("") || `<tr><td colspan="7">Nenhum responsável operacional encontrado para o filtro selecionado.</td></tr>`;

  $("#collabUnitTable").innerHTML = filteredRows.map((row) => `
    <tr>
      <td>${row.colaborador}</td>
      <td>${row.unidade}</td>
      <td>${row.confirmacoes_manuais}</td>
      <td>${row.realizadas_confirmadas}</td>
    </tr>
  `).join("") || `<tr><td colspan="4">Nenhuma confirmação manual encontrada para o filtro selecionado.</td></tr>`;

  $("#collabUnitSupplierTable").innerHTML = filteredSupplierRows.map((row) => `
    <tr class="${performanceClass(pct(row.confirmacoes_mtr, row.coletas_agendadas), row.pendentes_confirmacao_fornecedor)}">
      <td>${row.unidade}</td>
      <td>${row.fornecedor}</td>
      <td>${row.coletas_agendadas}</td>
      <td>${row.total_confirmadas}</td>
      <td>${row.confirmacoes_manuais}</td>
      <td>${row.confirmacoes_mtr}</td>
      <td>${pill(row.pendentes_confirmacao_fornecedor)}</td>
      <td>${pill(row.pendentes_confirmacao)}</td>
      <td>${row.nao_realizadas}</td>
    </tr>
  `).join("") || `<tr><td colspan="9">Nenhum fornecedor encontrado para o filtro selecionado.</td></tr>`;

  $("#unitSummaryTable").innerHTML = computedUnits.map((row) => `
    <tr>
      <td>${row.responsavel_operacional}</td>
      <td>${row.unidade}</td>
      <td>${row.coletas_agendadas}</td>
      <td>${row.confirmadas}</td>
      <td>${row.confirmacoes_manuais}</td>
      <td>${row.confirmacoes_mtr}</td>
      <td>${row.pendentes_confirmacao}</td>
      <td>${row.nao_realizadas}</td>
    </tr>
  `).join("");

  $("#unitCards").innerHTML = computedUnits.map((row) => {
    const coletasAgendadas = row.coletas_agendadas;
    const confirmadas = row.confirmadas;
    const manuais = row.confirmacoes_manuais;
    const viaMtr = row.confirmacoes_mtr;
    const pendentesFornecedor = row.pendentes_confirmacao_fornecedor ?? Math.max(0, row.coletas_agendadas - row.confirmacoes_mtr);
    const unitPending = pending.filter((item) => item.unidade === row.unidade && hasAny(suppliers, item.fornecedor));
    const unitPendingConfirmation = pendingConfirmation.filter((item) => item.unidade === row.unidade && hasAny(suppliers, item.fornecedor));
    const totalRate = pct(confirmadas, coletasAgendadas);
    const manualRate = pct(manuais, coletasAgendadas);
    const totalClass = performanceClass(totalRate, 0);
    const manualClass = performanceClass(manualRate, 0);
    const cardClass = performanceClass(totalRate, unitPendingConfirmation.length);
    const pendingConfirmationIds = new Set(unitPendingConfirmation.map((item) => item.id));
    const scheduledPending = unitPending.filter((item) => !pendingConfirmationIds.has(item.id) && String(item.status_original || "").toUpperCase() !== "NÃO REALIZADA");
    const otherPending = unitPending.filter((item) => !pendingConfirmationIds.has(item.id) && String(item.status_original || "").toUpperCase() === "NÃO REALIZADA");
    const pendingConfirmationText = `${unitPendingConfirmation.length} pendentes de confirmação`;
    const renderPendingButtons = (items) => items.map((item) => `
      <button class="pending-os" type="button" data-order-id="${item.id}">
        <strong>OS ${item.numero_os}</strong>
        <span>${item.status_original} · ${fmtDate(item.data_agendada)} · ${item.prazo}</span>
        <span>${item.fornecedor || "Fornecedor não informado"}</span>
      </button>
    `).join("");
    const pendingList = (unitPending.length || unitPendingConfirmation.length) ? `
      <div class="pending-list">
        ${unitPendingConfirmation.length ? `<div class="pending-group-title">${unitPendingConfirmation.length} OS agendadas sem confirmação de execução</div>${renderPendingButtons(unitPendingConfirmation)}` : ""}
        ${scheduledPending.length ? `<div class="pending-group-title">${scheduledPending.length} pendências agendadas/em atraso</div>${renderPendingButtons(scheduledPending)}` : ""}
        ${otherPending.length ? `<div class="pending-group-title">${otherPending.length} outras pendências operacionais</div>${renderPendingButtons(otherPending)}` : ""}
      </div>
    ` : `<div class="pending-list empty">Nenhuma pendência operacional aberta.</div>`;
    return `
      <article class="unit-card ${cardClass}" data-unit="${row.unidade}">
        <div class="unit-card-top">
          <h3>${row.unidade}</h3>
          <span class="status-chip">${performanceLabel(cardClass)}</span>
        </div>
        <div class="unit-owner">${row.responsavel_operacional}</div>
        <div class="card-metric">
          <div>
          <span>% de Coletas Confirmadas</span>
            <strong>${totalRate}%</strong>
          </div>
          <div class="metric-bar ${totalClass}"><span style="width:${Math.max(2, Math.min(100, Number(totalRate)))}%"></span></div>
        </div>
        <div class="card-metric secondary">
          <div>
            <span>Coletas confirmadas pelo atendente</span>
            <strong>${manualRate}%</strong>
          </div>
          <div class="metric-bar ${manualClass}"><span style="width:${Math.max(2, Math.min(100, Number(manualRate)))}%"></span></div>
        </div>
        <div class="unit-meta">
          <span>${coletasAgendadas} coletas no período</span>
          <span>${manuais} atendente · ${viaMtr} fornecedor via MTR</span>
          <strong>${pendingConfirmationText}</strong>
          <strong>${pendentesFornecedor} sem confirmação do fornecedor via MTR</strong>
          <span>${row.nao_realizadas} não realizadas</span>
        </div>
        <div class="unit-card-hint">Clique para ver as OS vinculadas</div>
        ${pendingList}
      </article>
    `;
  }).join("");
  $$("#unitCards .unit-card").forEach((card) => {
    card.addEventListener("click", (event) => {
      const osButton = event.target.closest(".pending-os");
      if (osButton) {
        openOrder(osButton.dataset.orderId);
        return;
      }
      card.classList.toggle("expanded");
    });
  });
}

function pill(value) {
  const lower = String(value || "").toLowerCase();
  let klass = "pill";
  if (lower.includes("inconsist") || lower.includes("não realizada") || lower === "sim") klass += " danger";
  else if (lower.includes("pendente") || lower.includes("atraso") || lower.includes("agendada")) klass += " warn";
  return `<span class="${klass}">${value ?? ""}</span>`;
}

function updateStatusFilter(rows) {
  const select = $("#statusFilter");
  const current = select.value;
  const statuses = [...new Set((rows || []).map((row) => row.label).filter(Boolean))].sort();
  select.innerHTML = `<option value="">Todos os status</option>` + statuses.map((status) => (
    `<option value="${status}">${status}</option>`
  )).join("");
  select.value = statuses.includes(current) ? current : "";
}

function renderOverviewComposition(kpis = {}) {
  const target = $("#overviewComposition");
  if (!target) return;
  const total = Number(kpis.coletas_agendadas ?? kpis.total_os ?? 0);
  const manual = Number(kpis.confirmacoes_manuais ?? 0);
  const mtr = Number(kpis.confirmacoes_mtr ?? 0);
  const pending = Number(kpis.pendentes_confirmacao ?? 0);
  const notDone = Number(kpis.nao_realizadas ?? 0);
  const explained = manual + mtr + pending + notDone;
  const other = Math.max(0, total - explained);
  const rows = [
    ["Confirmações do Atendente", manual, "attendant"],
    ["Fornecedor via MTR", mtr, "mtr"],
    ["Pendências de Contingência", pending, "pending"],
    ["Não realizadas", notDone, "danger"],
  ];
  if (other) rows.push(["Agendadas/em aberto", other, "neutral"]);
  target.innerHTML = rows.map(([label, value, klass]) => `
    <div class="composition-row">
      <span>${label}</span>
      <div class="mini-track"><b class="${klass}" style="width:${Math.max(2, Math.min(100, Number(pct(value, total))))}%"></b></div>
      <strong>${value} <small>${pct(value, total)}%</small></strong>
    </div>
  `).join("");
}

function renderOverviewPriorities(kpis = {}) {
  const target = $("#overviewPriorities");
  if (!target) return;
  const units = dashboardData?.performance?.unidades || [];
  const actionUnits = [...units].sort((a, b) => Number(b.precisam_acao || 0) - Number(a.precisam_acao || 0));
  const pendingUnits = [...units].sort((a, b) => Number(b.pendentes_confirmacao || 0) - Number(a.pendentes_confirmacao || 0));
  const alerts = [
    {
      title: "Maior pendência",
      detail: pendingUnits[0] ? `${pendingUnits[0].unidade} · ${pendingUnits[0].pendentes_confirmacao} pendência(s)` : "Sem pendências por unidade",
      severity: Number(pendingUnits[0]?.pendentes_confirmacao || 0) ? "Alta" : "Baixa",
    },
    {
      title: "Maior volume que precisa de ação",
      detail: actionUnits[0] ? `${actionUnits[0].unidade} · ${actionUnits[0].precisam_acao} item(ns)` : "Sem itens críticos",
      severity: Number(actionUnits[0]?.precisam_acao || 0) ? "Média" : "Baixa",
    },
    {
      title: "Inconsistências",
      detail: `${kpis.alertas ?? 0} alerta(s) sinalizado(s)`,
      severity: Number(kpis.alertas || 0) ? "Média" : "Baixa",
    },
  ];
  target.innerHTML = alerts.map((item) => `
    <article>
      <span>${item.title}</span>
      <strong>${item.detail}</strong>
      <em>${item.severity}</em>
    </article>
  `).join("");
}

async function loadDashboard(importId = currentImportId) {
  const params = new URLSearchParams({ import_id: importId });
  if (dateFilter.from) params.set("date_from", dateFilter.from);
  if (dateFilter.to) params.set("date_to", dateFilter.to);
  dashboardData = await api(`/api/dashboard?${params.toString()}`);
  if (!dashboardData.has_data) {
    renderKpis();
    renderBars("#chartStatusGerencial", []);
    showAlert("Nenhuma planilha foi importada ainda. Use o botão Subir planilha para começar.");
    return;
  }

  currentImportId = dateFilter.from || dateFilter.to ? "latest" : dashboardData.import.id;
  const imp = dashboardData.import;
  const sourceLabel = dateFilter.from || dateFilter.to ? "histórico importado" : `${imp.row_count} linhas importadas`;
  $("#periodLabel").textContent = `Período analisado: ${imp.period_start_label || "-"} a ${imp.period_end_label || "-"} | ${sourceLabel}`;
  renderKpis(dashboardData.kpis);
  renderBars("#chartStatusGerencial", dashboardData.charts.status_gerencial);
  renderBars("#chartUnidades", dashboardData.charts.unidades);
  renderBars("#chartAtendentes", dashboardData.charts.atendentes);
  renderBars("#chartAberturas", dashboardData.charts.aberturas);
  renderPerformance("#attendantsTable", dashboardData.performance.atendentes);
  populateMultiSelect("#ownerFilter", dashboardData.performance.responsaveis_operacionais.map((row) => row.label));
  populateMultiSelect("#unitFilter", dashboardData.performance.unidades.map((row) => row.unidade));
  populateMultiSelect("#supplierFilter", dashboardData.performance.colaborador_unidade_fornecedor.map((row) => row.fornecedor));
  populateMultiSelect("#manualUserFilter", dashboardData.performance.colaborador_unidade.map((row) => row.colaborador));
  renderCollaboratorUnit();
  updateStatusFilter(dashboardData.charts.status_gerencial);

  if (imp.warning_count) {
    showAlert(`${imp.warning_count} alerta(s) encontrados nesta importação: duplicidades, dados ausentes, atrasos ou inconsistências entre status e datas.`);
  } else {
    hideAlert();
  }
}

async function loadImports() {
  const payload = await api("/api/imports");
  $("#importsTable").innerHTML = payload.imports.map((item) => `
    <tr data-import="${item.id}">
      <td>${fmtDateTime(item.imported_at)}</td>
      <td>${item.file_name}</td>
      <td>${item.period_start_label || "-"} a ${item.period_end_label || "-"}</td>
      <td>${item.row_count}</td>
      <td>${item.unique_os_count}</td>
      <td>${item.duplicate_count}</td>
      <td>${item.missing_required_count}</td>
      <td>${item.inconsistency_count}</td>
      <td>${pill(item.status)}</td>
    </tr>
  `).join("");
  $$("#importsTable tr").forEach((row) => {
    row.addEventListener("click", async () => {
      currentImportId = row.dataset.import;
      await refreshAll();
      activateView("overview");
    });
  });
}

async function loadOrders() {
  const params = new URLSearchParams({
    import_id: currentImportId,
    search: $("#searchInput").value,
    status: $("#statusFilter").value,
    action: $("#actionFilter").value,
    limit: "500",
  });
  $("#exportCsv").href = `/api/export/orders.csv?${params.toString()}`;
  const payload = await api(`/api/orders?${params.toString()}`);
  currentOrders = payload.rows;
  renderOrdersTable();
}

function renderOrdersTable() {
  let rows = [...currentOrders];
  if (sortState.key) {
    rows.sort((a, b) => {
      const left = String(a[sortState.key] || "").toLowerCase();
      const right = String(b[sortState.key] || "").toLowerCase();
      const result = left.localeCompare(right, "pt-BR", { numeric: true });
      return sortState.dir === "asc" ? result : -result;
    });
  }
  $("#ordersTable").innerHTML = rows.map((row) => `
    <tr data-id="${row.id}">
      <td>${row.numero_os}</td>
      <td>${row.unidade}</td>
      <td>${row.regional}</td>
      <td>${row.fornecedor}</td>
      <td>${row.tipo_residuo}</td>
      <td>${row.status_original}</td>
      <td>${pill(row.status_gerencial)}</td>
      <td>${row.origem_os || ""}</td>
      <td>${row.responsavel_abertura || ""}</td>
      <td>${row.status_operacional}</td>
      <td>${pill(row.origem_confirmacao || row.status_confirmacao)}</td>
      <td>${row.responsavel_confirmacao || ""}</td>
      <td>${fmtDate(row.data_agendada)}</td>
      <td>${fmtDate(row.data_realizacao)}</td>
      <td>${fmtDate(row.data_realizada)}</td>
      <td>${pill(row.produtividade_manual)}</td>
      <td>${pill(row.precisa_acao)}</td>
    </tr>
  `).join("");
  $$("#ordersTable tr").forEach((row) => {
    row.addEventListener("click", () => openOrder(row.dataset.id));
  });
}

async function openOrder(id) {
  const row = await api(`/api/orders/${id}`);
  $("#dialogTitle").textContent = `OS ${row.numero_os || ""}`;
  const fields = [
    ["Cliente", row.cliente],
    ["Unidade", row.unidade],
    ["Regional", row.regional],
    ["Fornecedor", row.fornecedor],
    ["Tipo de resíduo", row.tipo_residuo],
    ["MTR", row.mtr],
    ["Status original SIGRA", row.status_original],
    ["Origem da OS", row.origem_os],
    ["Processo de origem", row.processo_origem],
    ["Responsável pela abertura", row.responsavel_abertura],
    ["Status operacional da coleta", row.status_operacional],
    ["Status de confirmação", row.status_confirmacao],
    ["Origem da confirmação", row.origem_confirmacao],
    ["Responsável pela confirmação", row.responsavel_confirmacao],
    ["Conta como produtividade manual", row.produtividade_manual],
    ["Status gerencial", row.status_gerencial],
    ["Data de abertura", fmtDateTime(row.data_abertura)],
    ["Data agendada", fmtDate(row.data_agendada)],
    ["Data Realização", fmtDate(row.data_realizacao)],
    ["Data Realizada", fmtDate(row.data_realizada)],
    ["Data não realizada", fmtDate(row.data_nao_realizada)],
    ["Motivo de não realização", row.motivo_nao_realizacao],
    ["Usuário responsável", row.usuario_responsavel],
    ["Atendente vinculado", row.atendente_vinculado],
    ["Prazo", row.prazo],
    ["Precisa de ação", row.precisa_acao],
    ["Inconsistências", row.inconsistencias],
    ["Observações", row.observacoes],
    ["ID da importação", row.import_id],
  ];
  $("#orderDetail").innerHTML = fields.map(([label, value]) => `
    <div class="detail"><span>${label}</span><strong>${value || "-"}</strong></div>
  `).join("");
  $("#orderDialog").showModal();
}

async function uploadFile(input) {
  const file = input.files[0];
  if (!file) return;
  const form = new FormData();
  form.append("file", file);
  showAlert("Importando planilha SIGRA e validando dados...");
  try {
    const payload = await api("/api/import", { method: "POST", body: form });
    currentImportId = payload.import.id;
    await refreshAll();
    activateView("overview");
  } catch (error) {
    showAlert(error.message, "error");
  } finally {
    input.value = "";
  }
}

async function refreshAll() {
  await loadDashboard(currentImportId);
  await loadImports();
  await loadOrders();
}

function wireEvents() {
  $$(".nav").forEach((button) => button.addEventListener("click", () => activateView(button.dataset.view)));
  $("#sidebarToggle")?.addEventListener("click", () => {
    localStorage.setItem("sigraSidebarCollapsed", String(!document.body.classList.contains("sidebar-collapsed")));
    applySidebarState();
  });
  $("#fileInput").addEventListener("change", (event) => uploadFile(event.target));
  $("#fileInputSecondary").addEventListener("change", (event) => uploadFile(event.target));
  $("#searchInput").addEventListener("input", () => loadOrders());
  $("#statusFilter").addEventListener("change", () => loadOrders());
  $("#actionFilter").addEventListener("change", () => loadOrders());
  $("#ownerFilter").addEventListener("change", () => renderCollaboratorUnit());
  $("#unitFilter").addEventListener("change", () => renderCollaboratorUnit());
  $("#supplierFilter").addEventListener("change", () => renderCollaboratorUnit());
  $("#manualUserFilter").addEventListener("change", () => renderCollaboratorUnit());
  $("#clearOperationalFilters").addEventListener("click", () => {
    ["#ownerFilter", "#unitFilter", "#supplierFilter", "#manualUserFilter"].forEach((selector) => {
      Array.from($(selector).options).forEach((option) => { option.selected = false; });
    });
    renderCollaboratorUnit();
  });
  $("#applyDateFilter").addEventListener("click", async () => {
    dateFilter = { from: $("#dateFrom").value, to: $("#dateTo").value };
    await loadDashboard("latest");
  });
  $("#clearDateFilter").addEventListener("click", async () => {
    $("#dateFrom").value = "";
    $("#dateTo").value = "";
    dateFilter = { from: "", to: "" };
    await loadDashboard("latest");
  });
  $("#closeDialog").addEventListener("click", () => $("#orderDialog").close());
  $$("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      sortState = {
        key,
        dir: sortState.key === key && sortState.dir === "asc" ? "desc" : "asc",
      };
      renderOrdersTable();
    });
  });
}

wireEvents();
applySidebarState();
refreshAll();
