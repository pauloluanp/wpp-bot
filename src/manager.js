import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import path from 'path';
import fs from 'fs';
import P from 'pino';

const sessions = new Map();
const qrcodes = new Map();
const sessionConfigs = new Map();
const sessionStatus = new Map(); // Status das sessões: 'STARTING', 'CONNECTED', 'DISCONNECTED'
const sessionSchedules = new Map(); // Controle de tempo de envio por sessão
const pendingMessages = new Map(); // Controle de respostas (enviar/encerrar) com a estrutura: Map<stanzaId, {timerId, forceSend, sessionId}>

function deepCloneMessage(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Buffer.isBuffer(obj)) return Buffer.from(obj);
  if (obj instanceof Uint8Array) return new Uint8Array(obj);
  if (Array.isArray(obj)) return obj.map(deepCloneMessage);
  const cloned = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      cloned[key] = deepCloneMessage(obj[key]);
    }
  }
  return cloned;
}

export async function startSession(sessionId) {
  if (sessions.has(sessionId)) {
    console.log(`Sessão ${sessionId} já está ativa`);
    return;
  }
  
  sessionStatus.set(sessionId, 'STARTING');
  
  const sessionPath = path.resolve(`./sessions/${sessionId}`);

if (!fs.existsSync(sessionPath)) {
  fs.mkdirSync(sessionPath, { recursive: true });
}

  // Preserva configurações existentes ou cria novas com valores padrão
  const existingConfig = sessionConfigs.get(sessionId);
  
  if (existingConfig) {
    // Se já existe config, preserva tudo e reseta apenas os IDs dos grupos
    console.log(`🔄 [${sessionId}] Reiniciando sessão - preservando configurações existentes`);
    sessionConfigs.set(sessionId, {
      ...existingConfig,
      sourceGroup: null,
      targetGroups: [],
      sourceGroupName: null
    });
  } else {
    // Primeira vez, cria configuração padrão
    console.log(`🆕 [${sessionId}] Criando configuração inicial`);
    sessionConfigs.set(sessionId, {
      sourceGroup: null,
      targetGroups: [],
      sourceGroupName: null,
      sourceGroupPrefix: null,
      targetGroupPrefix: null,
      delayMs: 2 * 60 * 1000
    });
  }


  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`🔄 [${sessionId}] Usando WA v${version.join('.')} (isLatest: ${isLatest})`);

  const sock = makeWASocket({
    logger: P({ level: 'silent' }),
    auth: state,
    version,
    browser: ['Ubuntu', 'Chrome', '20.0.04']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
  const { connection, qr, lastDisconnect } = update;

  if (qr) {
    qrcode.generate(qr, { small: true });
    console.log(`QR Code gerado para ${sessionId}`);
    qrcodes.set(sessionId, qr);
  }

  if (connection === 'open') {
  sessionStatus.set(sessionId, 'CONNECTED');
  console.log(`Sessão ${sessionId} conectada`);
  qrcodes.delete(sessionId);

  const config = sessionConfigs.get(sessionId);
  if (config?.sourceGroupPrefix && config?.targetGroupPrefix) {
    console.log(`\n🔍 [${sessionId}] Buscando grupos com prefixos:`);
    console.log(`   📤 Origem: "${config.sourceGroupPrefix}"`);
    console.log(`   📥 Destino: "${config.targetGroupPrefix}"\n`);
    resolveGroupsByPrefix(sock, sessionId);
  } else {
    console.log(`\n⚠️  [${sessionId}] Prefixos de grupo não configurados. Use /sessions/:id/config para configurar.\n`);
  }
}


  if (connection === 'close') {
    sessionStatus.set(sessionId, 'DISCONNECTED');
    const reason = lastDisconnect?.error?.output?.statusCode;
    
    console.log(`\n❌ [${sessionId}] Desconectado. Código: ${reason}`);

    // Limpa referências em memória
    const oldSock = sessions.get(sessionId);
    if (oldSock) {
      try {
        oldSock.end();
      } catch {}
    }
    sessions.delete(sessionId);
    qrcodes.delete(sessionId);

    // Desconexão intencional ou manual sem erro
    if (reason === undefined || reason === DisconnectReason.intentional) {
      console.log(`🛑 [${sessionId}] Conexão encerrada intencionalmente (stop/delete).`);
      return;
    }

    // Tratamento específico para LOGGED OUT (401) e erros de sessão inválida (405)
    if (reason === DisconnectReason.loggedOut || reason === 405) {
      console.log(`⚠️ [${sessionId}] Sessão inválida ou desconectada pelo celular (Código: ${reason}).`);
      console.log(`🗑️ [${sessionId}] Apagando arquivos da sessão para gerar novo QR Code...`);
      
      const sessionDir = path.resolve(`./sessions/${sessionId}`);
      
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        console.log(`✅ [${sessionId}] Pasta da sessão limpa.`);
      } catch (err) {
        console.error(`❌Erro ao limpar pasta da sessão: ${err.message}`);
      }

      // Reinicia imediatamente para gerar novo QR Code
      console.log(`🔄 [${sessionId}] Iniciando nova sessão limpa...`);
      setTimeout(() => startSession(sessionId), 1000);
      
    } else {
      // Para outros erros (ex: internet caiu), tenta reconectar
      console.log(`🔄 [${sessionId}] Tentando reconectar em 2s...`);
      setTimeout(() => startSession(sessionId), 2000);
    }
  }
});


  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;

      const from = msg.key.remoteJid;
      const isGroup = from.endsWith('@g.us');
      const isFromMe = msg.key.fromMe;

      const config = getSessionConfig(sessionId);
      if (!config || !config.sourceGroup || !config.targetGroups || config.targetGroups.length === 0) {
        console.log(`[${sessionId}] ⚠️  Configuração incompleta - grupos não configurados`);
        continue;
      }

      if (!isGroup) continue;
      if (!isFromMe) continue;
      if (from !== config.sourceGroup) continue;

      // Tenta extrair texto para log, se não houver será considerado mídia
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        '[Áudio/Mídia/Figurinha]';

      // Verifica se é uma resposta e contém comando
      const contextInfo = msg.message.extendedTextMessage?.contextInfo || 
                          msg.message.imageMessage?.contextInfo || 
                          msg.message.videoMessage?.contextInfo;

      if (contextInfo && contextInfo.stanzaId) {
        const repliedId = contextInfo.stanzaId;
        const command = text.trim().toLowerCase();

        if (command === 'enviar' || command === 'encerrar') {
           const pending = pendingMessages.get(repliedId);
           if (pending && pending.sessionId === sessionId) {
               clearTimeout(pending.timerId);
               if (command === 'enviar') {
                   console.log(`\n[${sessionId}] 🚀 FORÇANDO ENVIO IMEDIATO da mensagem ${repliedId}`);
                   pendingMessages.delete(repliedId);
                   await pending.forceSend(); // executa o envio agora
               } else if (command === 'encerrar') {
                   console.log(`\n[${sessionId}] 🛑 CANCELANDO ENVIO da mensagem ${repliedId}`);
                   pendingMessages.delete(repliedId);
               }
           } else {
               console.log(`\n[${sessionId}] ⚠️ Comando "${command}" ignorado: mensagem original já enviada ou não encontrada.`);
           }
           continue; // Ignora esta mensagem de comando para não ser agendada/encaminhada também
        }
      }

      const isMedia = 
        msg.message.imageMessage || 
        msg.message.videoMessage || 
        msg.message.stickerMessage || 
        msg.message.audioMessage || 
        msg.message.documentMessage;

      // Só ignora se não tiver texto nenhum nem mídia reconhecida
      if (!msg.message.conversation && !msg.message.extendedTextMessage && !isMedia) continue;

      // Log detalhado da mensagem recebida
      console.log('\n' + '='.repeat(60));
      console.log(`📨 [${sessionId}] MENSAGEM RECEBIDA`);
      console.log('='.repeat(60));
      console.log(`📍 Grupo de Origem: ${config.sourceGroupName || 'Nome não disponível'}`);
      console.log(`🆔 ID do Grupo: ${from}`);
      console.log(`💬 Mensagem: "${text}"`);
      console.log('='.repeat(60) + '\n');
      
      // Clona a mensagem IMEDIATAMENTE e a congela. Baileys sofre mutação de objetos em cache 
      // via processamentos em background (ex: receipts), o que destrói a mensagem antes do nosso setTimeout rodar.
      const frozenMsg = deepCloneMessage(msg);

      const now = Date.now();
      let lastTime = sessionSchedules.get(sessionId) || now;
      if (lastTime < now) lastTime = now;
      
      // Diferença de tempo aleatória de 1 a 7 minutos (em ms)
      const minGap = 1 * 60 * 1000;
      const maxGap = 7 * 60 * 1000;
      const gap = Math.floor(Math.random() * (maxGap - minGap + 1)) + minGap;
      
      let nextTime = lastTime + gap;
      
      // Limite máximo de 20 minutos a partir de agora
      const maxWait = 19.5 * 60 * 1000; // Segurança (menos de 20min)
      if (nextTime > now + maxWait) {
        nextTime = now + maxWait;
      }
      
      sessionSchedules.set(sessionId, nextTime);
      const delayMs = nextTime - now;

      console.log(`[${sessionId}] ⏳ Aguardando ${(delayMs / 60000).toFixed(2)} minutos antes de encaminhar... (ID: ${msg.key.id})`);

      const sendRoutine = async () => {
        pendingMessages.delete(msg.key.id); // Remove da fila já que vai enviar agora
        try {
          for (const target of config.targetGroups) {
            console.log(`[${sessionId}] ⌨️  Simulando digitação no grupo destino (${target.name})...`);

            await simulateTyping(sock, target.id, 2000 + Math.random() * 2000);

            // Clona a mensagem congelada para evitar que o Baileys a corrompa ao enviar para o próximo alvo do loop
            const targetMsgCopy = deepCloneMessage(frozenMsg);

            // Usa a funcionalidade nativa de forward do Baileys para repassar qualquer tipo de mensagem com perfeição
            await sock.sendMessage(target.id, { forward: targetMsgCopy });

            // Log detalhado do envio
            console.log('\n' + '='.repeat(60));
            console.log(`✅ [${sessionId}] MENSAGEM ENVIADA (ID Original: ${msg.key.id})`);
            console.log('='.repeat(60));
            console.log(`📍 Grupo de Destino: ${target.name || 'Nome não disponível'}`);
            console.log(`🆔 ID do Grupo: ${target.id}`);
            console.log(`💬 Mensagem: "${text}"`);
            console.log('='.repeat(60) + '\n');
          }
        } catch (err) {
          console.error('\n' + '='.repeat(60));
          console.error(`❌ [${sessionId}] ERRO AO ENVIAR MENSAGEM`);
          console.error('='.repeat(60));
          console.error('Erro:', err);
          console.error('='.repeat(60) + '\n');
        }
      };

      const timerId = setTimeout(sendRoutine, delayMs);
      
      pendingMessages.set(msg.key.id, {
          timerId,
          forceSend: sendRoutine,
          sessionId
      });
    }
  });

  sessions.set(sessionId, sock);
}

export function stopSession(sessionId) {
  const sock = sessions.get(sessionId);
  if (!sock) return;

  sock.end();
  sessions.delete(sessionId);
  console.log(`Sessão ${sessionId} encerrada`);
}

export function listSessions() {
  return [...sessions.keys()];
}

export async function getQRCode(sessionId, timeoutMs = 15000) {
  console.log(`[${sessionId}] 📡 Requisição QR via HTTP recebida...`);
  const start = Date.now();
  
  // Aguarda até o timeout para o QR code ser gerado
  while (Date.now() - start < timeoutMs) {
    if (sessionStatus.get(sessionId) === 'CONNECTED') {
      console.log(`[${sessionId}] 📡 Aviso: Sessão já conectada, retonando conectado em vez de QR.`);
      return { status: 'CONNECTED' }; // Informamos que já conectou ao invés de null genérico
    }

    if (qrcodes.has(sessionId)) {
      console.log(`[${sessionId}] 📡 Escutador devolvendo QR Code.`);
      return { qr: qrcodes.get(sessionId) };
    }
    
    // Pequeno delay para não travar a thread
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log(`[${sessionId}] 📡 Escutador de QR expirado após 15s.`);
  return null;
}

export function updateSessionConfig(sessionId, config) {
  const current = sessionConfigs.get(sessionId);
  
  if (!current) {
    // Se a sessão ainda não existe, cria uma nova configuração
    console.log(`📝 [${sessionId}] Criando configuração antes da sessão iniciar`);
    sessionConfigs.set(sessionId, {
      sourceGroup: null,
      targetGroups: [],
      sourceGroupName: null,
      sourceGroupPrefix: null,
      targetGroupPrefix: null,
      delayMs: 2 * 60 * 1000,
      ...config  // Aplica as configurações fornecidas
    });
  } else {
    // Se já existe, atualiza
    sessionConfigs.set(sessionId, {
      ...current,
      ...config
    });
  }
}

export function getSessionConfig(sessionId) {
  return sessionConfigs.get(sessionId);
}

async function simulateTyping(sock, jid, durationMs = 3000) {
  await sock.presenceSubscribe(jid);
  await sock.sendPresenceUpdate('composing', jid);

  await new Promise(resolve => setTimeout(resolve, durationMs));

  await sock.sendPresenceUpdate('paused', jid);
}


async function resolveGroupsByPrefix(sock, sessionId) {
  const config = sessionConfigs.get(sessionId);
  if (!config) return;

  const chats = await sock.groupFetchAllParticipating();

  const groups = Object.values(chats);

  const source = groups.find(g =>
    g.subject?.toLowerCase().startsWith(config.sourceGroupPrefix.toLowerCase())
  );

  const targets = groups.filter(g =>
    g.subject?.toLowerCase().startsWith(config.targetGroupPrefix.toLowerCase())
  );

  if (!source || targets.length === 0) {
    console.log('\n' + '='.repeat(60));
    console.log(`❌ [${sessionId}] GRUPOS NÃO ENCONTRADOS`);
    console.log('='.repeat(60));
    console.log(`Procurando por:`);
    console.log(`   📤 Origem: prefixo "${config.sourceGroupPrefix}" ${!source ? '❌ NÃO ENCONTRADO' : '✅'}`);
    console.log(`   📥 Destino: prefixo "${config.targetGroupPrefix}" ${targets.length === 0 ? '❌ NÃO ENCONTRADO' : `✅ Encontrados: ${targets.length}`}`);
    console.log(`\nGrupos disponíveis (${groups.length}):`);
    groups.forEach((g, idx) => {
      console.log(`   ${idx + 1}. "${g.subject}" (ID: ${g.id})`);
    });
    console.log('='.repeat(60) + '\n');
    return;
  }

  sessionConfigs.set(sessionId, {
    ...config,
    sourceGroup: source.id,
    sourceGroupName: source.subject,
    targetGroups: targets.map(t => ({ id: t.id, name: t.subject }))
  });

  console.log('\n' + '='.repeat(60));
  console.log(`✅ [${sessionId}] GRUPOS CONFIGURADOS COM SUCESSO`);
  console.log('='.repeat(60));
  console.log(`📤 Grupo de Origem: ${source.subject}`);
  console.log(`   ID: ${source.id}`);
  console.log(`📥 Grupos de Destino (${targets.length}):`);
  targets.forEach((t, idx) => {
    console.log(`   ${idx + 1}. ${t.subject} (ID: ${t.id})`);
  });
  console.log('='.repeat(60) + '\n');
}

export function deleteSession(sessionId) {
  const sessionDir = path.resolve(`./sessions/${sessionId}`);
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    console.log(`✅ [${sessionId}] Pasta da sessão limpa.`);
  }
  sessions.delete(sessionId);
  qrcodes.delete(sessionId);
  sessionConfigs.delete(sessionId);
  sessionSchedules.delete(sessionId);

  return { ok: true };
}