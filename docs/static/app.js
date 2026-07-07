let currentImportId = "latest";
let dashboardData = null;
let currentOrders = [];
let sortState = { key: "", dir: "asc" };
let dateFilter = { from: "", to: "" };
let waveFilter = "all";
let scopeApplied = false;
let supplierViewFilter = "critical";
let supplierSort = { key: "risk", dir: "desc" };
let conferenceImportId = "";
let wavesData = { waves: [], units: [], unlinked_units: [], out_of_scope_units: [], options: [] };
let measurementData = { calendars: [], cycles: [], baselines: [] };
const barSort = {};
const barData = {};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function applySidebarState() {
  const collapsed = localStorage.getItem("sigraSidebarUserSet") === "true"
    && localStorage.getItem("sigraSidebarCollapsed") === "true";
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  const button = $("#sidebarToggle");
  if (button) {
    button.setAttribute("aria-label", collapsed ? "Mostrar menu lateral" : "Esconder menu lateral");
    button.title = collapsed ? "Mostrar menu lateral" : "Esconder menu lateral";
  }
}

function fmtDate(value) {
  if (!value) return "";
  const raw = String(value);
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  const br = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (br) return `${String(br[1]).padStart(2, "0")}/${String(br[2]).padStart(2, "0")}/${br[3].length === 2 ? `20${br[3]}` : br[3]}`;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
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
  box.style.borderLeftColor = type === "error" ? "#DC2626" : "#F97316";
}

function hideAlert() {
  $("#alerts").classList.add("hidden");
}

async function api(path, options) {
  if (window.sigraStaticApi) {
    return window.sigraStaticApi(path, options || {});
  }
  const response = await fetch(path, options);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(payload.error || payload.message || "Erro na solicitação");
  return payload;
}

function activateView(view) {
  $$(".nav").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $$(".view").forEach((section) => section.classList.toggle("active", section.id === view));
}

function renderKpis(kpis = {}) {
  const unitsInScope = dashboardData?.charts?.unidades?.length ?? 0;
  const totalConsidered = Number(kpis.coletas_agendadas ?? kpis.total_os ?? 0);
  const confirmedTotal = Number(kpis.confirmacoes_manuais ?? 0) + Number(kpis.confirmacoes_mtr ?? 0);
  const baseline = measurementData?.baselines?.[0];
  const baselineComparison = dashboardData?.charts?.baseline_comparison;
  const items = [
    {
      icon: "OK",
      label: "Cobertura atual de confirmação",
      value: `${kpis.taxa_confirmacao_total ?? 0}%`,
      detail: `${confirmedTotal} coletas confirmadas de ${totalConsidered} consideradas`,
      className: "is-primary",
      filter: "all",
    },
    {
      icon: "+",
      label: "Evolução vs baseline",
      value: baselineComparison ? `${baselineComparison.variation_pp > 0 ? "+" : ""}${baselineComparison.variation_pp} p.p.` : (baseline ? "Disponível" : "Não definido"),
      detail: baseline
        ? `${baseline.period_start_label || fmtDate(baseline.period_start)} a ${baseline.period_end_label || fmtDate(baseline.period_end)}`
        : "Cadastre o baseline para medir variação",
      className: "is-muted",
    },
    {
      icon: "AT",
      label: "Confirmações do atendente",
      value: kpis.confirmacoes_manuais ?? 0,
      detail: "Ação direta de usuário humano/atendente",
      className: "is-attendant",
      filter: "attendant",
    },
    {
      icon: "MTR",
      label: "Fornecedor via MTR",
      value: kpis.confirmacoes_mtr ?? 0,
      detail: "Confirmações feitas pelo link da MTR",
      className: "is-mtr",
      filter: "mtr",
    },
    {
      icon: "!",
      label: "Pendências de contingência",
      value: kpis.pendentes_confirmacao ?? 0,
      detail: "Sem fornecedor via MTR e sem atendente",
      className: "is-warn",
      filter: "contingency",
    },
    {
      icon: "UN",
      label: "Unidades no escopo",
      value: unitsInScope,
      detail: "Unidades encontradas no período filtrado",
      className: "is-info",
    },
    {
      icon: "OS",
      label: "OS no período",
      value: kpis.total_os ?? 0,
      detail: "Ordens de serviço consideradas no filtro",
      className: "",
      filter: "all",
    },
    {
      icon: "A",
      label: "Precisam de ação",
      value: kpis.precisam_acao ?? 0,
      detail: "Pendências, vencidas e inconsistências críticas",
      className: "is-bad",
      filter: "action",
    },
  ];
  $("#kpiGrid").innerHTML = items.map((item) => `
    <article class="kpi executive-kpi ${item.className}" ${item.filter ? `data-overview-filter="${item.filter}"` : ""}>
      <div class="kpi-icon">${item.icon}</div>
      <div>
        <span>${item.label}</span>
        <strong>${item.value}</strong>
        <small>${item.detail}</small>
      </div>
    </article>
  `).join("");
}

function chartValue(rows = [], label) {
  return Number((rows || []).find((row) => row.label === label)?.value || 0);
}

function renderOverviewEvolution() {
  const target = $("#overviewEvolution");
  if (!target) return;
  const history = dashboardData?.charts?.coverage_history || [];
  if (history.length >= 2) {
    const max = Math.max(100, ...history.map((row) => Number(row.taxa || 0)));
    target.innerHTML = `
      <div class="evolution-bars">
        ${history.slice(-8).map((row) => {
          const width = Math.max(3, Math.round((Number(row.taxa || 0) / max) * 100));
          return `
            <div class="evolution-line">
              <span title="${row.label || ""}">${row.label || "Período"}</span>
              <div class="mini-progress"><i style="width:${width}%"></i></div>
              <strong>${row.taxa || 0}%</strong>
            </div>
          `;
        }).join("")}
      </div>
    `;
    return;
  }
  target.innerHTML = `
    <div class="empty-state">
      <strong>Histórico insuficiente para evolução.</strong>
      <span>Importe mais períodos ou cadastre o baseline para acompanhar tendência da cobertura.</span>
    </div>
  `;
}

function renderOverviewBeforeAfter() {
  const target = $("#overviewBeforeAfter");
  if (!target) return;
  const comparison = dashboardData?.charts?.baseline_comparison;
  if (comparison) {
    const rows = [
      ["Cobertura", `${comparison.baseline.cobertura}%`, `${comparison.current.cobertura}%`, `${comparison.variation_pp > 0 ? "+" : ""}${comparison.variation_pp} p.p.`],
      ["Atendente", comparison.baseline.confirmacoes_atendente, comparison.current.confirmacoes_atendente, `${comparison.variation_attendant > 0 ? "+" : ""}${comparison.variation_attendant}`],
      ["Fornecedor via MTR", comparison.baseline.confirmacoes_mtr, comparison.current.confirmacoes_mtr, `${comparison.variation_mtr > 0 ? "+" : ""}${comparison.variation_mtr}`],
      ["Pendências", comparison.baseline.pendencias_contingencia, comparison.current.pendencias_contingencia, `${comparison.variation_pending > 0 ? "+" : ""}${comparison.variation_pending}`],
    ];
    target.innerHTML = `
      <div class="before-after-table">
        <div class="before-after-head"><span>Métrica</span><span>Baseline</span><span>Atual</span><span>Variação</span></div>
        ${rows.map((row) => `
          <div class="before-after-row">
            <strong>${row[0]}</strong>
            <span>${row[1]}</span>
            <span>${row[2]}</span>
            <em class="${String(row[3]).startsWith("-") ? "is-down" : "is-up"}">${row[3]}</em>
          </div>
        `).join("")}
      </div>
    `;
    return;
  }
  const baseline = measurementData?.baselines?.[0];
  if (baseline) {
    target.innerHTML = `
      <div class="empty-state compact">
        <strong>${baseline.import_id ? "Baseline disponível para comparação." : "Baseline planejado, aguardando importação histórica."}</strong>
        <span>${baseline.name} · ${baseline.period_start_label || fmtDate(baseline.period_start)} a ${baseline.period_end_label || fmtDate(baseline.period_end)}</span>
      </div>
    `;
    return;
  }
  target.innerHTML = `
    <div class="empty-state compact">
      <strong>Baseline não definido.</strong>
      <span>Cadastre o baseline para comparar antes x depois.</span>
    </div>
  `;
}

function renderOverviewComposition(kpis = {}) {
  const target = $("#overviewComposition");
  if (!target) return;
  const statusRows = dashboardData?.charts?.status_gerencial || [];
  const totalOs = Number(kpis.total_os || 0);
  const confirmedByAttendant = Number(kpis.confirmacoes_manuais || 0);
  const confirmedByMtr = Number(kpis.confirmacoes_mtr || 0);
  const contingency = Number(kpis.pendentes_confirmacao || 0);
  const notDone = Number(kpis.nao_realizadas ?? chartValue(statusRows, "Não realizada"));
  const otherOpen = Math.max(0, totalOs - confirmedByAttendant - confirmedByMtr - contingency - notDone);
  const items = [
    {
      label: "Confirmadas pelo atendente",
      value: confirmedByAttendant,
      className: "attendant",
      filter: "attendant",
    },
    {
      label: "Confirmadas pelo fornecedor via MTR",
      value: confirmedByMtr,
      className: "mtr",
      filter: "mtr",
    },
    {
      label: "Pendências de contingência",
      value: contingency,
      className: "pending",
      filter: "contingency",
    },
    {
      label: "Não realizadas",
      value: notDone,
      className: "failed",
      filter: "notDone",
    },
    ...(otherOpen ? [{
      label: "Outras OS do período",
      value: otherOpen,
      className: "open",
      filter: "action",
    }] : []),
  ];
  const total = Math.max(1, items.reduce((sum, item) => sum + item.value, 0));
  target.innerHTML = items.map((item) => {
    const width = Math.max(2, Math.round((item.value / total) * 100));
    const percent = ((item.value / total) * 100).toFixed(0);
    return `
      <button class="composition-row" type="button" data-overview-filter="${item.filter}">
        <span>${item.label}</span>
        <div class="composition-track"><i class="${item.className}" style="width:${width}%"></i></div>
        <strong>${item.value} <small>${percent}%</small></strong>
      </button>
    `;
  }).join("");
}

function renderOverviewWaves() {
  const target = $("#overviewWaves");
  if (!target) return;
  const waves = wavesData?.waves || [];
  if (!waves.length) {
    target.innerHTML = `
    <div class="empty-state compact align-left">
      <strong>Nenhuma onda cadastrada.</strong>
      <span>Cadastre ondas para acompanhar a expansão por unidade.</span>
    </div>
  `;
    return;
  }
  target.innerHTML = `
    <div class="mini-table">
      ${waves.slice(0, 5).map((wave) => `
        <div class="mini-row">
          <strong>Onda ${wave.wave_number || "-"} · ${wave.name}</strong>
          <span>${wave.unidades || 0} unidades · ${wave.cobertura_confirmacao || 0}% cobertura · ${wave.pendencias_contingencia || 0} pendências</span>
          <i>${wave.status}</i>
        </div>
      `).join("")}
    </div>
  `;
}

function renderOverviewPriorities(kpis = {}) {
  const target = $("#overviewPriorities");
  if (!target) return;
  const units = dashboardData?.performance?.unidades || [];
  const attendants = dashboardData?.performance?.atendentes_executivo || [];
  const suppliers = dashboardData?.performance?.fornecedores || [];
  const topUnit = [...units].sort((a, b) => Number(b.pendentes_confirmacao || 0) - Number(a.pendentes_confirmacao || 0))[0];
  const topAttendant = [...attendants].sort((a, b) => Number(b.pendencias_contingencia || 0) - Number(a.pendencias_contingencia || 0))[0];
  const supplierWithVolume = suppliers.filter((row) => Number(row.coletas_agendadas || row.total || 0) > 0 && row.label !== "Não informado");
  const weakestSupplier = supplierWithVolume.sort((a, b) => {
    const aBase = Number(a.coletas_agendadas || a.total || 0);
    const bBase = Number(b.coletas_agendadas || b.total || 0);
    return Number(pct(a.confirmacoes_mtr || 0, aBase)) - Number(pct(b.confirmacoes_mtr || 0, bBase));
  })[0];
  const items = [
    {
      label: "Unidade com maior pendência",
      value: topUnit ? `${topUnit.unidade} · ${topUnit.pendentes_confirmacao || 0} pendências` : "Sem pendências por unidade",
      severity: Number(topUnit?.pendentes_confirmacao || 0) ? "Alta" : "Baixa",
      className: Number(topUnit?.pendentes_confirmacao || 0) ? "is-high" : "is-low",
    },
    {
      label: "Atendente com maior contingência",
      value: topAttendant ? `${topAttendant.atendente} · ${topAttendant.pendencias_contingencia || 0} pendências` : "Sem contingência por atendente",
      severity: Number(topAttendant?.pendencias_contingencia || 0) ? "Alta" : "Baixa",
      className: Number(topAttendant?.pendencias_contingencia || 0) ? "is-high" : "is-low",
    },
    {
      label: "Fornecedor com menor aderência MTR",
      value: weakestSupplier ? `${weakestSupplier.label} · ${pct(weakestSupplier.confirmacoes_mtr || 0, weakestSupplier.coletas_agendadas || weakestSupplier.total || 0)}%` : "Sem fornecedor no período",
      severity: weakestSupplier ? "Média" : "Baixa",
      className: weakestSupplier ? "is-mid" : "is-low",
    },
    {
      label: "Importações com inconsistências críticas",
      value: `${kpis.inconsistencias || 0} inconsistência(s) sinalizada(s)`,
      severity: Number(kpis.inconsistencias || 0) ? "Alta" : "Baixa",
      className: Number(kpis.inconsistencias || 0) ? "is-high" : "is-low",
    },
  ];
  target.innerHTML = items.map((item) => `
    <article class="priority-item ${item.className}">
      <span>${item.label}</span>
      <strong title="${item.value}">${item.value}</strong>
      <em>${item.severity}</em>
    </article>
  `).join("");
}

function renderOverview(kpis = {}) {
  renderKpis(kpis);
  renderOverviewEvolution();
  renderOverviewBeforeAfter();
  renderOverviewComposition(kpis);
  renderOverviewWaves();
  renderOverviewPriorities(kpis);
}

function waveLabel(wave) {
  if (!wave) return "Sem onda";
  return `${wave.wave_number ? `Onda ${wave.wave_number} · ` : ""}${wave.name}`;
}

function renderWaveFilters() {
  const options = wavesData.options || [];
  const html = `
    <option value="all">Todas as ondas</option>
    ${options.map((item) => `<option value="${item.id}">${item.label}</option>`).join("")}
    <option value="__sem_onda__">Unidades sem onda</option>
    <option value="__fora_escopo__">Fora do escopo</option>
  `;
  if ($("#waveFilter")) {
    $("#waveFilter").innerHTML = html;
    $("#waveFilter").value = [...options.map((item) => item.id), "all", "__sem_onda__", "__fora_escopo__"].includes(waveFilter) ? waveFilter : "all";
  }
  if ($("#bulkWaveSelect")) {
    $("#bulkWaveSelect").innerHTML = options.map((item) => `<option value="${item.id}">${item.label}</option>`).join("") || `<option value="">Cadastre uma onda</option>`;
  }
}

function renderMeasurementSetup() {
  const calendars = measurementData.calendars || [];
  const cycles = measurementData.cycles || [];
  const baselines = measurementData.baselines || [];
  $("#measurementSummary").innerHTML = `
    <article><span>Calendários ativos</span><strong>${calendars.filter((row) => row.status === "Ativo").length}</strong></article>
    <article><span>Competências geradas</span><strong>${cycles.length}</strong></article>
    <article><span>Baselines cadastrados</span><strong>${baselines.length}</strong></article>
    <article class="is-info"><span>Projeto iniciou em</span><strong>30/04/2026</strong></article>
  `;
  $("#measurementCalendarsTable").innerHTML = calendars.map((row) => `
    <tr>
      <td>${row.cliente}</td>
      <td>${row.cycle_type}</td>
      <td>${row.start_day}</td>
      <td>${row.end_day}</td>
      <td>${row.rule_description || "-"}</td>
      <td>${pill(row.status)}</td>
    </tr>
  `).join("") || `<tr><td colspan="6">Nenhum calendário cadastrado.</td></tr>`;
  $("#measurementCyclesTable").innerHTML = cycles.map((row) => `
    <tr>
      <td>${row.cliente}</td>
      <td>${row.name}</td>
      <td>${row.start_label || fmtDate(row.start_date)}</td>
      <td>${row.end_label || fmtDate(row.end_date)}</td>
      <td>${pill(row.status)}</td>
      <td>${row.observations || "-"}</td>
    </tr>
  `).join("") || `<tr><td colspan="6">Nenhuma competência gerada.</td></tr>`;
  $("#baselinesTable").innerHTML = baselines.map((row) => `
    <tr>
      <td>${row.name}</td>
      <td>${row.scope_type}</td>
      <td>${row.cliente || "-"}</td>
      <td>${row.period_start_label} a ${row.period_end_label}</td>
      <td>${row.wave_number ? `Onda ${row.wave_number} · ` : ""}${row.wave_name || "-"}</td>
      <td>${row.import_file || "Aguardando importação baseline"}</td>
      <td>${pill(row.status)}</td>
    </tr>
  `).join("") || `<tr><td colspan="7">Nenhum baseline cadastrado.</td></tr>`;
  if ($("#waveCycle")) {
    $("#waveCycle").innerHTML = `<option value="">Sem competência</option>` + cycles.map((row) => (
      `<option value="${row.id}">${row.cliente} · ${row.name}</option>`
    )).join("");
  }
  if ($("#waveBaseline")) {
    $("#waveBaseline").innerHTML = `<option value="">Sem baseline vinculado</option>` + baselines.map((row) => (
      `<option value="${row.id}">${row.name}</option>`
    )).join("");
  }
}

async function loadMeasurementSetup() {
  measurementData = await api("/api/measurement");
  renderMeasurementSetup();
}

function selectedWaveUnits() {
  return $$("#waveUnitsTable input[type=checkbox]:checked").map((input) => ({
    cliente: input.dataset.cliente || "",
    unidade: input.dataset.unidade || "",
    atendente_responsavel: input.dataset.atendente || "",
  }));
}

function renderWavesPage() {
  const waves = wavesData.waves || [];
  const units = wavesData.units || [];
  const search = ($("#waveUnitSearch")?.value || "").toLowerCase();
  const unlinked = (wavesData.unlinked_units || []).filter((row) => (
    !search ||
    [row.cliente, row.unidade, row.atendente_responsavel, row.atendente_relacionado, row.fornecedor_principal, row.situacao]
      .join(" ")
      .toLowerCase()
      .includes(search)
  ));
  $("#wavesSummary").innerHTML = `
    <article><span>Ondas cadastradas</span><strong>${waves.length}</strong></article>
    <article><span>Unidades encontradas</span><strong>${wavesData.units_total ?? units.length}</strong></article>
    <article><span>Sem onda</span><strong>${wavesData.unlinked_units_total ?? wavesData.unlinked_units?.length ?? 0}</strong></article>
    <article><span>Fora do escopo</span><strong>${wavesData.out_of_scope_units_total ?? wavesData.out_of_scope_units?.length ?? 0}</strong></article>
  `;
  $("#wavesTable").innerHTML = waves.map((wave) => `
    <tr>
      <td><strong>${waveLabel(wave)}</strong></td>
      <td>${wave.cliente || "-"}</td>
      <td>${fmtDate(wave.competency_start_date)} a ${fmtDate(wave.competency_end_date)}</td>
      <td>${wave.objective || "-"}</td>
      <td>${wave.unidades || 0}</td>
      <td><span class="status-chip">${wave.status}</span></td>
      <td>${wave.progresso || 0}%</td>
      <td>${wave.cobertura_confirmacao || 0}%</td>
      <td>${wave.pendencias_contingencia || 0}</td>
      <td><button type="button" class="ghost-button" data-edit-wave="${wave.id}">Editar</button></td>
    </tr>
  `).join("") || `<tr><td colspan="10">Nenhuma onda cadastrada.</td></tr>`;
  $("#waveUnitsTable").innerHTML = unlinked.map((row) => `
    <tr>
      <td><input type="checkbox" data-cliente="${row.cliente || ""}" data-unidade="${row.unidade || ""}" data-atendente="${row.atendente_responsavel || row.atendente_relacionado || ""}"></td>
      <td title="${row.cliente || ""}">${row.cliente || "-"}</td>
      <td title="${row.unidade || ""}">${row.unidade || "-"}</td>
      <td>${row.total_os || 0}</td>
      <td>${row.primeira_data_label || "-"}</td>
      <td>${row.ultima_data_label || "-"}</td>
      <td>${row.confirmacoes || 0}</td>
      <td>${row.pendencias_contingencia || 0}</td>
      <td>${row.atendente_responsavel || row.atendente_relacionado || "-"}</td>
      <td title="${row.fornecedor_principal || ""}">${row.fornecedor_principal || "-"}</td>
      <td><span class="status-chip">Sem onda</span></td>
    </tr>
  `).join("") || `<tr><td colspan="11">Nenhuma unidade sem onda vinculada.</td></tr>`;
  if ((wavesData.unlinked_units_total || 0) > unlinked.length && !search) {
    $("#waveUnitsTable").insertAdjacentHTML("beforeend", `<tr><td colspan="11">Mostrando as primeiras ${unlinked.length} unidades sem onda. Use a busca para localizar uma unidade específica.</td></tr>`);
  }
}

async function loadWaves(includeUnits = false) {
  wavesData = await api(`/api/waves?include_units=${includeUnits ? "1" : "0"}`);
  renderWaveFilters();
  renderWavesPage();
  renderOverviewWaves();
}

async function saveWaveFromForm(event) {
  event.preventDefault();
  await api("/api/waves", {
    method: "POST",
    body: JSON.stringify({
      id: $("#waveId").value,
      wave_number: $("#waveNumber").value,
      cliente: $("#waveClient").value,
      name: $("#waveName").value,
      measurement_cycle_id: $("#waveCycle").value,
      baseline_id: $("#waveBaseline").value,
      status: $("#waveStatus").value,
      start_date: $("#waveStart").value,
      planned_end_date: $("#wavePlannedEnd").value,
      actual_end_date: $("#waveActualEnd").value,
      objective: $("#waveObjective").value,
      observations: $("#waveObservations").value,
    }),
  });
  $("#waveForm").reset();
  $("#waveId").value = "";
  await loadWaves(true);
  showAlert("Onda salva com sucesso.");
}

async function linkSelectedUnits(moveExisting = false) {
  const units = selectedWaveUnits();
  const waveId = $("#bulkWaveSelect").value;
  if (!units.length) {
    showAlert("Selecione ao menos uma unidade.", "error");
    return;
  }
  try {
    await api("/api/waves/link", {
      method: "POST",
      body: JSON.stringify({
        wave_id: waveId,
        units,
        entry_date: $("#bulkEntryDate").value,
        status: "Ativa",
        move_existing: moveExisting,
      }),
    });
    await loadWaves(true);
    if (scopeApplied) await loadDashboard(currentImportId);
    showAlert("Unidades vinculadas à onda.");
  } catch (error) {
    if (!moveExisting && /ativa em outra onda|ativas em outra onda|unidade/.test(error.message) && window.confirm(`${error.message} Deseja encerrar o vínculo anterior e mover para a nova onda?`)) {
      await linkSelectedUnits(true);
      return;
    }
    showAlert(error.message, "error");
  }
}

async function markSelectedUnitsOutOfScope() {
  const units = selectedWaveUnits();
  if (!units.length) {
    showAlert("Selecione ao menos uma unidade.", "error");
    return;
  }
  if (!window.confirm("Marcar as unidades selecionadas como fora do escopo?")) return;
  await api("/api/waves/out-of-scope", { method: "POST", body: JSON.stringify({ units }) });
  await loadWaves(true);
  if (scopeApplied) await loadDashboard(currentImportId);
  showAlert("Unidades marcadas como fora do escopo.");
}

function openBaseFiltered(filter) {
  const search = $("#searchInput");
  const status = $("#statusFilter");
  const action = $("#actionFilter");
  if (search) search.value = "";
  if (status) status.value = "";
  if (action) action.value = "";
  if (filter === "attendant" && search) search.value = "Confirmada pelo atendente";
  if (filter === "mtr" && search) search.value = "Confirmada pelo fornecedor via MTR";
  if (filter === "contingency") {
    if (search) search.value = "Não confirmada";
    if (action) action.value = "Sim";
  }
  if (filter === "notDone" && status) status.value = "Não realizada";
  if (filter === "action" && action) action.value = "Sim";
  activateView("base");
  loadOrders().catch((error) => showAlert(error.message, "error"));
}

function clearDashboard(message = "Selecione um período e clique em Filtrar, ou escolha uma importação na aba Importações SIGRA.") {
  dashboardData = null;
  currentOrders = [];
  $("#periodLabel").textContent = "Nenhum período aplicado.";
  renderOverview();
  ["#chartStatusGerencial", "#chartConfirmacao", "#chartUnidades", "#chartResiduos"].forEach((selector) => renderBars(selector, []));
  ["#attendantSummary", "#chartAtendentes", "#chartAttendantRate", "#chartPortfolioRate", "#chartContingency", "#chartComposition", "#chartWorkload", "#attendantMatrix", "#attendantEvolution"].forEach((selector) => {
    const el = $(selector);
    if (el) el.innerHTML = "";
  });
  ["#attendantHeatmapTable", "#ownerTable", "#collabUnitTable", "#collabUnitSupplierTable", "#unitSummaryTable", "#ordersTable"].forEach((selector) => {
    const el = $(selector);
    if (el) el.innerHTML = "";
  });
  ["#contractGroupFilter", "#ownerFilter", "#unitFilter", "#supplierFilter", "#manualUserFilter"].forEach((selector) => {
    const el = $(selector);
    if (el) el.innerHTML = "";
  });
  $("#supplierOverview").innerHTML = "";
  $("#supplierDecision").innerHTML = "";
  if ($("#supplierRanking")) $("#supplierRanking").innerHTML = `<p>${message}</p>`;
  $("#scopeSummary").innerHTML = "";
  $("#unitCards").innerHTML = `<p>${message}</p>`;
  updateStatusFilter([]);
  $("#exportCsv").href = "/api/export/orders.csv";
  showAlert(message);
}

function renderBars(selector, rows = []) {
  if (!$(selector)) return;
  barData[selector] = rows;
  const dir = barSort[selector] || "desc";
  const orderedRows = [...rows].sort((a, b) => {
    const diff = Number(a.value || 0) - Number(b.value || 0);
    return dir === "asc" ? diff : -diff;
  });
  const max = Math.max(1, ...orderedRows.map((row) => row.value));
  const controls = rows.length ? `
    <div class="bar-tools">
      <button type="button" class="${dir === "desc" ? "active" : ""}" data-bar-sort="${selector}" data-dir="desc">Maior para menor</button>
      <button type="button" class="${dir === "asc" ? "active" : ""}" data-bar-sort="${selector}" data-dir="asc">Menor para maior</button>
    </div>
  ` : "";
  const html = orderedRows.length ? orderedRows.map((row) => {
    const width = Math.max(4, Math.round((row.value / max) * 100));
    return `
      <div class="bar-row" title="${row.label}">
        <span>${row.label || "Não informado"}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
        <strong>${row.value}</strong>
      </div>
    `;
  }).join("") : `<p>Nenhum dado importado.</p>`;
  $(selector).innerHTML = controls + html;
}

function tableCellValue(row, index) {
  const raw = row.children[index]?.innerText.trim() || "";
  const numericText = raw.replace(/\./g, "").replace(",", ".").replace(/[^\d.-]/g, "");
  const numeric = Number(numericText);
  if (raw && /\d/.test(raw) && !Number.isNaN(numeric)) return numeric;
  return raw.toLocaleLowerCase("pt-BR");
}

function sortHtmlTable(th) {
  const table = th.closest("table");
  const tbody = table?.querySelector("tbody");
  if (!tbody) return;
  const headers = Array.from(th.parentElement.children);
  const index = headers.indexOf(th);
  const dir = th.dataset.sortDir === "asc" ? "desc" : "asc";
  headers.forEach((header) => {
    header.classList.remove("sorted-asc", "sorted-desc");
    delete header.dataset.sortDir;
  });
  th.dataset.sortDir = dir;
  th.classList.add(dir === "asc" ? "sorted-asc" : "sorted-desc");
  Array.from(tbody.querySelectorAll("tr"))
    .sort((a, b) => {
      const left = tableCellValue(a, index);
      const right = tableCellValue(b, index);
      const diff = typeof left === "number" && typeof right === "number"
        ? left - right
        : String(left).localeCompare(String(right), "pt-BR", { numeric: true });
      return dir === "asc" ? diff : -diff;
    })
    .forEach((row) => tbody.appendChild(row));
}

function criticality(total, confirmed, pending = 0, overdue = 0) {
  const volume = Number(total || 0);
  const confirmedRate = Number(pct(confirmed || 0, volume));
  const pendingCount = Number(pending || 0);
  const pendingRate = Number(pct(pendingCount, volume));
  if (!volume) return { className: "is-low", label: "Monitorar / Baixo volume" };
  if (volume < 5) return { className: "is-low", label: "Monitorar / Baixo volume" };

  const levels = ["is-good", "is-mid", "is-high", "is-bad"];
  const labels = {
    "is-good": "OK",
    "is-mid": "Atenção",
    "is-high": "Atenção alta",
    "is-bad": "Crítico",
  };
  let level = "is-good";
  if (confirmedRate < 50) {
    level = volume >= 10 ? "is-bad" : "is-high";
  } else if (confirmedRate < 75) {
    level = "is-high";
  } else if (confirmedRate < 90) {
    level = "is-mid";
  }

  if (pendingRate > 40 && pendingCount >= 5) {
    const currentIndex = levels.indexOf(level);
    const maxIndex = volume >= 10 ? levels.indexOf("is-bad") : levels.indexOf("is-high");
    level = levels[Math.min(currentIndex + 1, maxIndex)];
  }

  return { className: level, label: labels[level] };
}

function performanceClass(rate, pending = 0, total = 0) {
  return criticality(total || 100, Number(rate || 0), pending).className;
}

function performanceLabel(klass) {
  if (klass === "is-good") return "OK";
  if (klass === "is-mid") return "Atenção";
  if (klass === "is-high") return "Atenção alta";
  if (klass === "is-low") return "Monitorar / Baixo volume";
  return "Crítico";
}

function metricClass(rate, ok = 80, attention = 60, high = 30) {
  const value = Number(rate) || 0;
  if (value >= ok) return "is-good";
  if (value >= attention) return "is-mid";
  if (value >= high) return "is-high";
  return "is-bad";
}

function supplierClass(row) {
  const base = Number(row.coletas_agendadas || row.total || 0);
  const confirmed = Number(row.confirmacoes_mtr || 0) + Number(row.confirmacoes_manuais || 0);
  return criticality(base, confirmed, row.pendentes_operacionais || row.pendentes_confirmacao, row.pendentes_operacionais || 0).className;
}
function supplierBucket(row) {
  const klass = supplierClass(row);
  if (klass === "is-good") return "good";
  if (klass === "is-high") return "high";
  if (klass === "is-low") return "low";
  if (klass === "is-mid") return "attention";
  return "critical";
}

function supplierRecommendation(row) {
  const klass = supplierClass(row);
  if (klass === "is-low") return "Monitorar baixo volume";
  if (Number(row.pendentes_operacionais || row.pendentes_confirmacao || 0) === 0) return "Manter rotina";
  if (klass === "is-bad") return "Acionar fornecedor";
  if (klass === "is-high") return "Priorizar tratativa";
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

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function classificationFromScore(score) {
  const value = Number(score || 0);
  if (value >= 85) return { label: "Excelente", className: "is-good" };
  if (value >= 70) return { label: "Boa", className: "is-mid" };
  if (value >= 50) return { label: "Atenção", className: "is-high" };
  return { label: "Crítica", className: "is-bad" };
}

function workloadLabel(index) {
  const value = Number(index || 0);
  if (value >= 80) return "Muito alta";
  if (value >= 60) return "Alta";
  if (value >= 35) return "Média";
  return "Baixa";
}

function prepareAttendantExecutive(rawRows = []) {
  const rows = rawRows.filter((row) => row.atendente && row.atendente !== "Não informado");
  const max = {
    total_os: Math.max(1, ...rows.map((row) => Number(row.total_os || 0))),
    unidades: Math.max(1, ...rows.map((row) => Number(row.unidades || 0))),
    clientes: Math.max(1, ...rows.map((row) => Number(row.clientes || 0))),
    fornecedores: Math.max(1, ...rows.map((row) => Number(row.fornecedores || 0))),
    pendencias: Math.max(1, ...rows.map((row) => Number(row.pendencias_contingencia || 0))),
    confirmacoes: Math.max(1, ...rows.map((row) => Number(row.confirmacoes_atendente || 0))),
  };
  return rows.map((row) => {
    const total = Number(row.total_os || row.coletas_carteira || 0);
    const mtr = Number(row.confirmacoes_mtr || 0);
    const attendant = Number(row.confirmacoes_atendente || 0);
    const pending = Number(row.pendencias_contingencia || 0);
    const notDone = Number(row.nao_realizadas || 0);
    const attendantBase = Math.max(0, total - mtr - notDone);
    const attendantRate = Number(pct(attendant, attendantBase));
    const portfolioRate = Number(pct(attendant + mtr, total));
    const pendingControl = clamp(100 - Number(pct(pending, Math.max(1, total))));
    const confirmationVolumeScore = clamp((attendant / max.confirmacoes) * 100);
    const timeScore = row.tempo_medio_confirmacao_dias === null || row.tempo_medio_confirmacao_dias === undefined
      ? 70
      : clamp(100 - (Number(row.tempo_medio_confirmacao_dias || 0) * 15));
    const evolutionScore = 70;
    const directPerformance = clamp(
      attendantRate * 0.40 +
      pendingControl * 0.20 +
      timeScore * 0.15 +
      evolutionScore * 0.15 +
      confirmationVolumeScore * 0.10
    );
    const portfolioResult = clamp(
      portfolioRate * 0.55 +
      pendingControl * 0.25 +
      Number(pct(mtr, Math.max(1, total))) * 0.10 +
      clamp(100 - Number(pct(notDone, Math.max(1, total)))) * 0.10
    );
    const workloadIndex = clamp(
      (Number(row.total_os || 0) / max.total_os) * 40 +
      (Number(row.unidades || 0) / max.unidades) * 25 +
      (Number(row.clientes || 0) / max.clientes) * 15 +
      (Number(row.fornecedores || 0) / max.fornecedores) * 10 +
      (Number(row.pendencias_contingencia || 0) / max.pendencias) * 10
    );
    const weightedPerformance = clamp(
      directPerformance * 0.40 +
      portfolioResult * 0.25 +
      pendingControl * 0.20 +
      evolutionScore * 0.15
    );
    const classification = classificationFromScore(weightedPerformance);
    return {
      ...row,
      total,
      attendantBase,
      attendantRate,
      portfolioRate,
      pendingControl,
      workloadIndex,
      workloadLabel: workloadLabel(workloadIndex),
      directPerformance,
      portfolioResult,
      weightedPerformance,
      classification,
      evolution: null,
    };
  }).sort((a, b) => b.weightedPerformance - a.weightedPerformance || b.confirmacoes_atendente - a.confirmacoes_atendente);
}

function renderExecBars(selector, rows, valueKey, options = {}) {
  const max = Math.max(1, ...rows.map((row) => Number(row[valueKey] || 0)));
  const ordered = [...rows].sort((a, b) => Number(b[valueKey] || 0) - Number(a[valueKey] || 0));
  $(selector).innerHTML = ordered.length ? ordered.map((row) => {
    const value = Number(row[valueKey] || 0);
    const width = Math.max(value > 0 ? 3 : 0, Math.round((value / max) * 100));
    const suffix = options.suffix || "";
    const klass = options.className || "";
    return `
      <div class="bar-row executive-bar" title="${row.atendente}">
        <span>${row.atendente}</span>
        <div class="bar-track"><div class="bar-fill ${klass}" style="width:${width}%"></div></div>
        <strong>${value.toFixed(options.decimals ?? 0)}${suffix}</strong>
      </div>
    `;
  }).join("") : `<p>Nenhum dado disponível para o período.</p>`;
}

function renderAttendantExecutive(rawRows = []) {
  const rows = prepareAttendantExecutive(rawRows);
  const totals = sumRows(rows, ["total_os", "confirmacoes_atendente", "confirmacoes_mtr", "pendencias_contingencia", "nao_realizadas"]);
  const avgWeighted = rows.length ? rows.reduce((acc, row) => acc + row.weightedPerformance, 0) / rows.length : 0;
  $("#attendantSummary").innerHTML = `
    <article><span>Atendentes avaliados</span><strong>${rows.length}</strong></article>
    <article><span>Total de OS na carteira</span><strong>${totals.total_os || 0}</strong></article>
    <article><span>Confirmações do atendente</span><strong>${totals.confirmacoes_atendente || 0}</strong></article>
    <article><span>Fornecedor via MTR</span><strong>${totals.confirmacoes_mtr || 0}</strong></article>
    <article class="is-warn"><span>Pendência contingência</span><strong>${totals.pendencias_contingencia || 0}</strong></article>
    <article><span>Performance ponderada média</span><strong>${avgWeighted.toFixed(1)}%</strong></article>
  `;
  renderExecBars("#chartAtendentes", rows, "confirmacoes_atendente", { className: "fill-attendant" });
  renderExecBars("#chartAttendantRate", rows, "attendantRate", { suffix: "%", decimals: 1, className: "fill-attendant" });
  renderExecBars("#chartPortfolioRate", rows, "portfolioRate", { suffix: "%", decimals: 1, className: "fill-total" });
  renderExecBars("#chartContingency", rows, "pendencias_contingencia", { className: "fill-warning" });
  renderAttendantComposition(rows);
  renderAttendantWorkload(rows);
  renderAttendantMatrix(rows);
  renderAttendantEvolution(rows);
  renderAttendantHeatmap(rows);
}

function renderAttendantComposition(rows) {
  $("#chartComposition").innerHTML = rows.length ? rows.map((row) => {
    const base = Math.max(1, row.total);
    const attendantWidth = clamp((Number(row.confirmacoes_atendente || 0) / base) * 100);
    const mtrWidth = clamp((Number(row.confirmacoes_mtr || 0) / base) * 100);
    const pendingWidth = clamp((Number(row.pendencias_contingencia || 0) / base) * 100);
    return `
      <div class="stacked-row">
        <div><strong>${row.atendente}</strong><span>${row.total} OS</span></div>
        <div class="stacked-track">
          <span class="attendant" style="width:${attendantWidth}%"></span>
          <span class="mtr" style="width:${mtrWidth}%"></span>
          <span class="pending" style="width:${pendingWidth}%"></span>
        </div>
        <div class="stacked-values">
          <span>${row.confirmacoes_atendente} atendente</span>
          <span>${row.confirmacoes_mtr} MTR</span>
          <span>${row.pendencias_contingencia} pend.</span>
        </div>
      </div>
    `;
  }).join("") : `<p>Nenhum dado disponível para o período.</p>`;
}

function renderAttendantWorkload(rows) {
  $("#chartWorkload").innerHTML = rows.length ? rows.map((row) => `
    <article class="workload-card">
      <div><strong>${row.atendente}</strong><span>${row.workloadLabel} · ${row.workloadIndex.toFixed(1)}%</span></div>
      <div class="workload-metrics">
        <span>${row.total_os} OS</span>
        <span>${row.unidades} unidades</span>
        <span>${row.clientes} clientes</span>
        <span>${row.fornecedores} fornecedores</span>
      </div>
      <div class="bar-track slim"><div class="bar-fill fill-info" style="width:${row.workloadIndex}%"></div></div>
    </article>
  `).join("") : `<p>Nenhum dado disponível para o período.</p>`;
}

function renderAttendantMatrix(rows) {
  $("#attendantMatrix").innerHTML = `
    <div class="matrix-axis y">Performance ponderada</div>
    <div class="matrix-axis x">Carga operacional</div>
    <div class="matrix-quadrant top-left">Capacidade disponível</div>
    <div class="matrix-quadrant top-right">Destaque / Referência</div>
    <div class="matrix-quadrant bottom-left">Necessita acompanhamento</div>
    <div class="matrix-quadrant bottom-right">Prioridade de apoio</div>
    ${rows.map((row) => {
      const size = 22 + clamp(row.total / Math.max(1, ...rows.map((item) => item.total)) * 24);
      return `<span class="matrix-bubble ${row.classification.className}" title="${row.atendente}: carga ${row.workloadIndex.toFixed(1)}%, performance ${row.weightedPerformance.toFixed(1)}%" style="left:${clamp(row.workloadIndex, 4, 94)}%; bottom:${clamp(row.weightedPerformance, 6, 92)}%; width:${size}px; height:${size}px">${row.atendente.slice(0, 2)}</span>`;
    }).join("")}
  `;
}

function renderAttendantEvolution(rows) {
  $("#attendantEvolution").innerHTML = rows.length ? rows.map((row) => `
    <article>
      <strong>${row.atendente}</strong>
      <span>Período atual: ${row.weightedPerformance.toFixed(1)}%</span>
      <span>Período anterior: n/d</span>
      <span>Variação: aguardando seleção comparativa</span>
    </article>
  `).join("") : `<p>Nenhum dado disponível para o período.</p>`;
}

function heatCell(value, suffix = "", inverse = false) {
  const number = Number(value || 0);
  const score = inverse ? 100 - number : number;
  const klass = score >= 85 ? "heat-good" : score >= 70 ? "heat-mid" : score >= 50 ? "heat-high" : "heat-bad";
  return `<td class="${klass}"><strong>${number.toFixed(Number.isInteger(number) ? 0 : 1)}${suffix}</strong></td>`;
}

function renderAttendantHeatmap(rows) {
  $("#attendantHeatmapTable").innerHTML = rows.map((row) => `
    <tr>
      <td><strong>${row.atendente}</strong></td>
      <td>${row.clientes}</td>
      <td>${row.unidades}</td>
      <td>${row.fornecedores}</td>
      <td>${row.total_os}</td>
      <td>${row.os_sob_demanda}</td>
      <td>${row.os_robo_programada}</td>
      <td>${row.confirmacoes_atendente}</td>
      <td>${row.confirmacoes_mtr}</td>
      ${heatCell(row.attendantRate, "%")}
      ${heatCell(row.portfolioRate, "%")}
      ${heatCell(row.pendencias_contingencia, "", true)}
      <td>${row.nao_realizadas}</td>
      ${heatCell(row.workloadIndex, "%")}
      ${heatCell(row.directPerformance, "%")}
      ${heatCell(row.portfolioResult, "%")}
      ${heatCell(row.weightedPerformance, "%")}
      <td><span class="badge ${row.classification.className}">${row.classification.label}</span></td>
    </tr>
  `).join("") || `<tr><td colspan="18">Nenhum atendente encontrado no período.</td></tr>`;
}

function renderSupplierPerformance(rows = []) {
  const missingSupplier = rows.find((row) => row.label === "Não informado");
  const supplierRows = rows.filter((row) => row.label !== "Não informado");
  const riskRank = { "is-bad": 5, "is-high": 4, "is-mid": 3, "is-low": 2, "is-good": 1 };
  const supplierMetricValue = (row, key) => {
    const base = Number(row.coletas_agendadas || row.total || 0);
    const mtrRate = Number(pct(row.confirmacoes_mtr || 0, base));
    const realPending = Number(row.pendentes_operacionais || row.pendentes_confirmacao || 0);
    if (key === "risk") return riskRank[supplierClass(row)] * 100000 + realPending * 100 + base;
    if (key === "rate_desc" || key === "rate_asc") return mtrRate;
    if (key === "total") return base;
    if (key === "pending") return realPending;
    if (key === "attendant") return Number(row.confirmacoes_manuais || 0);
    return base;
  };
  const sorted = [...supplierRows].sort((a, b) => {
    const key = supplierSort.key;
    const dir = key === "rate_asc" ? "asc" : supplierSort.dir;
    const diff = supplierMetricValue(a, key) - supplierMetricValue(b, key);
    return dir === "asc" ? diff : -diff;
  });
  const totals = {
    fornecedores: supplierRows.length,
    critical: supplierRows.filter((row) => supplierBucket(row) === "critical").length,
    attention: supplierRows.filter((row) => supplierBucket(row) === "attention").length,
    high: supplierRows.filter((row) => supplierBucket(row) === "high").length,
    good: supplierRows.filter((row) => supplierBucket(row) === "good").length,
    low: supplierRows.filter((row) => supplierBucket(row) === "low").length,
    semMtr: supplierRows.reduce((sum, row) => sum + Number(row.sem_confirmacao_fornecedor_mtr ?? row.pendentes_confirmacao_fornecedor ?? 0), 0),
    pendencias: supplierRows.reduce((sum, row) => sum + Number(row.pendentes_operacionais || 0), 0),
    semFornecedor: Number(missingSupplier?.coletas_agendadas || missingSupplier?.total || 0),
  };
  $("#supplierOverview").innerHTML = `
    <article><span>Fornecedores</span><strong>${totals.fornecedores}</strong></article>
    <article class="is-bad"><span>Críticos</span><strong>${totals.critical}</strong></article>
    <article class="is-high"><span>Atenção alta</span><strong>${totals.high}</strong></article>
    <article class="is-mid"><span>Atenção</span><strong>${totals.attention}</strong></article>
    <article class="is-good"><span>OK</span><strong>${totals.good}</strong></article>
    <article class="is-low"><span>Baixo volume</span><strong>${totals.low}</strong></article>
    <article><span>Sem confirmação do fornecedor via MTR</span><strong>${totals.semMtr}</strong></article>
    <article><span>Agendadas em aberto/vencidas</span><strong>${totals.pendencias}</strong></article>
    <article class="is-info"><span>Sem fornecedor</span><strong>${totals.semFornecedor}</strong></article>
  `;

  const visible = sorted;
  const topImpact = [...supplierRows].sort((a, b) => Number(b.pendentes_operacionais || b.pendentes_confirmacao || 0) - Number(a.pendentes_operacionais || a.pendentes_confirmacao || 0)).slice(0, 3);
  const best = [...supplierRows]
    .filter((row) => Number(row.coletas_agendadas || row.total || 0) > 0)
    .sort((a, b) => (Number(b.confirmacoes_mtr || 0) / Number(b.coletas_agendadas || b.total || 1)) - (Number(a.confirmacoes_mtr || 0) / Number(a.coletas_agendadas || a.total || 1)))
    .slice(0, 3);
  $("#supplierDecision").innerHTML = `
    <section>
      <h3>Prioridade de ação</h3>
      ${topImpact.map((row) => `<div><strong>${shortSupplierName(row.label)}</strong><span>${row.pendentes_operacionais || row.pendentes_confirmacao || 0} agendadas em aberto/vencidas · ${row.sem_confirmacao_fornecedor_mtr ?? row.pendentes_confirmacao_fornecedor ?? 0} sem confirmação do fornecedor via MTR</span></div>`).join("")}
    </section>
    <section>
      <h3>Melhor aderência</h3>
      ${best.map((row) => `<div><strong>${shortSupplierName(row.label)}</strong><span>${pct(row.confirmacoes_mtr, row.coletas_agendadas || row.total)}% fornecedor via MTR · ${row.confirmacoes_mtr} confirmações</span></div>`).join("")}
    </section>
  `;

  if ($("#supplierRanking")) {
    $("#supplierRanking").innerHTML = visible.slice(0, 6).map((row, index) => {
    const base = Number(row.coletas_agendadas || row.total || 0);
    const rate = pct(row.confirmacoes_mtr, base);
    const manualRate = Math.min(100, Number(pct(row.confirmacoes_manuais, base)));
    const mtrRate = Math.min(100, Number(rate));
    const missingRate = Math.max(0, 100 - mtrRate - manualRate);
    const klass = supplierClass(row);
    const status = performanceLabel(klass);
    const recommendation = supplierRecommendation(row);
    const withoutSupplierMtr = row.sem_confirmacao_fornecedor_mtr ?? row.pendentes_confirmacao_fornecedor ?? 0;
    const realPending = row.pendentes_operacionais || row.pendentes_confirmacao || 0;
    return `
      <article class="supplier-rank ${klass}">
        <div class="rank-number">${index + 1}</div>
        <div>
          <h3>${row.label}</h3>
          <div class="supplier-meta">
            <span>${base} coletas</span>
            <span>${row.confirmacoes_mtr} fornecedor via MTR</span>
            <span>${row.confirmacoes_manuais} atendente</span>
            <span class="supplier-info">${withoutSupplierMtr} sem confirmação do fornecedor via MTR</span>
            <strong>${realPending} agendadas em aberto/vencidas</strong>
          </div>
          <div class="supplier-stack" title="Verde: fornecedor via MTR | Azul: atendente | Cinza: sem confirmação do fornecedor via MTR">
            <span class="mtr" style="width:${mtrRate}%"></span>
            <span class="manual" style="width:${manualRate}%"></span>
            <span class="missing" style="width:${missingRate}%"></span>
          </div>
          <div class="rank-score">
            <strong>${rate}%</strong>
            <span>${status} · ${recommendation}</span>
          </div>
        </div>
      </article>
    `;
    }).join("") || `<p>Nenhum fornecedor encontrado.</p>`;
  }

  $("#suppliersTable").innerHTML = visible.map((row) => {
    const base = Number(row.coletas_agendadas || row.total || 0);
    const rate = pct(row.confirmacoes_mtr, base);
    const withoutSupplierMtr = row.sem_confirmacao_fornecedor_mtr ?? row.pendentes_confirmacao_fornecedor ?? 0;
    const realPending = row.pendentes_operacionais || row.pendentes_confirmacao || 0;
    return `
      <tr class="${supplierClass(row)}">
        <td>${row.label}</td>
        <td>${base}</td>
        <td><strong>${rate}%</strong></td>
        <td>${row.confirmacoes_mtr}</td>
        <td>${pill(withoutSupplierMtr)}</td>
        <td>${row.confirmacoes_manuais}</td>
        <td>${pill(realPending)}</td>
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
  renderSearchFilter(selector);
}

function filterSummaryLabel(selector) {
  const select = $(selector);
  const selected = Array.from(select.selectedOptions).map((option) => option.textContent.trim()).filter(Boolean);
  if (!selected.length) return "Todos";
  if (selected.length <= 2) return selected.join(", ");
  return `${selected.slice(0, 2).join(", ")} +${selected.length - 2}`;
}

function searchFilterContainer(selector) {
  return $(`.search-filter[data-select="${selector}"]`);
}

function escapeAttr(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function visibleFilterValues(container) {
  return Array.from(container.querySelectorAll(".filter-option:not(.hidden) input")).map((input) => input.value);
}

function renderSearchFilter(selector) {
  const container = searchFilterContainer(selector);
  const select = $(selector);
  if (!container || !select) return;
  const query = (container.querySelector(".filter-search")?.value || "").trim().toLowerCase();
  const selected = new Set(selectedValues(selector));
  const options = Array.from(select.options);
  const visible = options.filter((option) => option.value.toLowerCase().includes(query));
  const summary = filterSummaryLabel(selector);
  const summaryEl = container.querySelector(".filter-summary");
  summaryEl.textContent = summary;
  summaryEl.title = summary === "Todos" ? "" : summary;
  container.querySelector(".filter-options").innerHTML = visible.length ? visible.map((option) => `
    <label class="filter-option" title="${escapeAttr(option.textContent)}">
      <input type="checkbox" value="${escapeAttr(option.value)}" ${selected.has(option.value) ? "checked" : ""}>
      <span>${escapeAttr(option.textContent)}</span>
    </label>
  `).join("") : `<div class="filter-empty">Nenhum resultado encontrado.</div>`;
}

function setMultiSelectValues(selector, values) {
  const wanted = new Set(values);
  Array.from($(selector).options).forEach((option) => {
    option.selected = wanted.has(option.value);
  });
  renderSearchFilter(selector);
}

function closeSearchFilters(except = null) {
  $$(".search-filter.open").forEach((container) => {
    if (container === except) return;
    container.classList.remove("open");
    container.querySelector(".filter-trigger")?.setAttribute("aria-expanded", "false");
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
  const groups = selectedValues("#contractGroupFilter");
  const owners = selectedValues("#ownerFilter");
  const selectedUnits = selectedValues("#unitFilter");
  const suppliers = selectedValues("#supplierFilter");
  const manualUsers = selectedValues("#manualUserFilter");
  const hasAny = (selected, value) => !selected.length || selected.includes(value);
  const groupLabel = (row) => `${row.grupo_contratual_codigo ? `${row.grupo_contratual_codigo} - ` : ""}${row.grupo_contratual_nome || "Não identificado"}`;
  const unitOwner = new Map(units.map((row) => [row.unidade, row.responsavel_operacional]));
  const ownerUnitScope = units.filter((row) => (
    hasAny(groups, groupLabel(row)) &&
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
  populateMultiSelect("#tableUnitSupplierUnitFilter", filteredSupplierRows.map((row) => row.unidade));
  populateMultiSelect("#tableUnitSupplierSupplierFilter", filteredSupplierRows.map((row) => row.fornecedor));
  const tableUnits = selectedValues("#tableUnitSupplierUnitFilter");
  const tableSuppliers = selectedValues("#tableUnitSupplierSupplierFilter");
  const tableSupplierRows = filteredSupplierRows.filter((row) => (
    hasAny(tableUnits, row.unidade) &&
    hasAny(tableSuppliers, row.fornecedor)
  ));
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
    const totals = sumRows(supplierScope, ["total_os_abertas", "coletas_agendadas", "total_confirmadas", "confirmacoes_manuais", "confirmacoes_mtr", "pendentes_confirmacao_fornecedor", "pendentes_confirmacao", "agendadas_vencidas_sem_evidencia", "agenda_futura_no_prazo", "nao_realizadas", "precisam_acao"]);
    const manualTotals = manualUsers.length ? sumRows(manualScope, ["confirmacoes_manuais"]) : {};
    return {
      ...row,
      total_os_abertas: totals.total_os_abertas,
      coletas_agendadas: totals.coletas_agendadas,
      confirmadas: (manualUsers.length ? Number(manualTotals.confirmacoes_manuais || 0) + Number(totals.confirmacoes_mtr || 0) : totals.total_confirmadas),
      confirmacoes_manuais: (manualUsers.length ? manualTotals.confirmacoes_manuais : totals.confirmacoes_manuais),
      confirmacoes_mtr: totals.confirmacoes_mtr,
      pendentes_confirmacao: totals.pendentes_confirmacao,
      agendadas_vencidas_sem_evidencia: totals.agendadas_vencidas_sem_evidencia,
      agenda_futura_no_prazo: totals.agenda_futura_no_prazo,
      pendentes_confirmacao_fornecedor: totals.pendentes_confirmacao_fornecedor,
      nao_realizadas: totals.nao_realizadas,
      precisam_acao: totals.precisam_acao,
    };
  });
  const filteredOwners = aggregateBy(computedUnits, "responsavel_operacional", ["total_os_abertas", "coletas_agendadas", "confirmadas", "confirmacoes_manuais", "confirmacoes_mtr", "pendentes_confirmacao", "agendadas_vencidas_sem_evidencia", "agenda_futura_no_prazo", "nao_realizadas"]);
  const scopeTotals = sumRows(computedUnits, ["total_os_abertas", "coletas_agendadas", "confirmadas", "confirmacoes_manuais", "confirmacoes_mtr", "pendentes_confirmacao", "agendadas_vencidas_sem_evidencia", "agenda_futura_no_prazo", "pendentes_confirmacao_fornecedor", "nao_realizadas"]);
  const groupsInScope = new Set(computedUnits.map(groupLabel));

  $("#scopeSummary").innerHTML = `
    <article><span>Grupos no filtro</span><strong>${groupsInScope.size}</strong></article>
    <article><span>Unidades no filtro</span><strong>${computedUnits.length}</strong></article>
    <article><span>OS abertas no período</span><strong>${scopeTotals.total_os_abertas || 0}</strong></article>
    <article><span>Confirmadas</span><strong>${scopeTotals.confirmadas || 0}</strong></article>
    <article><span>Atendente</span><strong>${scopeTotals.confirmacoes_manuais || 0}</strong></article>
    <article><span>Fornecedor via MTR</span><strong>${scopeTotals.confirmacoes_mtr || 0}</strong></article>
    <article class="is-warn"><span>Agendadas em aberto/vencidas</span><strong>${scopeTotals.pendentes_confirmacao || 0}</strong></article>
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
  `).join("") || `<tr><td colspan="4">Nenhuma confirmação do atendente encontrada para o filtro selecionado.</td></tr>`;

  $("#collabUnitSupplierTable").innerHTML = tableSupplierRows.map((row) => `
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
      <td>${row.unidade}<br><span class="subtle-cell">${groupLabel(row)}</span></td>
      <td>${row.coletas_agendadas}</td>
      <td>${row.confirmadas}</td>
      <td>${row.confirmacoes_manuais}</td>
      <td>${row.confirmacoes_mtr}</td>
      <td>${row.pendentes_confirmacao}</td>
      <td>${row.nao_realizadas}</td>
    </tr>
  `).join("");

  $("#unitCards").innerHTML = computedUnits.map((row) => {
    const totalOsAbertas = Number(row.total_os_abertas || row.total || row.coletas_agendadas || 0);
    const coletasAgendadas = row.coletas_agendadas;
    const confirmadas = row.confirmadas;
    const manuais = row.confirmacoes_manuais;
    const viaMtr = row.confirmacoes_mtr;
    const pendentesFornecedor = row.pendentes_confirmacao_fornecedor ?? Math.max(0, row.coletas_agendadas - row.confirmacoes_mtr);
    const naoRealizadas = Number(row.nao_realizadas || 0);
    const saldoAberto = Math.max(0, Number(totalOsAbertas || 0) - Number(manuais || 0) - Number(viaMtr || 0) - naoRealizadas);
    const abertasSemConfirmacao = Math.max(Number(row.pendentes_confirmacao || 0), saldoAberto);
    const abertasVencidas = Number(row.agendadas_vencidas_sem_evidencia ?? abertasSemConfirmacao);
    const agendaFutura = Number(row.agenda_futura_no_prazo || 0);
    const totalExplicado = Number(manuais || 0) + Number(viaMtr || 0) + naoRealizadas + abertasSemConfirmacao;
    const unitPending = pending.filter((item) => item.unidade === row.unidade && hasAny(suppliers, item.fornecedor));
    const unitPendingConfirmation = pendingConfirmation.filter((item) => item.unidade === row.unidade && hasAny(suppliers, item.fornecedor));
    const totalRate = pct(confirmadas, totalOsAbertas);
    const attendantBase = Math.max(0, Number(totalOsAbertas || 0) - Number(viaMtr || 0) - naoRealizadas);
    const manualRate = pct(manuais, attendantBase);
    const totalClass = metricClass(totalRate, 80, 60, 30);
    const manualClass = metricClass(manualRate, 70, 50, 30);
    const cardClass = criticality(totalOsAbertas, confirmadas, abertasSemConfirmacao, abertasVencidas).className;
    const pendingConfirmationIds = new Set(unitPendingConfirmation.map((item) => item.id));
    const scheduledPending = unitPending.filter((item) => !pendingConfirmationIds.has(item.id) && String(item.status_original || "").toUpperCase() !== "NÃO REALIZADA");
    const otherPending = unitPending.filter((item) => !pendingConfirmationIds.has(item.id) && String(item.status_original || "").toUpperCase() === "NÃO REALIZADA");
    const pendingConfirmationText = `${abertasSemConfirmacao} OS agendadas em aberto/vencidas sem confirmação`;
    const futureText = agendaFutura ? `<span>${agendaFutura} agenda futura/no prazo</span>` : "";
    const explainedText = totalExplicado !== Number(totalOsAbertas || 0)
      ? `<span class="meta-info">Total explicado: ${totalExplicado} de ${totalOsAbertas} OS</span>`
      : `<span class="meta-info">Total explicado: ${totalExplicado} OS</span>`;
    const renderPendingButtons = (items) => items.map((item) => `
      <button class="pending-os" type="button" data-order-id="${item.id}">
        <strong>OS ${item.numero_os}</strong>
        <span>${item.status_original} · ${fmtDate(item.data_agendada)} · ${item.prazo}</span>
        <span>${item.fornecedor || "Fornecedor não informado"}</span>
      </button>
    `).join("");
    const pendingList = (unitPending.length || unitPendingConfirmation.length) ? `
      <div class="pending-list">
        ${unitPendingConfirmation.length ? `<div class="pending-group-title">${unitPendingConfirmation.length} OS agendadas em aberto/vencidas sem confirmação</div>${renderPendingButtons(unitPendingConfirmation)}` : ""}
        ${scheduledPending.length ? `<div class="pending-group-title">${scheduledPending.length} OS agendadas em aberto/vencidas</div>${renderPendingButtons(scheduledPending)}` : ""}
        ${otherPending.length ? `<div class="pending-group-title">${otherPending.length} outras pendências operacionais</div>${renderPendingButtons(otherPending)}` : ""}
      </div>
    ` : `<div class="pending-list empty">Nenhuma pendência operacional aberta.</div>`;
    return `
      <article class="unit-card ${cardClass}" data-unit="${row.unidade}">
        <div class="unit-card-top">
          <h3>${row.unidade}</h3>
          <span class="status-chip">${performanceLabel(cardClass)}</span>
        </div>
        <div class="unit-owner group-chip">${groupLabel(row)}</div>
        <div class="unit-owner">${row.responsavel_operacional}</div>
        <div class="card-metric">
          <div>
            <span>% de Coletas Confirmadas</span>
            <strong>${totalRate}%</strong>
          </div>
          <div class="metric-bar metric-total ${totalClass}"><span style="width:${Math.max(2, Math.min(100, Number(totalRate)))}%"></span></div>
        </div>
        <div class="card-metric secondary">
          <div>
            <span>Coletas confirmadas pelo atendente</span>
            <strong>${manualRate}%</strong>
          </div>
          <div class="metric-bar metric-attendant ${manualClass}"><span style="width:${Math.max(2, Math.min(100, Number(manualRate)))}%"></span></div>
        </div>
        <div class="unit-meta">
          <span>Total de ${totalOsAbertas} OS abertas dentro do período</span>
          <span>${manuais} coletas confirmadas pelo atendente</span>
          <span>${viaMtr} coletas confirmadas pelo fornecedor via MTR</span>
          <strong class="meta-pending">${pendingConfirmationText}</strong>
          ${futureText}
          <span class="meta-fail">${naoRealizadas} coletas não realizadas</span>
          ${explainedText}
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

function csvEscape(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function updateCsvExport(rows = []) {
  const link = $("#exportCsv");
  if (!link || !window.sigraStaticApi) return;
  const headers = [
    "numero_os", "cliente", "unidade", "regional", "fornecedor", "tipo_residuo",
    "status_original", "status_gerencial", "origem_os", "responsavel_abertura",
    "origem_confirmacao", "responsavel_confirmacao", "data_agendada",
    "data_realizacao", "data_realizada", "produtividade_manual", "precisa_acao",
  ];
  const csv = [headers.join(";"), ...rows.map((row) => headers.map((key) => csvEscape(row[key])).join(";"))].join("\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  if (link.dataset.objectUrl) URL.revokeObjectURL(link.dataset.objectUrl);
  const url = URL.createObjectURL(blob);
  link.dataset.objectUrl = url;
  link.href = url;
  link.download = "base-os-sigra.csv";
}

async function loadDashboard(importId = currentImportId) {
  if (!scopeApplied) {
    clearDashboard();
    return;
  }
  const params = new URLSearchParams({ import_id: importId });
  if (dateFilter.from) params.set("date_from", dateFilter.from);
  if (dateFilter.to) params.set("date_to", dateFilter.to);
  if (waveFilter && waveFilter !== "all") params.set("wave_id", waveFilter);
  dashboardData = await api(`/api/dashboard?${params.toString()}`);
  if (!dashboardData.has_data) {
    renderOverview();
    renderBars("#chartStatusGerencial", []);
    showAlert("Nenhuma planilha foi importada ainda. Use o botão Subir planilha para começar.");
    return;
  }

  currentImportId = dateFilter.from || dateFilter.to ? "latest" : dashboardData.import.id;
  const imp = dashboardData.import;
  const sourceLabel = dateFilter.from || dateFilter.to ? "histórico importado" : `${imp.row_count} linhas importadas`;
  const waveText = $("#waveFilter")?.selectedOptions?.[0]?.textContent || "Todas as ondas";
  const dataSource = dashboardData.analysis?.source_label || imp.source_label || "";
  $("#periodLabel").textContent = `Período analisado: ${imp.period_start_label || "-"} a ${imp.period_end_label || "-"} | ${sourceLabel} | ${waveText}${dataSource ? ` | ${dataSource}` : ""}`;
  renderOverview(dashboardData.kpis);
  renderActiveDetailView();
  updateStatusFilter(dashboardData.charts.status_gerencial);

  if (imp.warning_count) {
    showAlert(`${imp.warning_count} alerta(s) encontrados nesta importação: duplicidades, dados ausentes, atrasos ou inconsistências entre status e datas.`);
  } else {
    hideAlert();
  }
}

function renderActiveDetailView() {
  if (!dashboardData?.has_data) return;
  const active = document.querySelector(".view.active")?.id || "overview";
  if (active === "attendants") {
    renderAttendantExecutive(dashboardData.performance.atendentes_executivo || []);
  }
  if (active === "suppliers") {
    renderSupplierPerformance(dashboardData.performance.fornecedores);
  }
  if (active === "collabUnits") {
    populateMultiSelect("#contractGroupFilter", dashboardData.performance.unidades.map((row) => `${row.grupo_contratual_codigo ? `${row.grupo_contratual_codigo} - ` : ""}${row.grupo_contratual_nome || "Não identificado"}`));
    populateMultiSelect("#ownerFilter", dashboardData.performance.responsaveis_operacionais.map((row) => row.label));
    populateMultiSelect("#unitFilter", dashboardData.performance.unidades.map((row) => row.unidade));
    populateMultiSelect("#supplierFilter", dashboardData.performance.colaborador_unidade_fornecedor.map((row) => row.fornecedor));
    populateMultiSelect("#manualUserFilter", dashboardData.performance.colaborador_unidade.map((row) => row.colaborador));
    renderCollaboratorUnit();
  }
  if (active === "dashboard") {
    renderBars("#chartStatusGerencial", dashboardData.charts.status_gerencial);
    renderBars("#chartConfirmacao", dashboardData.charts.origem_confirmacao);
    renderBars("#chartUnidades", dashboardData.charts.unidades);
    renderBars("#chartResiduos", dashboardData.charts.residuos);
  }
}

function conferenceMetric(label, value, klass = "") {
  return `<article class="conference-card ${klass}"><span>${label}</span><strong>${value ?? 0}</strong></article>`;
}

function conferenceLines(rows, labelKey, valueKey, extra = () => "") {
  return (rows || []).slice(0, 80).map((row) => `
    <div class="conference-line">
      <span title="${row[labelKey] || ""}">${row[labelKey] || "Não informado"} ${extra(row)}</span>
      <strong>${row[valueKey] ?? 0}</strong>
    </div>
  `).join("") || `<p>Nenhum registro encontrado.</p>`;
}

function renderImportConference(item, readonly = false) {
  const conference = item.conference || {};
  const general = conference.dados_gerais || {};
  const comp = conference.comparacao || {};
  conferenceImportId = item.id;
  $("#conferenceSubtitle").textContent = `${item.file_name} · ${item.period_start_label || "-"} a ${item.period_end_label || "-"} · status ${item.status}`;
  $("#conferenceContent").innerHTML = `
    <section class="conference-section">
      <h3>Dados gerais do arquivo</h3>
      <div class="conference-grid">
        ${conferenceMetric("Linhas lidas", general.linhas)}
        ${conferenceMetric("OS únicas", general.os_unicas)}
        ${conferenceMetric("Duplicidades internas", general.duplicidades_internas)}
        ${conferenceMetric("Ausências", general.ausencias)}
        ${conferenceMetric("Inconsistências", general.inconsistencias)}
        ${conferenceMetric("Unidades", general.unidades)}
        ${conferenceMetric("Fornecedores", general.fornecedores)}
        ${conferenceMetric("Usuários/atendentes", general.usuarios_atendentes)}
      </div>
    </section>
    <section class="conference-section">
      <h3>Comparação com importações anteriores</h3>
      <div class="conference-grid">
        ${conferenceMetric("Período igual", comp.periodo_igual ? "Sim" : "Não")}
        ${conferenceMetric("Período sobreposto", comp.periodo_sobreposto ? "Sim" : "Não")}
        ${conferenceMetric("OS já existentes", comp.os_existentes)}
        ${conferenceMetric("OS novas", comp.os_novas)}
        ${conferenceMetric("OS atualizadas", comp.os_atualizadas)}
        ${conferenceMetric("Mudaram status", comp.os_mudaram_status)}
        ${conferenceMetric("OS ausentes na nova", comp.os_nao_presentes_nova_importacao)}
        ${conferenceMetric("Importações impactadas", (comp.importacoes_impactadas || []).length)}
      </div>
      <div class="conference-list">
        ${(comp.importacoes_impactadas || []).map((imp) => `
          <div class="conference-line">
            <span>${imp.file_name}<br><small>${fmtDate(imp.period_start)} a ${fmtDate(imp.period_end)} · ${imp.status}</small></span>
            <strong>${imp.unique_os_count || 0} OS</strong>
          </div>
        `).join("") || `<p>Nenhuma importação anterior impactada.</p>`}
      </div>
    </section>
    <section class="conference-section">
      <h3>Alertas</h3>
      <div class="conference-alerts">
        ${(conference.alertas || []).map((alert) => `<div>${alert}</div>`).join("") || `<p>Nenhum alerta relevante encontrado.</p>`}
      </div>
    </section>
    <div class="grid two">
      <section class="conference-section">
        <h3>Unidades encontradas</h3>
        <div class="conference-list">${conferenceLines(conference.unidades, "unidade", "total_os", (row) => `<small>· ${row.situacao}</small>`)}</div>
      </section>
      <section class="conference-section">
        <h3>Fornecedores considerados</h3>
        <div class="conference-list">${conferenceLines(conference.fornecedores, "fornecedor", "total_os", (row) => row.fornecedor_original_vazio === "Sim" ? `<small>· fallback ${row.fonte_fornecedor_considerado}</small>` : "")}</div>
      </section>
    </div>
    <section class="conference-section">
      <h3>Log de decisão</h3>
      <div class="conference-list">
        ${(item.decision_log || []).map((entry) => `
          <div class="conference-line"><span>${entry.acao || entry.decisao || "ação"} · ${entry.usuario || "Usuário local"}<br><small>${entry.em || ""}</small></span><strong>${entry.status || entry.decisao || ""}</strong></div>
        `).join("") || `<p>Nenhum log registrado.</p>`}
      </div>
    </section>
  `;
  $$(".conference-actions button").forEach((button) => {
    button.disabled = readonly || !item.status?.includes("Pendente");
  });
  $("#replacementReason").disabled = readonly || !item.status?.includes("Pendente");
  $("#conferenceImportType").value = item.import_type || "Operacional";
  $("#conferenceImportType").disabled = readonly || !item.status?.includes("Pendente");
  $("#importConferenceDialog").showModal();
}

async function loadImports() {
  const payload = await api("/api/imports");
  const importActions = (item) => {
    const pending = String(item.status || "").includes("Pendente");
    const excluded = String(item.status || "").includes("Excluída") || String(item.status || "").includes("Cancelada");
    return `
      <button type="button" data-import-action="details" data-import-id="${item.id}">Detalhes</button>
      ${pending ? `<button type="button" data-import-action="conference" data-import-id="${item.id}">Conferir</button>` : ""}
      ${item.active
        ? `<button type="button" data-import-action="deactivate" data-import-id="${item.id}">Desconsiderar</button>`
        : (!excluded && !pending ? `<button type="button" data-import-action="activate" data-import-id="${item.id}">Ativar</button>` : "")}
      ${excluded ? "" : `<button type="button" data-import-action="reprocess" data-import-id="${item.id}">Reprocessar</button>`}
      ${excluded ? "" : `<button type="button" class="danger" data-import-action="delete" data-import-id="${item.id}">Excluir</button>`}
    `;
  };
  $("#importsTable").innerHTML = payload.imports.map((item) => `
    <tr data-import="${item.id}" class="${item.active ? "" : "is-muted"}">
      <td>${fmtDateTime(item.imported_at)}</td>
      <td>${item.file_name}</td>
      <td>${pill(item.import_type || "Operacional")}</td>
      <td>${item.period_start_label || "-"} a ${item.period_end_label || "-"}</td>
      <td>${item.row_count}</td>
      <td>${item.unique_os_count}</td>
      <td>${item.duplicate_count}</td>
      <td>${item.missing_required_count}</td>
      <td>${item.inconsistency_count}</td>
      <td>${pill(item.status)}</td>
      <td class="row-actions">${importActions(item)}</td>
    </tr>
  `).join("");
  $$("#importsTable tr").forEach((row) => {
    row.addEventListener("click", async (event) => {
      if (event.target.closest("button")) return;
      currentImportId = row.dataset.import;
      scopeApplied = true;
      dateFilter = { from: "", to: "" };
      $("#dateFrom").value = "";
      $("#dateTo").value = "";
      await refreshAll();
      activateView("overview");
    });
  });
  if ($("#imports")?.classList.contains("active")) await loadDataSourceSummary();
  return payload.imports || [];
}

async function loadDataSourceSummary() {
  if (!window.sigraStaticApi) return;
  const source = await api("/api/data-source");
  const label = $("#dataSourceLabel");
  const hint = $("#dataSourceHint");
  if (label) label.textContent = `Fonte dos dados: ${source.source_label}`;
  if (hint) {
    hint.textContent = source.mode === "official"
      ? "Todos veem a base oficial versionada no repositório."
      : "Importações locais ficam salvas apenas neste navegador e não alteram o repositório.";
  }
  const target = $("#dataSourceSummary");
  if (!target) return;
  const official = (source.imports || []).filter((item) => item.source === "official");
  const local = (source.imports || []).filter((item) => item.source === "local");
  const diag = source.diagnostics || {};
  const clientDiag = diag.clientes || {};
  const userDiag = diag.usuarios || {};
  const waveDiag = diag.ondas || {};
  target.innerHTML = `
    <div class="source-meta">
      <article><span>Modo atual</span><strong>${source.source_label}</strong></article>
      <article><span>Origem dos dados</span><strong>${source.origin}</strong></article>
      <article><span>Arquivos oficiais</span><strong>${diag.arquivos_carregados ?? official.length}</strong></article>
      <article><span>Análises locais</span><strong>${local.length}</strong></article>
    </div>
    <section class="diagnostics-panel">
      <h3>Diagnóstico da Base</h3>
      <div class="source-meta">
        <article><span>OS lidas</span><strong>${diag.os_lidas || 0}</strong></article>
        <article><span>OS únicas</span><strong>${diag.os_unicas || 0}</strong></article>
        <article><span>Linhas clientes</span><strong>${clientDiag.linhas_lidas || 0}</strong></article>
        <article><span>Unidades com match cadastral</span><strong>${clientDiag.unidades_os_com_match || 0}</strong></article>
        <article><span>Usuários humanos</span><strong>${userDiag.humanos_encontrados || 0}</strong></article>
        <article><span>Sistêmicos ignorados</span><strong>${userDiag.sistemicos_ignorados || 0}</strong></article>
        <article><span>Onda 0 unidades</span><strong>${waveDiag.onda_0_unidades || 0}</strong></article>
        <article><span>Onda 1 unidades</span><strong>${waveDiag.onda_1_unidades || 0}</strong></article>
      </div>
      <div class="diagnostics-list">
        <strong>Usuários identificados:</strong>
        <span>${(userDiag.lista || []).slice(0, 18).join(", ") || "Nenhum usuário humano identificado."}</span>
      </div>
      <div class="diagnostics-list">
        <strong>OS por onda:</strong>
        <span>${(waveDiag.os_por_onda || []).map((row) => `${row.nome}: ${row.os} OS / ${row.unidades} unidades`).join(" · ") || "Nenhuma onda vinculada."}</span>
      </div>
    </section>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Arquivo</th>
            <th>Origem</th>
            <th>Tipo</th>
            <th>Período</th>
            <th>OS lidas</th>
            <th>OS únicas</th>
            <th>Mudança status</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${[...(source.imports || []), ...(source.client_imports || [])].map((item) => `
            <tr>
              <td title="${item.caminho || ""}">${item.arquivo || "-"}</td>
              <td>${item.source === "official" ? "Repositório GitHub" : "Cache local"}</td>
              <td>${item.tipo || "-"}</td>
              <td>${item.periodo || "-"}</td>
              <td>${item.os_lidas ?? item.linhas_lidas ?? 0}</td>
              <td>${item.os_unicas ?? item.unidades_identificadas ?? 0}</td>
              <td>${item.mudanca_status || 0}</td>
              <td>${pill(item.status || "-")}</td>
            </tr>
          `).join("") || `<tr><td colspan="8">Nenhuma fonte carregada.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

async function handleImportAction(action, importId) {
  if (action === "details" || action === "conference") {
    const item = await api(`/api/imports/${importId}`);
    renderImportConference(item, action === "details" && !String(item.status || "").includes("Pendente"));
    return;
  }
  if (action === "delete" && !window.confirm("Excluir logicamente esta importação? As OS e o histórico ficam preservados, mas ela sai dos cálculos.")) {
    return;
  }
  if (action === "deactivate" && !window.confirm("Desconsiderar esta importação dos cálculos do dashboard? As OS ficam guardadas, mas não entram nos indicadores.")) {
    return;
  }
  if (action === "reprocess" && !window.confirm("Reprocessar esta importação com a regra de cálculo atual?")) {
    return;
  }
  await api(`/api/imports/${importId}/${action}`, { method: "POST" });
  if (currentImportId === importId && action !== "activate") {
    currentImportId = "latest";
  }
  await refreshAll();
}

async function loadOrders() {
  if (!scopeApplied) {
    currentOrders = [];
    renderOrdersTable();
    return;
  }
  const params = new URLSearchParams({
    import_id: currentImportId,
    search: $("#searchInput").value,
    status: $("#statusFilter").value,
    action: $("#actionFilter").value,
    limit: "500",
  });
  if (waveFilter && waveFilter !== "all") params.set("wave_id", waveFilter);
  if (!window.sigraStaticApi) $("#exportCsv").href = `/api/export/orders.csv?${params.toString()}`;
  const payload = await api(`/api/orders?${params.toString()}`);
  currentOrders = payload.rows;
  updateCsvExport(currentOrders);
  renderOrdersTable();
}

async function loadClientBase() {
  const payload = await api("/api/client-base");
  const imports = payload.imports || [];
  const groups = payload.groups || [];
  const units = payload.units || [];
  const active = imports.find((item) => item.status === "Ativa");
  $("#clientBaseSummary").innerHTML = `
    <article><span>Base ativa</span><strong>${active ? "Sim" : "Não"}</strong></article>
    <article><span>Grupos ativos</span><strong>${groups.length}</strong></article>
    <article><span>Unidades ativas</span><strong>${units.length}</strong></article>
    <article class="is-info"><span>Última atualização</span><strong>${active ? fmtDateTime(active.imported_at) : "-"}</strong></article>
  `;
  $("#clientGroupsTable").innerHTML = groups.map((row) => `
    <tr>
      <td>${row.codigo || "-"}</td>
      <td>${row.nome || "Não identificado"}</td>
      <td>${row.unidades || 0}</td>
    </tr>
  `).join("") || `<tr><td colspan="3">Nenhum grupo contratual ativo importado.</td></tr>`;
  $("#clientUnitsTable").innerHTML = units.map((row) => `
    <tr>
      <td>${[row.grupo_contratual_codigo, row.grupo_contratual_nome].filter(Boolean).join(" - ") || "Não identificado"}</td>
      <td>${row.cliente || "-"}</td>
      <td>${row.codigo_cliente || "-"}</td>
      <td>${row.unidade || "-"}</td>
      <td>${row.cliente_documento || "-"}</td>
      <td>${row.endereco || "-"}</td>
      <td>${[row.cidade, row.uf].filter(Boolean).join(" / ") || "-"}</td>
    </tr>
  `).join("") || `<tr><td colspan="7">Nenhuma unidade ativa importada.</td></tr>`;
  $("#clientBaseImportsTable").innerHTML = imports.map((row) => `
    <tr>
      <td>${fmtDateTime(row.imported_at)}</td>
      <td>${row.file_name}</td>
      <td>${row.row_count}</td>
      <td>${row.valid_count}</td>
      <td>${row.unidentified_count}</td>
      <td>${pill(row.status)}</td>
    </tr>
  `).join("") || `<tr><td colspan="6">Nenhuma importação de base de clientes realizada.</td></tr>`;
}

async function uploadClientBase(input) {
  const file = input.files[0];
  if (!file) return;
  const form = new FormData();
  form.append("file", file);
  showAlert("Importando base de clientes e atualizando vínculos de grupo contratual...");
  try {
    await api("/api/client-base/import", { method: "POST", body: form });
    await loadClientBase();
    if (scopeApplied) {
      await loadDashboard(currentImportId);
      await loadOrders();
    }
    hideAlert();
    activateView("settings");
  } catch (error) {
    showAlert(error.message, "error");
  } finally {
    input.value = "";
  }
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
    ["Grupo contratual", [row.grupo_contratual_codigo, row.grupo_contratual_nome].filter(Boolean).join(" - ")],
    ["Fonte do grupo contratual", row.grupo_contratual_fonte],
    ["Unidade", row.unidade],
    ["Regional", row.regional],
    ["Fornecedor", row.fornecedor],
    ["Fornecedor original vazio", row.fornecedor_original_vazio],
    ["Fornecedor considerado", row.fornecedor_considerado],
    ["Fonte do fornecedor considerado", row.fonte_fornecedor_considerado],
    ["Transportador", row.transportador],
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
    ["Conta como produtividade do atendente", row.produtividade_manual],
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
  let localMode = "local-only";
  if (window.sigraStaticApi) {
    const choice = window.prompt(
      "Como deseja usar esta planilha?\n\n1 - Analisar apenas esta planilha temporariamente\n2 - Combinar com a base oficial localmente\n\nDigite 1 ou 2. Cancelar fecha sem importar.",
      "1"
    );
    if (!choice) {
      input.value = "";
      return;
    }
    if (!["1", "2"].includes(choice.trim())) {
      showAlert("Opção inválida. Use 1 para análise local ou 2 para combinar com a base oficial.", "error");
      input.value = "";
      return;
    }
    localMode = choice.trim() === "2" ? "combine" : "local-only";
  }
  const form = new FormData();
  form.append("file", file);
  if (window.sigraStaticApi) form.append("mode", localMode);
  showAlert(window.sigraStaticApi
    ? "Importando análise local temporária. Ela não altera a base oficial do repositório..."
    : "Importando relatório de OS do SIGRA e validando dados...");
  try {
    const payload = await api("/api/import", { method: "POST", body: form });
    hideAlert();
    await loadImports();
    await loadDataSourceSummary();
    if (window.sigraStaticApi) {
      scopeApplied = true;
      currentImportId = "latest";
      await loadDashboard("latest");
      await loadOrders();
      activateView("overview");
      showAlert(localMode === "combine"
        ? "Fonte dos dados: Base oficial + análise local temporária. Esta simulação não altera a base oficial compartilhada."
        : "Fonte dos dados: Análise local temporária. Esta planilha não faz parte da base oficial compartilhada.");
      return;
    }
    activateView("imports");
    renderImportConference(payload.import);
  } catch (error) {
    showAlert(error.message, "error");
  } finally {
    input.value = "";
  }
}

async function applyImportDecision(decision) {
  if (!conferenceImportId) return;
  const labels = {
    activate: "ativar esta importação",
    replace: "substituir importações anteriores sobrepostas",
    separate: "manter como análise separada",
    cancel: "cancelar esta importação",
  };
  if (!window.confirm(`Confirmar decisão: ${labels[decision] || decision}?`)) return;
  const options = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      reason: $("#replacementReason").value || "",
      import_type: $("#conferenceImportType").value || "Operacional",
    }),
  };
  await api(`/api/imports/${conferenceImportId}/${decision}`, options);
  $("#importConferenceDialog").close();
  if (decision === "activate" || decision === "replace") {
    currentImportId = conferenceImportId;
    scopeApplied = true;
    dateFilter = { from: "", to: "" };
    $("#dateFrom").value = "";
    $("#dateTo").value = "";
  } else {
    currentImportId = "latest";
  }
  await refreshAll();
  activateView(decision === "activate" || decision === "replace" ? "overview" : "imports");
}

async function refreshAll() {
  await loadMeasurementSetup();
  await loadWaves(false);
  if (scopeApplied) {
    await loadDashboard(currentImportId);
  } else {
    clearDashboard();
  }
  await loadImports();
  await loadClientBase();
  if ($("#base")?.classList.contains("active")) await loadOrders();
}

function wireEvents() {
  applySidebarState();
  $("#sidebarToggle").addEventListener("click", () => {
    const collapsed = !document.body.classList.contains("sidebar-collapsed");
    localStorage.setItem("sigraSidebarUserSet", "true");
    localStorage.setItem("sigraSidebarCollapsed", String(collapsed));
    applySidebarState();
  });
  $$(".nav").forEach((button) => button.addEventListener("click", () => {
    activateView(button.dataset.view);
    renderActiveDetailView();
    if (button.dataset.view === "base") loadOrders().catch((error) => showAlert(error.message, "error"));
    if (button.dataset.view === "waves") loadWaves(true).catch((error) => showAlert(error.message, "error"));
    if (button.dataset.view === "imports") loadImports().catch((error) => showAlert(error.message, "error"));
    if (button.dataset.view === "settings") loadClientBase().catch((error) => showAlert(error.message, "error"));
  }));
  $("#fileInput").addEventListener("change", (event) => uploadFile(event.target));
  $("#uploadLocalAnalysis")?.addEventListener("click", () => $("#fileInput").click());
  $("#useOfficialBase")?.addEventListener("click", async () => {
    if (!window.sigraStaticApi) return;
    showAlert("Alternando para a base oficial do repositório...");
    await api("/api/data-mode", { method: "POST", body: JSON.stringify({ mode: "official" }) });
    scopeApplied = true;
    currentImportId = "latest";
    await loadImports();
    await loadDashboard("latest");
    await loadOrders();
    hideAlert();
  });
  $("#clearLocalAnalysis")?.addEventListener("click", async () => {
    if (!window.sigraStaticApi) return;
    if (!window.confirm("Limpar a análise local temporária deste navegador? A base oficial do repositório será mantida.")) return;
    showAlert("Limpando análise local temporária...");
    await api("/api/local-analysis/clear", { method: "POST" });
    scopeApplied = true;
    currentImportId = "latest";
    await loadImports();
    await loadDashboard("latest");
    await loadOrders();
    hideAlert();
  });
  $("#exportLocalAnalysis")?.addEventListener("click", async () => {
    if (!window.sigraStaticApi) return;
    const payload = await api("/api/local-analysis/export");
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `analise-local-sigra-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
  $("#reloadOfficialBase")?.addEventListener("click", async () => {
    if (!window.sigraStaticApi) return;
    showAlert("Recarregando base oficial do repositório...");
    await api("/api/reload-official", { method: "POST" });
    scopeApplied = true;
    currentImportId = "latest";
    await loadImports();
    await loadClientBase();
    await loadDashboard("latest");
    await loadOrders();
    hideAlert();
  });
  $("#fileInputSecondary").addEventListener("change", (event) => uploadFile(event.target));
  $("#clientBaseInput").addEventListener("change", (event) => uploadClientBase(event.target));
  $("#waveForm")?.addEventListener("submit", (event) => saveWaveFromForm(event).catch((error) => showAlert(error.message, "error")));
  $("#waveUnitSearch")?.addEventListener("input", () => renderWavesPage());
  $("#bulkLinkWave")?.addEventListener("click", () => linkSelectedUnits().catch((error) => showAlert(error.message, "error")));
  $("#bulkOutScope")?.addEventListener("click", () => markSelectedUnitsOutOfScope().catch((error) => showAlert(error.message, "error")));
  $("#selectAllWaveUnits")?.addEventListener("change", (event) => {
    $$("#waveUnitsTable input[type=checkbox]").forEach((input) => { input.checked = event.target.checked; });
  });
  $("#waveFilter")?.addEventListener("change", async () => {
    waveFilter = $("#waveFilter").value;
    if (scopeApplied) {
      await loadDashboard(currentImportId);
      await loadOrders();
    }
  });
  $("#closeConferenceDialog").addEventListener("click", () => $("#importConferenceDialog").close());
  $$(".conference-actions button[data-conference-decision]").forEach((button) => {
    button.addEventListener("click", () => {
      applyImportDecision(button.dataset.conferenceDecision).catch((error) => showAlert(error.message, "error"));
    });
  });
  $("#searchInput").addEventListener("input", () => loadOrders());
  $("#statusFilter").addEventListener("change", () => loadOrders());
  $("#actionFilter").addEventListener("change", () => loadOrders());
  $("#contractGroupFilter").addEventListener("change", () => renderCollaboratorUnit());
  $("#ownerFilter").addEventListener("change", () => renderCollaboratorUnit());
  $("#unitFilter").addEventListener("change", () => renderCollaboratorUnit());
  $("#supplierFilter").addEventListener("change", () => renderCollaboratorUnit());
  $("#manualUserFilter").addEventListener("change", () => renderCollaboratorUnit());
  $$(".search-filter .filter-trigger").forEach((button) => {
    button.addEventListener("click", () => {
      const container = button.closest(".search-filter");
      const willOpen = !container.classList.contains("open");
      closeSearchFilters(container);
      container.classList.toggle("open", willOpen);
      button.setAttribute("aria-expanded", String(willOpen));
      if (willOpen) {
        const input = container.querySelector(".filter-search");
        input?.focus();
        input?.select();
      }
    });
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".search-filter")) closeSearchFilters();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSearchFilters();
  });
  $$(".search-filter .filter-search").forEach((input) => {
    input.addEventListener("input", () => {
      const container = input.closest(".search-filter");
      renderSearchFilter(container.dataset.select);
    });
  });
  $$(".search-filter").forEach((container) => {
    container.addEventListener("change", (event) => {
      if (!event.target.matches('.filter-option input[type="checkbox"]')) return;
      const selector = container.dataset.select;
      const current = new Set(selectedValues(selector));
      if (event.target.checked) current.add(event.target.value);
      else current.delete(event.target.value);
      setMultiSelectValues(selector, Array.from(current));
      renderCollaboratorUnit();
    });
    container.addEventListener("click", (event) => {
      const action = event.target.dataset.filterAction;
      if (!action) return;
      const selector = container.dataset.select;
      if (action === "select") {
        const current = new Set(selectedValues(selector));
        visibleFilterValues(container).forEach((value) => current.add(value));
        setMultiSelectValues(selector, Array.from(current));
      }
      if (action === "clear") {
        setMultiSelectValues(selector, []);
      }
      renderCollaboratorUnit();
    });
  });
  $("#tableUnitSupplierUnitFilter")?.addEventListener("change", () => renderCollaboratorUnit());
  $("#tableUnitSupplierSupplierFilter")?.addEventListener("change", () => renderCollaboratorUnit());
  $("#clearUnitSupplierTableFilters")?.addEventListener("click", () => {
    ["#tableUnitSupplierUnitFilter", "#tableUnitSupplierSupplierFilter"].forEach((selector) => {
      Array.from($(selector).options).forEach((option) => { option.selected = false; });
    });
    renderCollaboratorUnit();
  });
  $("#clearOperationalFilters").addEventListener("click", () => {
    $$(".search-filter .filter-search").forEach((input) => { input.value = ""; });
    ["#contractGroupFilter", "#ownerFilter", "#unitFilter", "#supplierFilter", "#manualUserFilter"].forEach((selector) => {
      Array.from($(selector).options).forEach((option) => { option.selected = false; });
      renderSearchFilter(selector);
    });
    renderCollaboratorUnit();
  });
  $$("#supplierSegments button").forEach((button) => {
    button.addEventListener("click", () => {
      supplierViewFilter = button.dataset.supplierFilter;
      $$("#supplierSegments button").forEach((item) => item.classList.toggle("active", item === button));
      renderSupplierPerformance(dashboardData?.performance?.fornecedores || []);
    });
  });
  $("#supplierSortKey")?.addEventListener("change", () => {
    supplierSort.key = $("#supplierSortKey").value;
    renderSupplierPerformance(dashboardData?.performance?.fornecedores || []);
  });
  $("#supplierSortDir")?.addEventListener("change", () => {
    supplierSort.dir = $("#supplierSortDir").value;
    renderSupplierPerformance(dashboardData?.performance?.fornecedores || []);
  });
  document.addEventListener("click", (event) => {
    const overviewFilter = event.target.closest("[data-overview-filter]");
    if (overviewFilter) {
      openBaseFiltered(overviewFilter.dataset.overviewFilter);
      return;
    }
    if (event.target.closest("#overviewDetailsButton")) {
      openBaseFiltered("action");
      return;
    }
    const importButton = event.target.closest("[data-import-action]");
    if (importButton) {
      handleImportAction(importButton.dataset.importAction, importButton.dataset.importId).catch((error) => {
        showAlert(error.message, "error");
      });
      return;
    }
    const waveEdit = event.target.closest("[data-edit-wave]");
    if (waveEdit) {
      const wave = (wavesData.waves || []).find((item) => item.id === waveEdit.dataset.editWave);
      if (wave) {
        $("#waveId").value = wave.id || "";
        $("#waveNumber").value = wave.wave_number || "";
        $("#waveClient").value = wave.cliente || "Mercado Livre";
        $("#waveName").value = wave.name || "";
        $("#waveCycle").value = wave.measurement_cycle_id || "";
        $("#waveBaseline").value = wave.baseline_id || "";
        $("#waveStatus").value = wave.status || "Planejada";
        $("#waveStart").value = wave.start_date || "";
        $("#wavePlannedEnd").value = wave.planned_end_date || "";
        $("#waveActualEnd").value = wave.actual_end_date || "";
        $("#waveObjective").value = wave.objective || "";
        $("#waveObservations").value = wave.observations || "";
        activateView("waves");
        $("#waveName").focus();
      }
      return;
    }
    const barButton = event.target.closest("[data-bar-sort]");
    if (barButton) {
      const selector = barButton.dataset.barSort;
      barSort[selector] = barButton.dataset.dir;
      renderBars(selector, barData[selector] || []);
      return;
    }
    const header = event.target.closest("th");
    if (header && !header.dataset.sort) {
      sortHtmlTable(header);
    }
  });
  $("#applyDateFilter").addEventListener("click", async () => {
    dateFilter = { from: $("#dateFrom").value, to: $("#dateTo").value };
    waveFilter = $("#waveFilter")?.value || "all";
    if (!dateFilter.from && !dateFilter.to && waveFilter === "all") {
      scopeApplied = false;
      clearDashboard("Informe uma data inicial e/ou final para carregar os indicadores.");
      await loadImports();
      return;
    }
    scopeApplied = true;
    await loadDashboard("latest");
    await loadOrders();
  });
  $("#clearDateFilter").addEventListener("click", async () => {
    $("#dateFrom").value = "";
    $("#dateTo").value = "";
    if ($("#waveFilter")) $("#waveFilter").value = "all";
    dateFilter = { from: "", to: "" };
    waveFilter = "all";
    currentImportId = "latest";
    scopeApplied = false;
    clearDashboard();
    await loadImports();
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

async function initApp() {
  wireEvents();
  clearDashboard();
  try {
    await loadMeasurementSetup();
    await loadWaves(false);
    if (window.sigraStaticApi && !scopeApplied) {
      showAlert("Selecione um período e clique em Filtrar, ou escolha uma importação na aba Importações SIGRA.");
    }
  } catch (error) {
    showAlert(error.message, "error");
  }
}

initApp();



