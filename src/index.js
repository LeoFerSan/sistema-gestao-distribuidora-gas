// MOS Campinho — Worker principal (API + front-end estático)
// Cloudflare Workers + D1

const PBKDF2_ITER = 100000;          // máximo aceito pelo runtime da Cloudflare
const MAX_FAILS = 5;                 // tentativas antes do bloqueio
const LOCK_MS = 15 * 60 * 1000;      // bloqueio após falhas
const IDLE_MS = 15 * 60 * 1000;      // sessão expira após inatividade
const ABS_MS = 12 * 60 * 60 * 1000;  // duração máxima de uma sessão (um turno)
const COOKIE = "mos_sess";
const MIN = 60 * 1000;
const TZ_OFFSET = -3 * 60 * MIN;     // America/Sao_Paulo (sem horário de verão)

const ROLE_LABEL = { fundadora: "Fundadora", ceo: "CEO", atendimento: "Atendimento / Despacho" };
const DISTANCES = ["perto", "medio", "longe"];
const PAYMENTS = ["Dinheiro", "Pix", "Cartão (maquininha)"];
const CANCEL_REASONS = ["Cliente desistiu", "Pedido duplicado", "Item errado no registro", "Endereço fora da área", "Outro"];

const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

/* ------------------------------------------------------------------ */
/* Entrada                                                             */
/* ------------------------------------------------------------------ */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let res;
    try {
      if (url.pathname.startsWith("/api/")) {
        res = await api(request, env, url, ctx);
      } else {
        res = await env.ASSETS.fetch(request);
      }
    } catch (err) {
      if (err instanceof HttpError) res = json({ error: err.message }, err.status);
      else {
        console.error(err);
        res = json({ error: "Erro interno. Tente novamente; se persistir, avise o responsável pelo sistema." }, 500);
      }
    }
    return withHeaders(res, url.pathname.startsWith("/api/"));
  },
};

function withHeaders(res, isApi) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) r.headers.set(k, v);
  if (isApi) r.headers.set("Cache-Control", "no-store");
  return r;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });

/* ------------------------------------------------------------------ */
/* Roteador da API                                                     */
/* ------------------------------------------------------------------ */
async function api(request, env, url) {
  const method = request.method;
  const path = url.pathname.replace(/\/+$/, "");

  if (method !== "GET") checkOrigin(request, url);

  if (method === "POST" && path === "/api/login") return login(request, env);

  const s = await requireSession(request, env);

  if (method === "POST" && path === "/api/logout") return logout(env, s);
  if (method === "GET" && path === "/api/me") return json({ user: publicUser(s.user), serverNow: Date.now() });
  if (method === "POST" && path === "/api/me/password") return changePassword(request, env, s);

  // Até trocar a senha provisória, nada além disso é liberado.
  if (s.user.must_change) fail(403, "Troque sua senha provisória para continuar.");

  if (method === "GET" && path === "/api/board") return board(env);
  if (method === "POST" && path === "/api/orders") return createOrder(request, env, s);

  let m = path.match(/^\/api\/orders\/(\d+)$/);
  if (m && method === "GET") return getOrder(env, +m[1]);

  m = path.match(/^\/api\/orders\/(\d+)\/(prepare|dispatch|deliver|cancel)$/);
  if (m && method === "POST") return orderAction(request, env, s, +m[1], m[2]);

  m = path.match(/^\/api\/stock\/([A-Z0-9]+)\/adjust$/);
  if (m && method === "POST") return adjustStock(request, env, s, m[1]);

  fail(404, "Rota não encontrada.");
}

// Proteção contra requisições forjadas de outros sites (CSRF):
// além do cookie SameSite=Strict, toda escrita precisa vir da própria origem e em JSON.
function checkOrigin(request, url) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) fail(403, "Origem não permitida.");
  const ct = request.headers.get("Content-Type") || "";
  if (!ct.startsWith("application/json")) fail(415, "Envie os dados em JSON.");
}

async function body(request) {
  try { return await request.json(); } catch { fail(400, "Dados inválidos."); }
}

/* ------------------------------------------------------------------ */
/* Autenticação                                                        */
/* ------------------------------------------------------------------ */
const enc = new TextEncoder();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");

async function pbkdf2(password, saltB64, iter) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unb64(saltB64), iterations: iter }, key, 256);
  return b64(bits);
}
function safeEqual(a, b) {
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length) return false;
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(x, y);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]; return d === 0;
}
async function sha256hex(s) { return hex(await crypto.subtle.digest("SHA-256", enc.encode(s))); }
function newToken() {
  const a = crypto.getRandomValues(new Uint8Array(32));
  return b64(a).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function clientIp(request) { return request.headers.get("CF-Connecting-IP") || ""; }
function cookie(value, maxAgeSec) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;
}
function readCookie(request) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === COOKIE) return part.slice(i + 1);
  }
  return null;
}
function publicUser(u) {
  return { username: u.username, name: u.name, role: u.role, roleLabel: ROLE_LABEL[u.role], mustChange: !!u.must_change };
}
async function audit(env, user, action, detail, ip) {
  await env.DB.prepare("INSERT INTO audit_log (at, user_id, username, action, detail, ip) VALUES (?,?,?,?,?,?)")
    .bind(Date.now(), user?.id ?? null, user?.username ?? null, action, detail ?? null, ip ?? null).run();
}

const GENERIC_LOGIN_ERROR = "Usuário ou senha inválidos.";
const DUMMY_SALT = "AAAAAAAAAAAAAAAAAAAAAA==";

async function login(request, env) {
  const { username, password } = await body(request);
  if (typeof username !== "string" || typeof password !== "string" || !username || !password || password.length > 200)
    fail(400, "Informe usuário e senha.");
  const ip = clientIp(request);
  const now = Date.now();
  const u = await env.DB.prepare("SELECT * FROM users WHERE username = ? AND active = 1").bind(username.trim()).first();

  if (!u) {
    await pbkdf2(password, DUMMY_SALT, PBKDF2_ITER); // mesmo custo de tempo, para não revelar quais usuários existem
    await audit(env, { username: username.trim().slice(0, 40) }, "login_falhou", "usuário inexistente", ip);
    fail(401, GENERIC_LOGIN_ERROR);
  }
  if (u.locked_until > now) {
    const mins = Math.ceil((u.locked_until - now) / MIN);
    fail(429, `Acesso bloqueado por excesso de tentativas. Tente novamente em ${mins} min ou peça desbloqueio ao CEO.`);
  }

  const hash = await pbkdf2(password, u.pass_salt, u.pass_iter);
  if (!safeEqual(hash, u.pass_hash)) {
    const fails = u.failed_count + 1;
    if (fails >= MAX_FAILS) {
      await env.DB.prepare("UPDATE users SET failed_count = 0, locked_until = ? WHERE id = ?").bind(now + LOCK_MS, u.id).run();
      await audit(env, u, "conta_bloqueada", `${MAX_FAILS} tentativas`, ip);
      fail(429, "Usuário ou senha inválidos. Acesso bloqueado por 15 minutos.");
    }
    await env.DB.prepare("UPDATE users SET failed_count = ? WHERE id = ?").bind(fails, u.id).run();
    await audit(env, u, "login_falhou", "senha incorreta", ip);
    fail(401, GENERIC_LOGIN_ERROR);
  }

  const token = newToken();
  const sid = await sha256hex(token);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET failed_count = 0, locked_until = 0 WHERE id = ?").bind(u.id),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ? OR last_seen < ?").bind(now, now - IDLE_MS),
    env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, last_seen, expires_at, ip, user_agent) VALUES (?,?,?,?,?,?,?)")
      .bind(sid, u.id, now, now, now + ABS_MS, ip, (request.headers.get("User-Agent") || "").slice(0, 200)),
  ]);
  await audit(env, u, "login", null, ip);
  return json({ user: publicUser(u), serverNow: now }, 200, { "Set-Cookie": cookie(token, ABS_MS / 1000) });
}

async function requireSession(request, env) {
  const token = readCookie(request);
  if (!token) fail(401, "Sessão não encontrada. Entre novamente.");
  const sid = await sha256hex(token);
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT s.id sid, s.last_seen, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND u.active = 1`).bind(sid).first();
  if (!row) fail(401, "Sessão encerrada. Entre novamente.");
  if (row.expires_at < now || row.last_seen < now - IDLE_MS) {
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sid).run();
    fail(401, "Sessão encerrada por inatividade. Entre novamente.");
  }
  if (now - row.last_seen > MIN) {
    await env.DB.prepare("UPDATE sessions SET last_seen = ? WHERE id = ?").bind(now, sid).run();
  }
  const { sid: _s, last_seen, expires_at, ...user } = row;
  return { sid, user };
}

async function logout(env, s) {
  await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(s.sid).run();
  await audit(env, s.user, "logout");
  return json({ ok: true }, 200, { "Set-Cookie": cookie("", 0) });
}

async function changePassword(request, env, s) {
  const { current, next } = await body(request);
  if (typeof current !== "string" || typeof next !== "string") fail(400, "Informe a senha atual e a nova.");
  if (next.length < 10 || next.length > 200) fail(400, "A nova senha precisa ter pelo menos 10 caracteres.");
  if (!/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) fail(400, "A nova senha precisa ter letras e números.");
  if (next === current) fail(400, "A nova senha precisa ser diferente da atual.");
  const u = s.user;
  if (!safeEqual(await pbkdf2(current, u.pass_salt, u.pass_iter), u.pass_hash)) fail(400, "Senha atual incorreta.");
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await pbkdf2(next, salt, PBKDF2_ITER);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET pass_hash = ?, pass_salt = ?, pass_iter = ?, must_change = 0 WHERE id = ?")
      .bind(hash, salt, PBKDF2_ITER, u.id),
    // encerra as outras sessões do usuário, mantendo a atual
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id <> ?").bind(u.id, s.sid),
  ]);
  await audit(env, u, "senha_alterada");
  return json({ user: publicUser({ ...u, must_change: 0 }) });
}

/* ------------------------------------------------------------------ */
/* Pedidos e estoque                                                   */
/* ------------------------------------------------------------------ */
function startOfToday(now = Date.now()) {
  const day = 24 * 60 * MIN;
  return Math.floor((now + TZ_OFFSET) / day) * day - TZ_OFFSET;
}

async function loadItems(env, ids) {
  if (!ids.length) return {};
  const ph = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT i.order_id, i.product_code, i.qty, p.label FROM order_items i JOIN products p ON p.code = i.product_code
     WHERE i.order_id IN (${ph}) ORDER BY i.id`).bind(...ids).all();
  const map = {};
  for (const r of results) (map[r.order_id] ||= []).push({ product: r.product_code, label: r.label, qty: r.qty });
  return map;
}
const orderCode = id => "PD-" + String(id).padStart(5, "0");
function shapeOrder(o, items) {
  return {
    id: o.id, code: orderCode(o.id), client: o.client_name, phone: o.phone, address: o.address,
    distance: o.distance, payment: o.payment, status: o.status, rider: o.rider,
    createdAt: o.created_at, stageAt: o.stage_at, doneAt: o.done_at, items: items || [],
  };
}

async function board(env) {
  const today = startOfToday();
  const [orders, stock, products, riders] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM orders WHERE status IN ('recebido','preparo','rota')
                    OR (status = 'entregue' AND done_at >= ?) ORDER BY created_at`).bind(today),
    env.DB.prepare("SELECT key, name, full_qty, empty_qty, min_qty FROM stock ORDER BY sort"),
    env.DB.prepare("SELECT code, label, stock_key FROM products WHERE active = 1 ORDER BY sort"),
    env.DB.prepare("SELECT name FROM riders WHERE active = 1 ORDER BY name"),
  ]);
  const items = await loadItems(env, orders.results.map(o => o.id));
  return json({
    serverNow: Date.now(),
    orders: orders.results.map(o => shapeOrder(o, items[o.id])),
    stock: stock.results.map(s => ({ key: s.key, name: s.name, full: s.full_qty, empty: s.empty_qty, min: s.min_qty })),
    products: products.results.map(p => ({ code: p.code, label: p.label, stockKey: p.stock_key })),
    riders: riders.results.map(r => r.name),
    payments: PAYMENTS,
    cancelReasons: CANCEL_REASONS,
  });
}

function cleanText(v, max, field, required = true) {
  if (v == null || v === "") { if (required) fail(400, `Preencha ${field}.`); return null; }
  if (typeof v !== "string") fail(400, `${field} inválido.`);
  const t = v.trim().replace(/\s+/g, " ");
  if (required && !t) fail(400, `Preencha ${field}.`);
  if (t.length > max) fail(400, `${field} muito longo (máximo ${max} caracteres).`);
  return t || null;
}

async function createOrder(request, env, s) {
  const b = await body(request);
  const client = cleanText(b.client, 120, "o nome do cliente");
  const address = cleanText(b.address, 200, "o endereço");
  const phone = cleanText(b.phone, 30, "o telefone", false);
  if (!DISTANCES.includes(b.distance)) fail(400, "Escolha a distância.");
  if (!PAYMENTS.includes(b.payment)) fail(400, "Escolha a forma de pagamento.");
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 10) fail(400, "Inclua de 1 a 10 itens.");

  const { results: prods } = await env.DB.prepare("SELECT code FROM products WHERE active = 1").all();
  const valid = new Set(prods.map(p => p.code));
  const merged = new Map();
  for (const it of b.items) {
    const qty = Number(it?.qty);
    if (!valid.has(it?.product)) fail(400, "Produto inválido.");
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) fail(400, "Quantidade deve ser um número inteiro entre 1 e 50.");
    merged.set(it.product, (merged.get(it.product) || 0) + qty);
  }

  const now = Date.now();
  const ins = await env.DB.prepare(
    `INSERT INTO orders (client_name, phone, address, distance, payment, status, created_at, stage_at, created_by)
     VALUES (?,?,?,?,?, 'recebido', ?, ?, ?) RETURNING id`)
    .bind(client, phone, address, b.distance, b.payment, now, now, s.user.id).first();
  const id = ins.id;
  const stmts = [...merged].map(([code, qty]) =>
    env.DB.prepare("INSERT INTO order_items (order_id, product_code, qty) VALUES (?,?,?)").bind(id, code, qty));
  stmts.push(event(env, id, s.user, "Pedido registrado"));
  if (merged.has("P5E")) stmts.push(event(env, id, s.user, "Contém P5 sob encomenda: confirmar disponibilidade"));
  await env.DB.batch(stmts);
  return json({ id, code: orderCode(id) }, 201);
}

function event(env, orderId, user, message, at = Date.now()) {
  return env.DB.prepare("INSERT INTO order_events (order_id, at, user_id, user_name, message) VALUES (?,?,?,?,?)")
    .bind(orderId, at, user.id, user.name, message);
}

async function getOrder(env, id) {
  const o = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
  if (!o) fail(404, "Pedido não encontrado.");
  const items = await loadItems(env, [id]);
  const { results: ev } = await env.DB.prepare(
    "SELECT at, user_name, message FROM order_events WHERE order_id = ? ORDER BY at, id").bind(id).all();
  return json({ order: { ...shapeOrder(o, items[id]), cancelReason: o.cancel_reason }, events: ev });
}

async function orderAction(request, env, s, id, action) {
  const b = await body(request);
  const o = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
  if (!o) fail(404, "Pedido não encontrado.");
  const now = Date.now();
  const u = s.user;
  const code = orderCode(id);

  // Cada atualização só vale se o pedido ainda estiver na etapa esperada;
  // assim, dois usuários clicando ao mesmo tempo não duplicam a ação.
  const moveStatus = (from, to, extra = "", binds = []) =>
    env.DB.prepare(`UPDATE orders SET status = ?, stage_at = ?${extra} WHERE id = ? AND status = ?`)
      .bind(to, now, ...binds, id, from);

  if (action === "prepare") {
    if (o.status !== "recebido") fail(409, `${code} já não está em "Recebidos". Atualize o quadro.`);
    const r = await env.DB.batch([moveStatus("recebido", "preparo"), event(env, id, u, "Preparação iniciada")]);
    if (!r[0].meta.changes) fail(409, "Outro usuário alterou este pedido. Atualize o quadro.");
    return json({ ok: true });
  }

  if (action === "dispatch") {
    if (o.status !== "preparo" && o.status !== "recebido") fail(409, `${code} não está pronto para despacho.`);
    const rider = typeof b.rider === "string" ? b.rider : "";
    const okRider = await env.DB.prepare("SELECT 1 FROM riders WHERE name = ? AND active = 1").bind(rider).first();
    if (!okRider) fail(400, "Escolha um entregador da lista.");
    const lines = await stockLines(env, id);
    for (const l of lines) {
      if (l.stock_key && l.full_qty < l.qty) fail(409, `Estoque insuficiente de ${l.stock_name}: ${l.full_qty} disponível(is), pedido pede ${l.qty}.`);
    }
    const stmts = [moveStatus(o.status, "rota", ", rider = ?", [rider])];
    for (const l of lines.filter(l => l.stock_key)) {
      stmts.push(env.DB.prepare("UPDATE stock SET full_qty = full_qty - ? WHERE key = ?").bind(l.qty, l.stock_key));
      stmts.push(move(env, l.stock_key, -l.qty, 0, `Saída ${code}`, id, u, now));
    }
    stmts.push(event(env, id, u, `Despachado com ${rider}`));
    const r = await env.DB.batch(stmts);
    if (!r[0].meta.changes) {
      // corrida rara: outro usuário mexeu no pedido entre a leitura e a gravação; desfaz a baixa
      await env.DB.batch(lines.filter(l => l.stock_key).flatMap(l => [
        env.DB.prepare("UPDATE stock SET full_qty = full_qty + ? WHERE key = ?").bind(l.qty, l.stock_key),
        move(env, l.stock_key, l.qty, 0, `Estorno automático ${code}`, id, u, now),
      ]));
      fail(409, "Outro usuário alterou este pedido. Atualize o quadro.");
    }
    return json({ ok: true });
  }

  if (action === "deliver") {
    if (o.status !== "rota") fail(409, `${code} não está em rota.`);
    const lines = await stockLines(env, id);
    const stmts = [moveStatus("rota", "entregue", ", done_at = ?", [now])];
    for (const l of lines.filter(l => l.stock_key && l.returns_empty && l.empty_qty !== null)) {
      stmts.push(env.DB.prepare("UPDATE stock SET empty_qty = empty_qty + ? WHERE key = ?").bind(l.qty_return, l.stock_key));
      stmts.push(move(env, l.stock_key, 0, l.qty_return, `Vasilhame recolhido ${code}`, id, u, now));
    }
    stmts.push(event(env, id, u, "Entrega confirmada"));
    const r = await env.DB.batch(stmts);
    if (!r[0].meta.changes) fail(409, "Outro usuário alterou este pedido. Atualize o quadro.");
    return json({ ok: true, minutes: Math.round((now - o.created_at) / MIN) });
  }

  if (action === "cancel") {
    if (!["recebido", "preparo", "rota"].includes(o.status)) fail(409, `${code} não pode mais ser cancelado.`);
    if (!CANCEL_REASONS.includes(b.reason)) fail(400, "Escolha o motivo do cancelamento.");
    const note = cleanText(b.note, 300, "a observação", b.reason === "Outro");
    const reason = note ? `${b.reason} — ${note}` : b.reason;
    const stmts = [moveStatus(o.status, "cancelado", ", cancel_reason = ?", [reason])];
    if (o.status === "rota") {
      const lines = await stockLines(env, id);
      for (const l of lines.filter(l => l.stock_key)) {
        stmts.push(env.DB.prepare("UPDATE stock SET full_qty = full_qty + ? WHERE key = ?").bind(l.qty, l.stock_key));
        stmts.push(move(env, l.stock_key, l.qty, 0, `Retorno por cancelamento ${code}`, id, u, now));
      }
    }
    stmts.push(event(env, id, u, `Cancelado: ${reason}`));
    const r = await env.DB.batch(stmts);
    if (!r[0].meta.changes) fail(409, "Outro usuário alterou este pedido. Atualize o quadro.");
    return json({ ok: true });
  }
}

async function stockLines(env, orderId) {
  const { results } = await env.DB.prepare(
    `SELECT i.qty, p.stock_key, p.returns_empty, s.full_qty, s.empty_qty, s.name stock_name
     FROM order_items i JOIN products p ON p.code = i.product_code LEFT JOIN stock s ON s.key = p.stock_key
     WHERE i.order_id = ?`).bind(orderId).all();
  // agrupa por item de estoque (ex.: P13 troca + P13 completo no mesmo pedido)
  const by = new Map();
  for (const r of results) {
    const k = r.stock_key || `__${by.size}`;
    if (by.has(k) && r.stock_key) by.get(k).qty += r.qty;
    else by.set(k, { ...r });
  }
  // vasilhames só retornam pela parte "troca"
  for (const l of by.values()) {
    if (!l.stock_key) continue;
    l.returnQty = results.filter(r => r.stock_key === l.stock_key && r.returns_empty).reduce((a, r) => a + r.qty, 0);
  }
  return [...by.values()].map(l => ({ ...l, returns_empty: l.returnQty > 0, qty_return: l.returnQty }));
}

function move(env, key, dFull, dEmpty, reason, orderId, user, at) {
  return env.DB.prepare(
    "INSERT INTO stock_moves (at, stock_key, delta_full, delta_empty, reason, order_id, user_id) VALUES (?,?,?,?,?,?,?)")
    .bind(at, key, dFull, dEmpty, reason, orderId, user.id);
}

// Ajuste de saldo com justificativa obrigatória (M5: Janine, CEO e Fundadora podem corrigir).
async function adjustStock(request, env, s, key) {
  const b = await body(request);
  const st = await env.DB.prepare("SELECT * FROM stock WHERE key = ?").bind(key).first();
  if (!st) fail(404, "Item de estoque não encontrado.");
  const full = Number(b.full);
  const empty = st.empty_qty === null ? null : Number(b.empty);
  if (!Number.isInteger(full) || full < 0 || full > 100000) fail(400, "Informe a quantidade de cheios (inteiro, 0 ou mais).");
  if (empty !== null && (!Number.isInteger(empty) || empty < 0 || empty > 100000)) fail(400, "Informe a quantidade de vazios (inteiro, 0 ou mais).");
  const reason = cleanText(b.reason, 200, "a justificativa");
  const dFull = full - st.full_qty, dEmpty = empty === null ? 0 : empty - st.empty_qty;
  if (!dFull && !dEmpty) fail(400, "Nenhuma alteração nos saldos.");
  await env.DB.batch([
    env.DB.prepare("UPDATE stock SET full_qty = ?, empty_qty = ? WHERE key = ?").bind(full, empty, key),
    move(env, key, dFull, dEmpty, `Ajuste: ${reason}`, null, s.user, Date.now()),
  ]);
  await audit(env, s.user, "ajuste_estoque", `${key} cheios ${st.full_qty}→${full}${empty !== null ? `, vazios ${st.empty_qty}→${empty}` : ""}: ${reason}`, clientIp(request));
  return json({ ok: true });
}
