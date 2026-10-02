// MOS Campinho — front-end (versão com servidor)
(() => {
"use strict";

const $ = s => document.querySelector(s);
const MIN = 60 * 1000;
const POLL_MS = 10 * 1000;
const DIST = { perto: "Perto · até 2 km", medio: "Médio · até 4 km", longe: "Longe · 7–10 km" };
const STAGES = [
  { key: "recebido", title: "Recebidos", sla: "despachar em até 10 min" },
  { key: "preparo", title: "Em preparação", sla: "sair em 3–5 min" },
  { key: "rota", title: "Em rota", sla: "entrega 15–25 min" },
  { key: "entregue", title: "Entregues", sla: "hoje" },
];

let me = null;            // usuário logado
let data = null;          // último /api/board
let clockSkew = 0;        // diferença entre o relógio do servidor e o do aparelho
let view = "pedidos";
let offline = false;
let pollTimer = null;

const now = () => Date.now() + clockSkew;
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDur = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const fmtTime = t => new Date(t).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });

/* ================= Comunicação com o servidor ================= */
class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function api(path, payload) {
  let res;
  try {
    res = await fetch(path, {
      method: payload === undefined ? "GET" : "POST",
      credentials: "same-origin",
      headers: payload === undefined ? {} : { "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  } catch {
    setOffline(true);
    throw new ApiError(0, "Sem conexão com o servidor. Verifique a internet; se persistir, use o registro em papel e lance depois.");
  }
  setOffline(false);
  let out = {};
  try { out = await res.json(); } catch { /* resposta vazia */ }
  if (res.ok) {
    if (out.serverNow) clockSkew = out.serverNow - Date.now();
    return out;
  }
  if (res.status === 401 && path !== "/api/login") { showLogin(path === "/api/me" ? "" : out.error); throw new ApiError(401, out.error); }
  if (res.status === 403 && me?.mustChange) { showPassword(); }
  throw new ApiError(res.status, out.error || "Não foi possível concluir a operação.");
}

function setOffline(v) {
  if (offline === v) return;
  offline = v;
  if (me && !$("#app").hidden) render();
}

/* ================= Telas de acesso ================= */
function showOnly(id) {
  for (const s of ["#login", "#pwScreen", "#app"]) $(s).hidden = s !== id;
}
function showLogin(msg) {
  me = null; data = null;
  clearInterval(pollTimer);
  closeOverlay();
  showOnly("#login");
  $("#lgPass").value = "";
  showErr("#lgErr", msg || "");
  $("#lgUser").focus();
}
function showPassword() {
  showOnly("#pwScreen");
  $("#pwCancel").hidden = false;
  ["#pwCur", "#pwNew", "#pwNew2"].forEach(s => $(s).value = "");
  showErr("#pwErr", "");
  $("#pwCur").focus();
}
function showErr(sel, msg) { const e = $(sel); e.textContent = msg; e.hidden = !msg; }

$("#loginForm").addEventListener("submit", async ev => {
  ev.preventDefault();
  const username = $("#lgUser").value.trim(), password = $("#lgPass").value;
  if (!username || !password) return showErr("#lgErr", "Informe usuário e senha.");
  const btn = $("#lgBtn"); btn.disabled = true; btn.textContent = "Entrando…";
  try {
    const r = await api("/api/login", { username, password });
    $("#lgPass").value = "";
    showErr("#lgErr", "");
    start(r.user);
  } catch (e) {
    $("#lgPass").value = "";
    showErr("#lgErr", e.message);
  } finally {
    btn.disabled = false; btn.textContent = "Entrar";
  }
});

$("#pwForm").addEventListener("submit", async ev => {
  ev.preventDefault();
  const current = $("#pwCur").value, next = $("#pwNew").value, next2 = $("#pwNew2").value;
  if (next !== next2) return showErr("#pwErr", "As duas novas senhas não conferem.");
  try {
    const r = await api("/api/me/password", { current, next });
    me = r.user;
    toast("Senha alterada. Outras sessões abertas com seu usuário foram encerradas.");
    start(me);
  } catch (e) { showErr("#pwErr", e.message); }
});
$("#pwCancel").addEventListener("click", () => me?.mustChange ? logout() : start(me));
$("#pwBtn").addEventListener("click", showPassword);
$("#logoutBtn").addEventListener("click", logout);

async function logout() {
  try { await api("/api/logout", {}); } catch { /* sessão já encerrada */ }
  showLogin("");
}

function start(user) {
  me = user;
  if (me.mustChange) { showPassword(); $("#pwCancel").textContent = "Sair"; return; }
  $("#pwCancel").textContent = "Voltar";
  showOnly("#app");
  $("#uName").textContent = me.name;
  $("#uRole").textContent = me.roleLabel;
  renderNav();
  refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!$("#overlayRoot").innerHTML) refresh(); }, POLL_MS);
}

async function refresh() {
  try { data = await api("/api/board"); render(); }
  catch (e) { if (e.status !== 401) render(); }
}

/* ================= Navegação ================= */
const MODULES = [
  { grp: "Operação", items: [
    { id: "pedidos", code: "M3", label: "Pedidos e despacho", on: true },
    { id: "estoque", code: "M5", label: "Estoque", on: true },
  ]},
  { grp: "Próximas fases", items: [
    { id: "rotas", code: "M4", label: "Rotas e contingência", feats: ["Agrupamento de pedidos na mesma direção", "Rastreamento do entregador pelo cliente", "Protocolos de contingência (sistema, internet, energia, acidentes)"] },
    { id: "inventario", code: "M5", label: "Inventário e trocas", feats: ["Abertura, conferência às 17h e fechamento", "Justificativa obrigatória de divergências", "Registro de avarias e trocas de botijão"] },
    { id: "posvenda", code: "M3", label: "Pós-venda", feats: ["Pesquisa de satisfação 0–10 via WhatsApp", "Recuperação de clientes e recompra", "Tratamento de reclamações com prioridade"] },
    { id: "compras", code: "M6", label: "Compras", feats: ["Alerta de estoque mínimo gerando solicitação", "Ordens de compra OC-AAAA-NNNNN com status", "Recebimento com checklist e divergências"] },
    { id: "fornecedores", code: "M6", label: "Fornecedores", feats: ["Comparação por preço, disponibilidade e prazo", "Histórico de preços e de atrasos", "Indicador objetivo de desempenho"] },
    { id: "financeiro", code: "M7", label: "Financeiro e caixa", feats: ["Módulo em definição (próxima etapa do MOS)"] },
    { id: "equipe", code: "M2", label: "Equipe e permissões", admin: true, feats: ["Cadastro de colaboradores e perfis pela tela", "Alçadas de desconto e aprovação", "Consulta da trilha de auditoria (já gravada no banco)"] },
  ]},
];
const isAdmin = () => ["fundadora", "ceo"].includes(me?.role);

function renderNav() {
  const nav = $("#nav"); nav.innerHTML = "";
  for (const g of MODULES) {
    const l = document.createElement("div"); l.className = "label"; l.textContent = g.grp; nav.appendChild(l);
    for (const m of g.items) {
      if (m.admin && !isAdmin()) continue;
      const b = document.createElement("button"); b.type = "button";
      b.className = "nav-item" + (m.on ? "" : " locked") + (view === m.id ? " active" : "");
      b.innerHTML = `<span class="code">${m.code}</span><span>${m.label}</span>`;
      if (!m.on) b.title = "Disponível em fase futura";
      b.addEventListener("click", () => { view = m.id; renderNav(); render(); if (m.on) refresh(); });
      nav.appendChild(b);
    }
  }
}

/* ================= Regras de tempo (M3/M4) ================= */
function orderState(o) {
  if (o.status === "entregue") return "done";
  const total = (now() - o.createdAt) / MIN, stuck = (now() - o.stageAt) / MIN;
  if (total >= 35) return "crit";
  if ((o.status !== "rota" && stuck >= 8) || total >= 25) return "warn";
  return "ok";
}
const itemsText = o => o.items.map(i => `${i.qty}× ${i.label}`).join(" · ");
const stockBelow = () => (data?.stock || []).filter(s => s.min != null && s.full <= s.min);

/* ================= Renderização ================= */
function render() {
  renderAlerts();
  const m = MODULES.flatMap(g => g.items).find(x => x.id === view);
  if (!m.on) return renderLocked(m);
  if (!data) { $("#main").innerHTML = offlineBanner() + `<p class="loading">Carregando…</p>`; return; }
  if (view === "pedidos") return renderOrders();
  if (view === "estoque") return renderStock();
}
const offlineBanner = () => offline ? `<div class="offline" role="alert">Sem conexão com o servidor. Os dados podem estar desatualizados. Se a falha continuar, registre os pedidos em papel e lance depois.</div>` : "";

function renderAlerts() {
  if (!data) { $("#topAlerts").innerHTML = ""; return; }
  const open = data.orders.filter(o => o.status !== "entregue");
  const crit = open.filter(o => orderState(o) === "crit").length;
  const warn = open.filter(o => orderState(o) === "warn").length;
  const low = stockBelow().length;
  let h = "";
  if (offline) h += `<span class="chip warn">Sem conexão</span>`;
  if (crit) h += `<span class="chip crit">${crit} acima de 35 min</span>`;
  if (warn) h += `<span class="chip warn">${warn} em atenção</span>`;
  if (low) h += `<span class="chip crit">${low} ${low > 1 ? "itens" : "item"} abaixo do mínimo</span>`;
  $("#topAlerts").innerHTML = h || `<span class="chip ok">Operação dentro do prazo</span>`;
}

function renderOrders() {
  const open = data.orders.filter(o => o.status !== "entregue");
  const done = data.orders.filter(o => o.status === "entregue");
  const crit = open.filter(o => orderState(o) === "crit").length;
  const warn = open.filter(o => orderState(o) === "warn").length;
  const avg = done.length ? Math.round(done.reduce((a, o) => a + (o.doneAt - o.createdAt), 0) / done.length / MIN) : null;
  $("#main").innerHTML = `${offlineBanner()}
    <div class="page-head">
      <div><h2>Pedidos e despacho</h2><p>Limite de espera do cliente: 35–40 min. Pedido parado gera alerta a partir de 8 min.</p></div>
      <div class="actions"><button class="btn btn-primary" id="newBtn" type="button">Novo pedido</button></div>
    </div>
    <div class="kpis">
      <div class="kpi"><span class="label">Em aberto</span><b>${open.length}</b></div>
      <div class="kpi ${crit ? "crit" : ""}"><span class="label">Acima de 35 min</span><b>${crit}</b></div>
      <div class="kpi ${warn ? "warn" : ""}"><span class="label">Em atenção</span><b>${warn}</b></div>
      <div class="kpi"><span class="label">Ciclo médio hoje</span><b>${avg != null ? avg + " min" : "—"}</b></div>
    </div>
    <div class="board" id="board">${STAGES.map(st => {
      const list = data.orders.filter(o => o.status === st.key)
        .sort((a, b) => st.key === "entregue" ? b.doneAt - a.doneAt : a.createdAt - b.createdAt);
      return `<section class="col"><div class="col-head"><div><h3>${st.title}</h3><div class="sla">${st.sla}</div></div><span class="count">${list.length}</span></div>
        <div class="col-body">${list.length ? list.map(cardHtml).join("") : `<div class="empty">${st.key === "recebido" ? "Nenhum pedido aguardando. Use Novo pedido para registrar." : "Nenhum pedido nesta etapa."}</div>`}</div></section>`;
    }).join("")}</div>`;
  $("#newBtn").addEventListener("click", openNewOrder);
  $("#board").addEventListener("click", ev => {
    const card = ev.target.closest("[data-id]"); if (!card) return;
    const o = data.orders.find(x => x.id === +card.dataset.id); if (!o) return;
    const act = ev.target.closest("[data-act]");
    if (act) { ev.stopPropagation(); return doAction(o, act.dataset.act, act); }
    openDetail(o.id);
  });
  $("#board").addEventListener("keydown", ev => {
    if (ev.key === "Enter" && ev.target.matches(".card")) openDetail(+ev.target.dataset.id);
  });
}

function cardHtml(o) {
  const st = orderState(o);
  const timer = o.status === "entregue" ? `${Math.round((o.doneAt - o.createdAt) / MIN)} min` : fmtDur(now() - o.createdAt);
  let actions = "";
  if (o.status === "recebido") actions = `<button class="btn" data-act="prepare" type="button">Iniciar preparação</button>`;
  if (o.status === "preparo") actions = `<button class="btn btn-primary" data-act="dispatch" type="button">Despachar</button>`;
  if (o.status === "rota") actions = `<button class="btn btn-primary" data-act="deliver" type="button">Confirmar entrega</button>`;
  if (o.status !== "entregue") actions += `<button class="btn btn-quiet" data-act="cancel" type="button">Cancelar</button>`;
  const stuck = Math.floor((now() - o.stageAt) / MIN);
  const flag = st === "crit" ? `<span class="chip crit">Atrasado</span>`
    : st === "warn" && o.status !== "rota" && stuck >= 8 ? `<span class="chip warn">Parado ${stuck} min</span>`
    : st === "warn" ? `<span class="chip warn">Atenção</span>` : "";
  return `<article class="card s-${st}" data-id="${o.id}" tabindex="0">
    <div class="card-top"><span class="id">${o.code}</span><span class="timer" data-timer="${o.id}">${timer}</span></div>
    <div class="name">${esc(o.client)}</div>
    <div class="meta">${esc(o.address)}</div>
    <div class="items">${esc(itemsText(o))}</div>
    <div class="row"><span class="dist">${DIST[o.distance].split(" · ")[0]}</span><span class="meta">${esc(o.payment)}</span>${o.rider ? `<span class="meta">· ${esc(o.rider)}</span>` : ""}${flag}</div>
    ${actions ? `<div class="row">${actions}</div>` : ""}
  </article>`;
}

async function doAction(o, act, btn) {
  if (act === "dispatch") return openDispatch(o);
  if (act === "cancel") return openCancel(o);
  btn.disabled = true;
  try {
    const r = await api(`/api/orders/${o.id}/${act}`, {});
    toast(act === "prepare" ? `${o.code} em preparação.` : `${o.code} entregue em ${r.minutes} min.`);
  } catch (e) { toast(e.message); }
  refresh();
}

/* ================= Painéis laterais ================= */
function openOverlay(html) {
  $("#overlayRoot").innerHTML = `<div class="overlay" id="ov"><aside class="drawer" role="dialog" aria-modal="true">${html}</aside></div>`;
  $("#ov").addEventListener("click", e => { if (e.target.id === "ov") closeOverlay(); });
  $("#ov").querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", closeOverlay));
  const f = $("#ov").querySelector("input,select,textarea,button:not([data-close])"); f && f.focus();
}
function closeOverlay() { $("#overlayRoot").innerHTML = ""; }
document.addEventListener("keydown", e => { if (e.key === "Escape") closeOverlay(); });

async function submitting(btn, fn) {
  btn.disabled = true;
  try { await fn(); } finally { btn.disabled = false; }
}

function openNewOrder() {
  const opts = data.products.map(p => `<option value="${p.code}">${esc(p.label)}</option>`).join("");
  openOverlay(`
    <div class="drawer-head"><h3>Novo pedido</h3><button class="btn" data-close type="button">Fechar</button></div>
    <form id="noForm" class="lines" novalidate>
      <div class="field"><label class="label" for="noName">Cliente</label><input id="noName" maxlength="120" required></div>
      <div class="grid2">
        <div class="field"><label class="label" for="noPhone">Telefone</label><input id="noPhone" inputmode="tel" maxlength="30" placeholder="(21) 9xxxx-xxxx"></div>
        <div class="field"><label class="label" for="noDist">Distância</label><select id="noDist">${Object.entries(DIST).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
      </div>
      <div class="field"><label class="label" for="noAddr">Endereço</label><input id="noAddr" maxlength="200" required placeholder="Rua, número, referência"></div>
      <div class="field"><span class="label">Itens</span><div class="lines" id="noLines"></div>
        <button class="btn self-start" id="noAdd" type="button">Adicionar item</button></div>
      <div class="field"><label class="label" for="noPay">Pagamento</label><select id="noPay">${data.payments.map(p => `<option>${esc(p)}</option>`).join("")}</select></div>
      <div id="noErr" class="err" role="alert" hidden></div>
      <button class="btn btn-primary" id="noGo" type="submit">Registrar pedido</button>
      <p class="note">Meta de registro: 2–3 minutos para cliente, item, pagamento e despacho.</p>
    </form>`);
  const addLine = () => {
    const n = $("#noLines").children.length;
    if (n >= 10) return;
    const d = document.createElement("div"); d.className = "line";
    d.innerHTML = `<select aria-label="Produto" id="noItem${n}">${opts}</select><input aria-label="Quantidade" id="noQty${n}" type="number" min="1" max="50" value="1"><button class="btn btn-quiet" type="button">Remover</button>`;
    d.querySelector("button").addEventListener("click", () => { if ($("#noLines").children.length > 1) d.remove(); });
    $("#noLines").appendChild(d);
  };
  addLine();
  $("#noAdd").addEventListener("click", addLine);
  $("#noForm").addEventListener("submit", e => {
    e.preventDefault();
    submitting($("#noGo"), async () => {
      const items = [...$("#noLines").children].map(d => ({ product: d.querySelector("select").value, qty: parseInt(d.querySelector("input").value, 10) || 0 }));
      try {
        const r = await api("/api/orders", {
          client: $("#noName").value, phone: $("#noPhone").value, address: $("#noAddr").value,
          distance: $("#noDist").value, payment: $("#noPay").value, items,
        });
        closeOverlay(); toast(`Pedido ${r.code} registrado.`);
        if (view !== "pedidos") { view = "pedidos"; renderNav(); }
        refresh();
      } catch (err) { showErr("#noErr", err.message); }
    });
  });
}

function openDispatch(o) {
  const busy = data.orders.filter(x => x.status === "rota").map(x => x.rider);
  openOverlay(`
    <div class="drawer-head"><h3>Despachar ${o.code}</h3><button class="btn" data-close type="button">Fechar</button></div>
    <dl class="kv"><dt>Cliente</dt><dd>${esc(o.client)}</dd><dt>Endereço</dt><dd>${esc(o.address)}</dd><dt>Distância</dt><dd>${DIST[o.distance]}</dd><dt>Itens</dt><dd>${esc(itemsText(o))}</dd></dl>
    <div class="field"><label class="label" for="dpRider">Entregador</label>
      <select id="dpRider">${data.riders.map(r => `<option value="${esc(r)}">${esc(r)}${busy.includes(r) ? " (em rota)" : ""}</option>`).join("")}</select></div>
    <div id="dpErr" class="err" role="alert" hidden></div>
    <p class="note">Ao despachar, os cheios saem do estoque. Os vasilhames entram na confirmação da entrega.</p>
    <button class="btn btn-primary" id="dpGo" type="button">Confirmar saída</button>`);
  $("#dpGo").addEventListener("click", () => submitting($("#dpGo"), async () => {
    try {
      const rider = $("#dpRider").value;
      await api(`/api/orders/${o.id}/dispatch`, { rider });
      closeOverlay(); toast(`${o.code} saiu com ${rider}.`); refresh();
    } catch (e) { showErr("#dpErr", e.message); }
  }));
}

function openCancel(o) {
  openOverlay(`
    <div class="drawer-head"><h3>Cancelar ${o.code}</h3><button class="btn" data-close type="button">Voltar</button></div>
    <p>O cancelamento fica registrado no histórico do pedido com seu nome e horário.</p>
    <div class="field"><label class="label" for="ccReason">Motivo</label>
      <select id="ccReason">${data.cancelReasons.map(r => `<option>${esc(r)}</option>`).join("")}</select></div>
    <div class="field"><label class="label" for="ccNote">Observação</label><textarea id="ccNote" rows="3" maxlength="300"></textarea></div>
    ${o.status === "rota" ? `<p class="note">O pedido já saiu. Os cheios voltam ao estoque; confirme que lacre e peso estão preservados.</p>` : ""}
    <div id="ccErr" class="err" role="alert" hidden></div>
    <button class="btn btn-primary" id="ccGo" type="button">Confirmar cancelamento</button>`);
  $("#ccGo").addEventListener("click", () => submitting($("#ccGo"), async () => {
    try {
      await api(`/api/orders/${o.id}/cancel`, { reason: $("#ccReason").value, note: $("#ccNote").value });
      closeOverlay(); toast(`${o.code} cancelado.`); refresh();
    } catch (e) { showErr("#ccErr", e.message); }
  }));
}

async function openDetail(id) {
  openOverlay(`<div class="drawer-head"><h3>Carregando…</h3><button class="btn" data-close type="button">Fechar</button></div>`);
  try {
    const { order: o, events } = await api(`/api/orders/${id}`);
    openOverlay(`
      <div class="drawer-head"><h3>${o.code}</h3><button class="btn" data-close type="button">Fechar</button></div>
      <dl class="kv">
        <dt>Cliente</dt><dd>${esc(o.client)}</dd><dt>Telefone</dt><dd>${esc(o.phone || "—")}</dd>
        <dt>Endereço</dt><dd>${esc(o.address)}</dd><dt>Distância</dt><dd>${DIST[o.distance]}</dd>
        <dt>Itens</dt><dd>${esc(itemsText(o))}</dd><dt>Pagamento</dt><dd>${esc(o.payment)}</dd>
        <dt>Entregador</dt><dd>${esc(o.rider || "—")}</dd><dt>Abertura</dt><dd>${fmtTime(o.createdAt)}</dd>
      </dl>
      <div><div class="label mb8">Histórico</div>
      <ul class="hist">${events.map(h => `<li><span class="t">${fmtTime(h.at)}</span>${esc(h.message)} <span class="muted">· ${esc(h.user_name)}</span></li>`).join("")}</ul></div>`);
  } catch (e) { closeOverlay(); toast(e.message); }
}

/* ================= Estoque ================= */
function renderStock() {
  const rows = data.stock.map(s => {
    const below = s.min != null && s.full <= s.min;
    const near = s.min != null && !below && s.full <= s.min * 1.2;
    const pill = s.min == null ? `<span class="chip neutral">Sem mínimo definido</span>`
      : below ? `<span class="chip crit">Abaixo do mínimo</span>`
      : near ? `<span class="chip warn">Próximo do mínimo</span>` : `<span class="chip ok">Normal</span>`;
    return `<tr><td>${esc(s.name)}</td><td class="n">${s.full}</td><td class="n">${s.empty == null ? "—" : s.empty}</td>
      <td class="n">${s.min ?? "—"}</td><td>${pill}</td><td><button class="btn" data-adj="${s.key}" type="button">Ajustar</button></td></tr>`;
  }).join("");
  $("#main").innerHTML = `${offlineBanner()}
    <div class="page-head"><div><h2>Estoque</h2><p>Saldos atualizados automaticamente pelo fluxo de pedidos.</p></div></div>
    <div class="panel"><table class="data"><thead><tr><th>Produto</th><th class="n">Cheios</th><th class="n">Vazios</th><th class="n">Mínimo</th><th>Situação</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="note">Todo ajuste exige justificativa e fica registrado com usuário e horário. P5 é sob encomenda e não tem saldo nesta fase. Inventário das 17h e avarias entram na fase de Inventário e trocas.</p>`;
  $("#main").querySelectorAll("[data-adj]").forEach(b => b.addEventListener("click", () => openAdjust(data.stock.find(s => s.key === b.dataset.adj))));
}

function openAdjust(s) {
  openOverlay(`
    <div class="drawer-head"><h3>Ajustar ${esc(s.name)}</h3><button class="btn" data-close type="button">Fechar</button></div>
    <p class="hint">Use para corrigir o saldo após conferência física ou para lançar uma entrada de mercadoria enquanto o módulo de Compras não está ativo.</p>
    <div class="grid2">
      <div class="field"><label class="label" for="adFull">Cheios</label><input id="adFull" type="number" min="0" value="${s.full}"></div>
      ${s.empty == null ? "" : `<div class="field"><label class="label" for="adEmpty">Vazios</label><input id="adEmpty" type="number" min="0" value="${s.empty}"></div>`}
    </div>
    <div class="field"><label class="label" for="adReason">Justificativa</label><input id="adReason" maxlength="200" placeholder="Ex.: conferência das 17h, recebimento NF 1234"></div>
    <div id="adErr" class="err" role="alert" hidden></div>
    <button class="btn btn-primary" id="adGo" type="button">Salvar ajuste</button>`);
  $("#adGo").addEventListener("click", () => submitting($("#adGo"), async () => {
    try {
      await api(`/api/stock/${s.key}/adjust`, {
        full: parseInt($("#adFull").value, 10),
        empty: s.empty == null ? null : parseInt($("#adEmpty").value, 10),
        reason: $("#adReason").value,
      });
      closeOverlay(); toast(`Saldo de ${s.name} ajustado.`); refresh();
    } catch (e) { showErr("#adErr", e.message); }
  }));
}

/* ================= Módulo bloqueado ================= */
function renderLocked(m) {
  $("#main").innerHTML = `
    <div class="page-head"><div><h2>${m.label}</h2><p>Módulo ${m.code} do MOS</p></div></div>
    <div class="locked-view">
      <span class="badge-lock">Disponível em fase futura</span>
      <p>Este módulo faz parte do escopo aprovado, mas ainda não tem ações nesta versão. O que está previsto:</p>
      <ul>${m.feats.map(f => `<li>${f}</li>`).join("")}</ul>
    </div>`;
}

/* ================= Utilidades ================= */
let toastT;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3200); }

// Cronômetros dos cartões a cada segundo, sem recarregar do servidor.
setInterval(() => {
  if (!me || !data || view !== "pedidos" || $("#app").hidden) return;
  let changed = false;
  document.querySelectorAll("[data-timer]").forEach(el => {
    const o = data.orders.find(x => x.id === +el.dataset.timer); if (!o || o.status === "entregue") return;
    el.textContent = fmtDur(now() - o.createdAt);
    if (!el.closest(".card").classList.contains("s-" + orderState(o))) changed = true;
  });
  if (changed && !$("#overlayRoot").innerHTML) render(); else renderAlerts();
}, 1000);

// Ao abrir a página, retoma a sessão se ela ainda for válida.
(async () => {
  try { const r = await api("/api/me"); start(r.user); }
  catch (e) { if (e.status !== 401) showLogin(e.message); }
})();
})();
