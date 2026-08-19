import fs from 'node:fs';

import { ARQUIVO, lerEnv } from './env.mjs';

const safe = (value, fallback = 'não definido') => {
  const clean = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 180);
  return clean || fallback;
};

const enabled = (value) => (String(value ?? '').trim() ? 'configurado' : 'não configurado');

if (!fs.existsSync(ARQUIVO)) {
  console.log('  Configuração: nenhuma (.env ausente)');
  process.exit(0);
}

const env = lerEnv();
const hasClientId = Boolean(String(env.DISCORD_CLIENT_ID ?? '').trim());
const hasClientSecret = Boolean(String(env.DISCORD_CLIENT_SECRET ?? '').trim());

let discord = 'não configurado';
if (hasClientId && hasClientSecret) discord = 'configurado';
else if (hasClientId || hasClientSecret) discord = 'incompleto (pode continuar assim)';

console.log('  Configuração encontrada:');
console.log('');
console.log(`  Discord:       ${discord}`);
console.log(`  Bot:           ${enabled(env.DISCORD_BOT_TOKEN)}`);
console.log(`  Admin:         ${enabled(env.DISCORD_ADMIN_ID)}`);
console.log(`  Public Origin: ${safe(env.PUBLIC_ORIGIN)}`);
console.log('');
console.log('  Nenhum token ou secret foi exibido.');
