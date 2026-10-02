#!/usr/bin/env node
// Cria ou redefine um usuário do MOS.
// Uso:
//   npm run user:create -- <usuario> "<Nome>" <fundadora|ceo|atendimento> [--remote]
// A senha é pedida no terminal e nunca fica gravada em arquivo do projeto.
// O usuário é obrigado a trocar a senha no primeiro acesso.

import { pbkdf2Sync, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";

const ITER = 100000; // limite máximo do PBKDF2 no runtime da Cloudflare
const ROLES = ["fundadora", "ceo", "atendimento"];

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const [username, name, role] = args.filter(a => a !== "--remote");

if (!username || !name || !ROLES.includes(role)) {
  console.error('Uso: npm run user:create -- <usuario> "<Nome>" <fundadora|ceo|atendimento> [--remote]');
  process.exit(1);
}
if (!/^[a-z0-9._-]{3,32}$/i.test(username)) {
  console.error("Usuário deve ter de 3 a 32 caracteres: letras, números, ponto, hífen ou sublinhado.");
  process.exit(1);
}

function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = s => { if (s.startsWith(question)) process.stdout.write(s); else process.stdout.write("*"); };
    rl.question(question, answer => { rl.close(); process.stdout.write("\n"); resolve(answer); });
  });
}

const pass1 = process.env.MOS_PASSWORD ?? await ask("Senha provisória: ");
const pass2 = process.env.MOS_PASSWORD ?? await ask("Repita a senha: ");
if (pass1 !== pass2) { console.error("As senhas não conferem."); process.exit(1); }
if (pass1.length < 10) { console.error("A senha deve ter pelo menos 10 caracteres."); process.exit(1); }

const salt = randomBytes(16).toString("base64");
const hash = pbkdf2Sync(pass1, Buffer.from(salt, "base64"), ITER, 32, "sha256").toString("base64");
const q = s => "'" + String(s).replace(/'/g, "''") + "'";
const now = Date.now();

const sql = `INSERT INTO users (username, name, role, pass_hash, pass_salt, pass_iter, must_change, created_at)
VALUES (${q(username)}, ${q(name)}, ${q(role)}, ${q(hash)}, ${q(salt)}, ${ITER}, 1, ${now})
ON CONFLICT(username) DO UPDATE SET name=excluded.name, role=excluded.role, pass_hash=excluded.pass_hash,
  pass_salt=excluded.pass_salt, pass_iter=excluded.pass_iter, must_change=1, failed_count=0, locked_until=0, active=1;
DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ${q(username)});`;

const dir = mkdtempSync(join(tmpdir(), "mos-"));
const file = join(dir, "user.sql");
writeFileSync(file, sql);
try {
  // shell: true para funcionar também no Windows (npx é um .cmd)
  const r = spawnSync(`npx wrangler d1 execute mos-db ${remote ? "--remote" : "--local"} --file "${file}"`,
    { stdio: "inherit", shell: true });
  if (r.status !== 0) throw new Error("Falha ao gravar o usuário no banco (veja a mensagem do wrangler acima).");
  console.log(`\nUsuário "${username}" (${role}) pronto no banco ${remote ? "de produção" : "local"}. Troca de senha exigida no primeiro acesso.`);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  unlinkSync(file);
}
