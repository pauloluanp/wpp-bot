// Contenção dos logs do `libsignal` (dependência transitiva do Baileys).
//
// PROBLEMA
// O libsignal escreve direto no `console` global — ele ignora por completo o
// `logger: P({ level: "silent" })` que passamos ao `makeWASocket`, porque esse
// logger só governa o código do próprio Baileys. Quatro dessas chamadas passam o
// objeto `SessionEntry` inteiro como segundo argumento (session_record.js):
//
//   console.info("Closing session:", session)
//   console.info("Opening session:", session)
//   console.warn("Session already closed", session)
//   console.info("Removing old closed session:", oldestSession)
//
// Esse objeto carrega material criptográfico da sessão do WhatsApp:
// `currentRatchet.ephemeralKeyPair.privKey`, `currentRatchet.rootKey`,
// `indexInfo.baseKey`, `indexInfo.remoteIdentityKey`, `pendingPreKey` e o mapa
// `_chains[].messageKeys`. O `console` do Node serializa tudo com `util.inspect`,
// então as chaves caem em texto legível no arquivo de log do PM2.
//
// São três estragos ao mesmo tempo:
//   1. SEGURANÇA — chaves privadas de cada margem em disco, em claro.
//   2. CPU — `util.inspect` percorre o objeto recursivamente. Medido: ~1,7 KB e
//      0,10 ms com as chains vazias; ~48,7 KB e 1,19 ms com 200 message keys.
//   3. I/O — cada evento desses grava dezenas de KB. Sob rajada de erros de
//      sessão o próprio logging vira gargalo, e o stdout do processo é um pipe
//      para o PM2: quando ele não drena, o Node enfileira o backlog em memória.
//
// SOLUÇÃO
// Envolvemos os métodos do console: as mensagens conhecidas do libsignal não são
// mais impressas com o objeto. Em vez de simplesmente descartá-las (o que
// deixaria a gente cego justamente no ponto que estamos investigando), elas são
// contadas e sai um resumo agregado a cada intervalo. Trocamos N logs de dezenas
// de KB por uma linha periódica — que é, na prática, o `grep -c` do diagnóstico
// da VPS já calculado em tempo real.
//
// Este módulo precisa ser importado ANTES de qualquer coisa que carregue o
// Baileys, para que o patch já esteja de pé quando o libsignal for exercitado.

const INTERVALO_RESUMO_MS = Number(process.env.LIBSIGNAL_LOG_INTERVAL_MS) || 60_000;

// Prefixos exatos emitidos pelo libsignal. Casamos pelo começo da string para
// não silenciar por acidente um log nosso que mencione as mesmas palavras.
const PADROES = [
  { prefixo: "Closing session:", rotulo: "sessão fechada", vazaObjeto: true },
  { prefixo: "Opening session:", rotulo: "sessão aberta", vazaObjeto: true },
  { prefixo: "Session already closed", rotulo: "sessão já fechada", vazaObjeto: true },
  { prefixo: "Removing old closed session:", rotulo: "sessão antiga removida", vazaObjeto: true },
  { prefixo: "Session already open", rotulo: "sessão já aberta", vazaObjeto: false },
  { prefixo: "Failed to decrypt message with any known session", rotulo: "falha ao descriptografar", vazaObjeto: false },
  { prefixo: "Session error:", rotulo: "erro de sessão", vazaObjeto: false },
  { prefixo: "Decrypted message with closed session", rotulo: "mensagem em sessão fechada", vazaObjeto: false },
  { prefixo: "Closing open session in favor of incoming prekey bundle", rotulo: "prekey bundle recebido", vazaObjeto: false },
  { prefixo: "Closing stale open session for new outgoing prekey bundle", rotulo: "prekey bundle enviado", vazaObjeto: false },
  { prefixo: "Migrating session to:", rotulo: "migração de sessão", vazaObjeto: true },
  { prefixo: "V1 session storage migration error", rotulo: "erro de migração v1", vazaObjeto: true },
];

const contadores = new Map();
let timerResumo = null;
let instalado = false;

function classificar(args) {
  if (args.length === 0) return null;
  const primeiro = args[0];
  if (typeof primeiro !== "string") return null;
  return PADROES.find((p) => primeiro.startsWith(p.prefixo)) || null;
}

function registrar(rotulo) {
  contadores.set(rotulo, (contadores.get(rotulo) || 0) + 1);
}

function emitirResumo(logOriginal) {
  if (contadores.size === 0) return;

  const partes = [...contadores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([rotulo, total]) => `${rotulo}: ${total}`);
  contadores.clear();

  const janela =
    INTERVALO_RESUMO_MS >= 60_000
      ? `${Math.round(INTERVALO_RESUMO_MS / 60_000)} min`
      : `${Math.round(INTERVALO_RESUMO_MS / 1000)}s`;
  logOriginal(`🔐 [libsignal] eventos de sessão nos últimos ${janela} — ${partes.join(" | ")}`);
}

/**
 * Instala o filtro. Idempotente: chamar duas vezes não empilha wrappers.
 * Devolve uma função que restaura o console original (útil em teste).
 */
export function silenceLibsignal() {
  if (instalado) return () => {};
  instalado = true;

  const originais = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  for (const metodo of ["info", "warn", "error", "log"]) {
    console[metodo] = (...args) => {
      const padrao = classificar(args);
      if (padrao) {
        registrar(padrao.rotulo);
        return;
      }
      originais[metodo](...args);
    };
  }

  timerResumo = setInterval(() => emitirResumo(originais.log), INTERVALO_RESUMO_MS);
  // Não segura o event loop aberto só por causa do resumo.
  timerResumo.unref?.();

  return () => {
    clearInterval(timerResumo);
    Object.assign(console, originais);
    instalado = false;
  };
}
