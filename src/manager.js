import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import path from "path";
import fs from "fs";
import P from "pino";
import TelegramBot from "node-telegram-bot-api";
import { db } from "./db/index.js";
import { sessions as dbSessions } from "./db/schema.js";
import { eq } from "drizzle-orm";

const sessions = new Map();
const qrcodes = new Map();
const sessionConfigs = new Map();
const sessionStatus = new Map(); // Status das sessões: 'STARTING', 'CONNECTED', 'DISCONNECTED'
const sessionSchedules = new Map(); // Controle de tempo de envio: Map<sessionId, {lastTime, windowStart, count}>
const pendingMessages = new Map(); // Controle de respostas (enviar/encerrar) com a estrutura: Map<stanzaId, {timerId, forceSend, sessionId}>
const telegramBots = new Map();
const processedMessages = new Set();

const MSG_PER_WINDOW = 3;
const WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_DELAY_MS = 2 * 60 * 1000;

function getMessageKey(sessionId, messageId) {
  return `${sessionId}:${messageId}`;
}

function markMessageAsProcessed(sessionId, messageId) {
  const key = getMessageKey(sessionId, messageId);
  if (processedMessages.has(key)) return false;

  processedMessages.add(key);
  setTimeout(() => processedMessages.delete(key), 2 * 60 * 60 * 1000);
  return true;
}

function deepCloneMessage(obj) {
  if (obj === null || typeof obj !== "object") return obj;
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

function getTelegramBot(sessionId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn(
      `[${sessionId}] ⚠️ TELEGRAM_BOT_TOKEN não configurado. Pulando envio para Telegram.`,
    );
    return null;
  }

  if (!telegramBots.has(token)) {
    const pollingEnabled = process.env.TELEGRAM_POLLING !== "false";
    const bot = new TelegramBot(token, {
      polling: pollingEnabled
        ? {
            params: {
              allowed_updates: [
                "message",
                "channel_post",
                "my_chat_member",
                "chat_member",
              ],
            },
          }
        : false,
    });

    const chats = new Map();
    const registerChat = (chat) => {
      if (!chat?.id || !chat?.title) return;
      if (!["group", "supergroup", "channel"].includes(chat.type)) return;

      const alreadyRegistered = chats.has(String(chat.id));
      chats.set(String(chat.id), {
        id: chat.id,
        title: chat.title,
        type: chat.type,
        username: chat.username,
      });

      if (!alreadyRegistered) {
        console.log(
          `✅ Telegram: grupo descoberto "${chat.title}" (ID: ${chat.id})`,
        );
      }

      refreshTelegramTargetsForSessions();
    };

    if (pollingEnabled) {
      bot.on("message", (message) => {
        console.log(
          `📨 Telegram update: mensagem em "${message.chat?.title || message.chat?.id}"`,
        );
        registerChat(message.chat);
      });
      bot.on("channel_post", (message) => {
        console.log(
          `📨 Telegram update: post em "${message.chat?.title || message.chat?.id}"`,
        );
        registerChat(message.chat);
      });
      bot.on("my_chat_member", (update) => registerChat(update.chat));
      bot.on("chat_member", (update) => registerChat(update.chat));
      let pollingConflictLogged = false;

      bot.on("polling_error", (err) => {
        const message = err.message || String(err);
        const isConflict =
          message.includes("409 Conflict") ||
          message.includes("terminated by other getUpdates request");
        const isNetworkError =
          message.includes("ENETUNREACH") ||
          message.includes("EAI_AGAIN") ||
          message.includes("ETIMEDOUT") ||
          message.includes("ECONNRESET") ||
          message.includes("AggregateError");

        if (isConflict) {
          if (!pollingConflictLogged) {
            pollingConflictLogged = true;
            console.warn(
              "⚠️ Telegram polling pausado: existe outra instância usando o mesmo TELEGRAM_BOT_TOKEN. Encerre a outra instância e reinicie este servidor para voltar a descobrir grupos automaticamente.",
            );
          }

          bot.stopPolling().catch(() => {});
          return;
        }

        if (isNetworkError) {
          console.warn(
            "⚠️ Telegram polling: falha temporária de rede. O bot tentará novamente automaticamente.",
          );
          return;
        }

        console.error("❌ Erro no polling do Telegram:", message);
      });
    } else {
      console.log(
        "ℹ️ Listener do Telegram iniciado sem polling (TELEGRAM_POLLING=false).",
      );
    }

    telegramBots.set(token, { bot, chats });
    if (pollingEnabled) {
      console.log("✅ Listener do Telegram iniciado.");
    }
    bot
      .getMe()
      .then((me) => {
        console.log(`✅ Telegram bot conectado: @${me.username}`);
      })
      .catch((err) => {
        console.error("❌ Erro ao validar bot do Telegram:", err.message);
      });
  }

  return telegramBots.get(token);
}

export function initTelegramBot() {
  getTelegramBot("telegram");
}

export async function getTelegramStatus() {
  const telegram = getTelegramBot("telegram");
  if (!telegram) {
    return {
      ok: false,
      groups: [],
      error: "TELEGRAM_BOT_TOKEN não configurado",
    };
  }

  const me = await telegram.bot.getMe();

  return {
    ok: true,
    bot: {
      id: me.id,
      username: me.username,
      firstName: me.first_name,
    },
    groups: Array.from(telegram.chats.values()),
  };
}

function resolveTelegramGroupsByPrefix(sessionId, prefix) {
  if (!prefix) return [];

  const telegram = getTelegramBot(sessionId);
  if (!telegram) return [];

  const normalizedPrefix = prefix.toLowerCase();
  return Array.from(telegram.chats.values()).filter((chat) =>
    chat.title?.toLowerCase().startsWith(normalizedPrefix),
  );
}

function refreshTelegramTargetsForSessions() {
  for (const [sessionId, config] of sessionConfigs.entries()) {
    if (!config.targetGroupPrefix) continue;

    const telegramTargets = resolveTelegramGroupsByPrefix(
      sessionId,
      config.targetGroupPrefix,
    );

    const previousCount = config.telegramTargetGroups?.length || 0;
    sessionConfigs.set(sessionId, {
      ...config,
      telegramTargetGroups: telegramTargets,
    });

    if (telegramTargets.length !== previousCount) {
      console.log(
        `✅ [${sessionId}] Telegram atualizado: ${telegramTargets.length} grupo(s) com prefixo "${config.targetGroupPrefix}".`,
      );
    }
  }
}

function getMessageCaption(message) {
  return (
    message.message?.conversation ||
    message.message?.extendedTextMessage?.text ||
    message.message?.imageMessage?.caption ||
    message.message?.videoMessage?.caption ||
    message.message?.documentMessage?.caption ||
    ""
  );
}

async function downloadWhatsAppMedia(sock, message) {
  return downloadMediaMessage(
    message,
    "buffer",
    {},
    {
      logger: P({ level: "silent" }),
      reuploadRequest: sock.updateMediaMessage,
    },
  );
}

async function sendTelegramMessage(bot, chatId, media) {
  const caption = media.caption || undefined;
  const fileOptions = {
    filename: media.fileName || "whatsapp-media",
    contentType: media.mimeType,
  };

  if (media.type === "text") {
    await bot.sendMessage(chatId, media.text);
    return;
  }

  if (media.type === "image") {
    await bot.sendPhoto(chatId, media.buffer, { caption }, fileOptions);
    return;
  }

  if (media.type === "video") {
    await bot.sendVideo(chatId, media.buffer, { caption }, fileOptions);
    return;
  }

  if (media.type === "audio") {
    await bot.sendAudio(chatId, media.buffer, { caption }, fileOptions);
    return;
  }

  if (media.type === "sticker") {
    await bot.sendSticker(chatId, media.buffer, {}, fileOptions);
    return;
  }

  await bot.sendDocument(chatId, media.buffer, { caption }, fileOptions);
}

async function createTelegramPayload(sock, message, fallbackText) {
  const caption = getMessageCaption(message);
  const content = message.message || {};

  if (content.imageMessage) {
    return {
      type: "image",
      buffer: await downloadWhatsAppMedia(sock, message),
      caption,
      fileName: "imagem.jpg",
      mimeType: content.imageMessage.mimetype,
    };
  }

  if (content.videoMessage) {
    return {
      type: "video",
      buffer: await downloadWhatsAppMedia(sock, message),
      caption,
      fileName: "video.mp4",
      mimeType: content.videoMessage.mimetype,
    };
  }

  if (content.audioMessage) {
    return {
      type: "audio",
      buffer: await downloadWhatsAppMedia(sock, message),
      caption,
      fileName: "audio.ogg",
      mimeType: content.audioMessage.mimetype,
    };
  }

  if (content.stickerMessage) {
    return {
      type: "sticker",
      buffer: await downloadWhatsAppMedia(sock, message),
      fileName: "sticker.webp",
      mimeType: content.stickerMessage.mimetype,
    };
  }

  if (content.documentMessage) {
    return {
      type: "document",
      buffer: await downloadWhatsAppMedia(sock, message),
      caption,
      fileName: content.documentMessage.fileName || "arquivo",
      mimeType: content.documentMessage.mimetype,
    };
  }

  return {
    type: "text",
    text: caption || fallbackText,
  };
}

export async function resetAllSessionStatus() {
  console.log("🧹 Resetando status de todas as sessões no banco de dados...");
  try {
    await db.update(dbSessions).set({ status: false });
    console.log("✅ Todas as sessões marcadas como inativas.");
  } catch (err) {
    console.error("❌ Erro ao resetar status das sessões:", err);
  }
}

export async function autoRestartSessions() {
  console.log("🔄 Iniciando auto-restauração de sessões...");
  try {
    const allSessions = await db.select().from(dbSessions);
    console.log(`Found ${allSessions.length} sessions to check.`);
    for (const session of allSessions) {
      console.log(`🚀 Auto-iniciando sessão: ${session.sessionId}`);
      startSession(session.sessionId).catch((err) =>
        console.error(`Erro ao auto-iniciar ${session.sessionId}:`, err),
      );
    }
  } catch (err) {
    console.error("❌ Erro na auto-restauração:", err);
  }
}

export async function startSession(sessionId) {
  const currentStatus = sessionStatus.get(sessionId);
  if (sessions.has(sessionId) || currentStatus === "STARTING") {
    console.log(`[${sessionId}] ⚠️ Sessão já está ativa ou em processo de inicialização.`);
    return;
  }

  sessionStatus.set(sessionId, "STARTING");

  const sessionPath = path.resolve(`./sessions/${sessionId}`);

  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
  }

  // Tenta recuperar configuração do Map ou do Banco de Dados
  let config = sessionConfigs.get(sessionId);

  if (!config) {
    console.log(`🔍 [${sessionId}] Buscando configuração no banco de dados...`);
    try {
      const dbResult = await db
        .select()
        .from(dbSessions)
        .where(eq(dbSessions.sessionId, sessionId));

      if (dbResult && dbResult.length > 0) {
        const dbSession = dbResult[0];
        config = {
          sourceGroup: null,
          targetGroups: [],
          sourceGroupName: null,
          sourceGroupPrefix: dbSession.sourceGroup,
          targetGroupPrefix: dbSession.targetGroup,
          telegramTargetGroups: [],
          delayMs: DEFAULT_DELAY_MS,
        };
        console.log(`✅ [${sessionId}] Configuração carregada do banco.`);
      }
    } catch (err) {
      console.error(`❌ [${sessionId}] Erro ao buscar config no banco:`, err);
    }
  }

  if (config) {
    // Se já existe config, preserva prefixos e reseta IDs dinâmicos de grupos
    console.log(
      `🔄 [${sessionId}] Iniciando sessão "${sessionId}" - usando prefixos: [${config.sourceGroupPrefix}] -> [${config.targetGroupPrefix}]`,
    );
    sessionConfigs.set(sessionId, {
      ...config,
      sourceGroup: null,
      targetGroups: [],
      sourceGroupName: null,
      telegramTargetGroups: [],
    });
  } else {
    // Primeira vez absoluta, cria configuração padrão
    console.log(`🆕 [${sessionId}] Criando configuração inicial padrão`);
    sessionConfigs.set(sessionId, {
      sourceGroup: null,
      targetGroups: [],
      sourceGroupName: null,
      sourceGroupPrefix: null,
      targetGroupPrefix: null,
      telegramTargetGroups: [],
      delayMs: DEFAULT_DELAY_MS,
    });
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(
    `🔄 [${sessionId}] Usando WA v${version.join(".")} (isLatest: ${isLatest})`,
  );

  const sock = makeWASocket({
    logger: P({ level: "silent" }),
    auth: state,
    version,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      // qrcode.generate(qr, { small: true });
      console.log(`QR Code gerado para ${sessionId}`);
      qrcodes.set(sessionId, qr);
    }

    if (connection === "open") {
      sessionStatus.set(sessionId, "CONNECTED");
      console.log(`Sessão ${sessionId} conectada`);
      qrcodes.delete(sessionId);

      // Atualiza BD
      db.update(dbSessions)
        .set({ status: true })
        .where(eq(dbSessions.sessionId, sessionId))
        .catch((err) => console.error("Erro BD open:", err));

      const config = sessionConfigs.get(sessionId);
      if (config?.sourceGroupPrefix && config?.targetGroupPrefix) {
        console.log(`\n🔍 [${sessionId}] Buscando grupos com prefixos:`);
        console.log(`   📤 Origem: "${config.sourceGroupPrefix}"`);
        console.log(`   📥 Destino: "${config.targetGroupPrefix}"`);
        console.log("");
        resolveGroupsByPrefix(sock, sessionId);
      } else {
        console.log(
          `\n⚠️  [${sessionId}] Prefixos de grupo não configurados. Use /sessions/:id/config para configurar.\n`,
        );
      }
    }

    if (connection === "close") {
      sessionStatus.set(sessionId, "DISCONNECTED");
      const reason = lastDisconnect?.error?.output?.statusCode;

      // Atualiza BD
      db.update(dbSessions)
        .set({ status: false })
        .where(eq(dbSessions.sessionId, sessionId))
        .catch((err) => console.error("Erro BD close:", err));

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
        console.log(
          `🛑 [${sessionId}] Conexão encerrada intencionalmente (stop/delete).`,
        );
        return;
      }

      // Tratamento específico para LOGGED OUT (401) e erros de sessão inválida (405)
      if (reason === DisconnectReason.loggedOut || reason === 405) {
        console.log(
          `⚠️ [${sessionId}] Sessão inválida ou desconectada pelo celular (Código: ${reason}).`,
        );
        console.log(
          `🗑️ [${sessionId}] Apagando arquivos da sessão para gerar novo QR Code...`,
        );

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

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;

      const from = msg.key.remoteJid;
      const isGroup = from.endsWith("@g.us");
      // const isFromMe = msg.key.fromMe;

      const config = getSessionConfig(sessionId);
      if (
        !config ||
        !config.sourceGroup ||
        ((!config.targetGroups || config.targetGroups.length === 0) &&
          (!config.telegramTargetGroups ||
            config.telegramTargetGroups.length === 0))
      ) {
        console.log(
          `[${sessionId}] ⚠️  Configuração incompleta - grupos não configurados`,
        );
        continue;
      }

      if (!isGroup) continue;
      if (from !== config.sourceGroup) continue;

      if (!markMessageAsProcessed(sessionId, msg.key.id)) {
        console.log(
          `[${sessionId}] ⚠️ Mensagem duplicada ignorada (ID: ${msg.key.id})`,
        );
        continue;
      }

      // Tenta extrair texto para log, se não houver será considerado mídia
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        "[Áudio/Mídia/Figurinha]";

      // Verifica se é uma resposta e contém comando
      const contextInfo =
        msg.message.extendedTextMessage?.contextInfo ||
        msg.message.imageMessage?.contextInfo ||
        msg.message.videoMessage?.contextInfo;

      if (contextInfo && contextInfo.stanzaId) {
        const repliedId = contextInfo.stanzaId;
        const command = text.trim().toLowerCase();

        if (command === "enviar" || command === "encerrar") {
          const pendingKey = getMessageKey(sessionId, repliedId);
          const pending = pendingMessages.get(pendingKey);
          if (pending && pending.sessionId === sessionId) {
            clearTimeout(pending.timerId);
            if (command === "enviar") {
              console.log(
                `\n[${sessionId}] 🚀 FORÇANDO ENVIO IMEDIATO da mensagem ${repliedId}`,
              );
              pendingMessages.delete(pendingKey);
              await pending.forceSend(); // executa o envio agora
            } else if (command === "encerrar") {
              console.log(
                `\n[${sessionId}] 🛑 CANCELANDO ENVIO da mensagem ${repliedId}`,
              );
              pendingMessages.delete(pendingKey);
            }
          } else {
            console.log(
              `\n[${sessionId}] ⚠️ Comando "${command}" ignorado: mensagem original já enviada ou não encontrada.`,
            );
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

      // Limita mensagens pendentes para evitar sobrecarga de memória
      const pendingCount = Array.from(pendingMessages.values()).filter(
        (p) => p.sessionId === sessionId,
      ).length;
      if (pendingCount >= 50) {
        // Limite de 50 mensagens pendentes por sessão
        console.log(
          `[${sessionId}] ⚠️ Muitas mensagens pendentes (${pendingCount}), ignorando nova mensagem para evitar sobrecarga.`,
        );
        continue;
      }

      // Log detalhado da mensagem recebida
      console.log("\n" + "=".repeat(60));
      console.log(`📨 [${sessionId}] MENSAGEM RECEBIDA`);
      console.log("=".repeat(60));
      console.log(
        `📍 Grupo de Origem: ${config.sourceGroupName || "Nome não disponível"}`,
      );
      console.log(`🆔 ID do Grupo: ${from}`);
      console.log(`💬 Mensagem: "${text}"`);
      console.log("=".repeat(60) + "\n");

      // Clona a mensagem IMEDIATAMENTE e a congela. Baileys sofre mutação de objetos em cache
      // via processamentos em background (ex: receipts), o que destrói a mensagem antes do nosso setTimeout rodar.
      const msgSize = JSON.stringify(msg).length;
      console.log(
        `[${sessionId}] 📏 Tamanho da mensagem: ${(msgSize / 1024).toFixed(2)} KB`,
      );
      const frozenMsg = deepCloneMessage(msg);

      const now = Date.now();
      const nextQuarterStart = Math.ceil(now / WINDOW_MS) * WINDOW_MS;

      let schedule = sessionSchedules.get(sessionId) || {
        lastTime: 0,
        windowStart: nextQuarterStart,
        count: 0,
      };

      // Se passou o tempo da janela atual ou é uma nova sessão, reseta para a próxima janela disponível
      if (now > schedule.windowStart + WINDOW_MS || schedule.lastTime === 0) {
        schedule.windowStart = Math.max(nextQuarterStart, schedule.windowStart);
        schedule.count = 0;
        schedule.lastTime = schedule.windowStart;
      }

      // Se atingiu o limite da janela, pula para a próxima
      if (schedule.count >= MSG_PER_WINDOW) {
        schedule.windowStart += WINDOW_MS;
        schedule.count = 0;
        schedule.lastTime = schedule.windowStart;
      }

      // Calcula o próximo envio com um gap aleatório dentro da janela
      const minGap = 2 * 60 * 1000; // Mínimo 2 min entre msgs dentro da mesma janela
      const maxGap = 4 * 60 * 1000; // Máximo 4 min
      const gap = Math.floor(Math.random() * (maxGap - minGap + 1)) + minGap;

      let nextTime = schedule.lastTime + gap;

      // Garante que não ultrapasse o fim da janela atual de 15 min (deixa margem de 1 min)
      const windowEnd = schedule.windowStart + WINDOW_MS - 60000;
      if (nextTime > windowEnd) {
        nextTime = windowEnd;
      }

      schedule.lastTime = nextTime;
      schedule.count++;
      sessionSchedules.set(sessionId, schedule);

      const delayMs = nextTime - now;

      console.log(
        `[${sessionId}] ⏳ Aguardando ${(delayMs / 60000).toFixed(2)} minutos antes de encaminhar... (ID: ${msg.key.id})`,
      );

      const sendRoutine = async () => {
        const pendingKey = getMessageKey(sessionId, msg.key.id);
        pendingMessages.delete(pendingKey); // Remove da fila já que vai enviar agora
        
        const currentSock = sessions.get(sessionId);
        const isConnected = sessionStatus.get(sessionId) === "CONNECTED";
        const currentConfig = getSessionConfig(sessionId);

        if (!currentSock || !isConnected || !currentConfig) {
          console.log(`[${sessionId}] 🛑 Abortando envio: Conexão inativa ou perdida (ID: ${msg.key.id})`);
          return;
        }

        try {
          for (const target of currentConfig.targetGroups || []) {
            console.log(
              `[${sessionId}] ⌨️  Simulando digitação no grupo destino (${target.name})...`,
            );

            try {
              await simulateTyping(currentSock, target.id, 2000 + Math.random() * 2000);
            } catch (e) {
              console.warn(`[${sessionId}] ⚠️ Falha ao simular digitação: ${e.message}`);
            }

            // Clona a mensagem congelada para evitar que o Baileys a corrompa ao enviar para o próximo alvo do loop
            const targetMsgCopy = deepCloneMessage(frozenMsg);

            // Usa a funcionalidade nativa de forward do Baileys para repassar qualquer tipo de mensagem com perfeição
            await currentSock.sendMessage(target.id, { forward: targetMsgCopy });

            // Log detalhado do envio
            console.log("\n" + "=".repeat(60));
            console.log(
              `✅ [${sessionId}] MENSAGEM ENVIADA (ID Original: ${msg.key.id})`,
            );
            console.log("=".repeat(60));
            console.log(
              `📍 Grupo de Destino: ${target.name || "Nome não disponível"}`,
            );
            console.log(`🆔 ID do Grupo: ${target.id}`);
            console.log(`💬 Mensagem: "${text}"`);
            console.log("=".repeat(60) + "\n");
          }

          const telegramTargets = resolveTelegramGroupsByPrefix(
            sessionId,
            currentConfig.targetGroupPrefix,
          );

          if (telegramTargets.length) {
            const telegram = getTelegramBot(sessionId);
            if (telegram) {
              const telegramPayload = await createTelegramPayload(
                currentSock,
                deepCloneMessage(frozenMsg),
                text,
              );

              for (const target of telegramTargets) {
                await sendTelegramMessage(
                  telegram.bot,
                  target.id,
                  telegramPayload,
                );

                console.log("\n" + "=".repeat(60));
                console.log(
                  `✅ [${sessionId}] MENSAGEM ENVIADA PARA TELEGRAM (ID Original: ${msg.key.id})`,
                );
                console.log("=".repeat(60));
                console.log(`📍 Grupo Telegram: ${target.title}`);
                console.log(`🆔 ID do Grupo Telegram: ${target.id}`);
                console.log(`💬 Mensagem: "${text}"`);
                console.log("=".repeat(60) + "\n");
              }
            }
          }
        } catch (err) {
          console.error("\n" + "=".repeat(60));
          console.error(`❌ [${sessionId}] ERRO AO ENVIAR MENSAGEM`);
          console.error("=".repeat(60));
          console.error("Erro:", err.message || err);
          console.error("=".repeat(60) + "\n");
          
          // Se for erro de conexão, garante que o status reflita isso
          if (err.message?.includes('Closed') || err.output?.statusCode === 428) {
            sessionStatus.set(sessionId, "DISCONNECTED");
          }
        }
      };

      const timerId = setTimeout(sendRoutine, delayMs);
      const pendingKey = getMessageKey(sessionId, msg.key.id);

      pendingMessages.set(pendingKey, {
        timerId,
        forceSend: sendRoutine,
        sessionId,
        msgId: msg.key.id,
        scheduledTime: nextTime,
        messagePreview:
          text.substring(0, 100) + (text.length > 100 ? "..." : ""),
      });
    }
  });

  sessions.set(sessionId, sock);

  // Limpeza periódica de mensagens pendentes antigas (a cada 30 minutos)
  setInterval(
    () => {
      const now = Date.now();
      for (const [msgId, data] of pendingMessages.entries()) {
        if (
          data.sessionId === sessionId &&
          now - data.scheduledTime > 60 * 60 * 1000
        ) {
          // 1 hora
          console.log(
            `[${sessionId}] 🧹 Limpando mensagem pendente antiga: ${msgId}`,
          );
          clearTimeout(data.timerId);
          pendingMessages.delete(msgId);
        }
      }
    },
    30 * 60 * 1000,
  ); // A cada 30 minutos
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
    if (sessionStatus.get(sessionId) === "CONNECTED") {
      console.log(
        `[${sessionId}] 📡 Aviso: Sessão já conectada, retonando conectado em vez de QR.`,
      );
      return { status: "CONNECTED" }; // Informamos que já conectou ao invés de null genérico
    }

    if (qrcodes.has(sessionId)) {
      console.log(`[${sessionId}] 📡 Escutador devolvendo QR Code.`);
      return { qr: qrcodes.get(sessionId) };
    }

    // Pequeno delay para não travar a thread
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log(`[${sessionId}] 📡 Escutador de QR expirado após 15s.`);
  return null;
}

export function updateSessionConfig(sessionId, config) {
  const current = sessionConfigs.get(sessionId);

  if (!current) {
    // Se a sessão ainda não existe, cria uma nova configuração
    console.log(
      `📝 [${sessionId}] Criando configuração antes da sessão iniciar`,
    );
    sessionConfigs.set(sessionId, {
      sourceGroup: null,
      targetGroups: [],
      sourceGroupName: null,
      sourceGroupPrefix: null,
      targetGroupPrefix: null,
      telegramTargetGroups: [],
      delayMs: DEFAULT_DELAY_MS,
      ...config, // Aplica as configurações fornecidas
    });
  } else {
    // Se já existe, atualiza
    sessionConfigs.set(sessionId, {
      ...current,
      ...config,
      ...(config.sourceGroupPrefix || config.targetGroupPrefix
        ? {
            sourceGroup: null,
            targetGroups: [],
            sourceGroupName: null,
            telegramTargetGroups: [],
          }
        : {}),
    });
  }

  // Se a sessão estiver conectada e prefixos foram atualizados, tenta resolver grupos
  if (
    sessionStatus.get(sessionId) === "CONNECTED" &&
    (config.sourceGroupPrefix || config.targetGroupPrefix)
  ) {
    const sock = sessions.get(sessionId);
    if (sock) {
      console.log(
        `🔄 [${sessionId}] Tentando resolver grupos após atualização de config...`,
      );
      resolveGroupsByPrefix(sock, sessionId);
    }
  }
}

export function getSessionConfig(sessionId) {
  return sessionConfigs.get(sessionId);
}

async function simulateTyping(sock, jid, durationMs = 3000) {
  try {
    if (!sock) return;
    
    await sock.presenceSubscribe(jid);
    await sock.sendPresenceUpdate("composing", jid);

    await new Promise((resolve) => setTimeout(resolve, durationMs));

    await sock.sendPresenceUpdate("paused", jid);
  } catch (err) {
    console.error(`[${sock?.user?.id || 'unknown'}] ⚠️ Erro ao simular digitação: ${err.message}`);
  }
}

async function resolveGroupsByPrefix(sock, sessionId) {
  const config = sessionConfigs.get(sessionId);
  if (!config) return;

  const chats = await sock.groupFetchAllParticipating();

  const groups = Object.values(chats);

  const source = groups.find((g) =>
    g.subject?.toLowerCase().startsWith(config.sourceGroupPrefix.toLowerCase()),
  );

  const targets = config.targetGroupPrefix
    ? groups.filter((g) =>
        g.subject
          ?.toLowerCase()
          .startsWith(config.targetGroupPrefix.toLowerCase()),
      )
    : [];
  const telegramTargets = resolveTelegramGroupsByPrefix(
    sessionId,
    config.targetGroupPrefix,
  );
  const hasTelegramTargets = telegramTargets.length > 0;

  if (!source) {
    console.log("\n" + "=".repeat(60));
    console.log(`❌ [${sessionId}] GRUPOS NÃO ENCONTRADOS`);
    console.log("=".repeat(60));
    console.log(`Procurando por:`);
    console.log(
      `   📤 Origem: prefixo "${config.sourceGroupPrefix}" ${!source ? "❌ NÃO ENCONTRADO" : "✅"}`,
    );
    console.log(`\nGrupos disponíveis (${groups.length}):`);
    groups.forEach((g, idx) => {
      console.log(`   ${idx + 1}. "${g.subject}" (ID: ${g.id})`);
    });
    console.log("=".repeat(60) + "\n");
    return;
  }

  sessionConfigs.set(sessionId, {
    ...config,
    sourceGroup: source.id,
    sourceGroupName: source.subject,
    targetGroups: targets.map((t) => ({ id: t.id, name: t.subject })),
    telegramTargetGroups: telegramTargets,
  });

  if (targets.length === 0 && !hasTelegramTargets) {
    console.log("\n" + "=".repeat(60));
    console.log(`⚠️ [${sessionId}] DESTINOS NÃO ENCONTRADOS`);
    console.log("=".repeat(60));
    console.log(`📤 Grupo de Origem: ${source.subject}`);
    console.log(`   ID: ${source.id}`);
    console.log(
      `📥 WhatsApp destino: prefixo "${config.targetGroupPrefix}" ❌ NÃO ENCONTRADO`,
    );
    console.log(
      `📥 Telegram destino: prefixo "${config.targetGroupPrefix}" ❌ NÃO ENCONTRADO`,
    );
    console.log(
      "ℹ️  Para Telegram, envie uma mensagem no grupo de destino ou adicione/re-adicione o bot para ele descobrir o título do grupo.",
    );
    console.log("=".repeat(60) + "\n");
    return;
  }

  console.log("\n" + "=".repeat(60));
  console.log(`✅ [${sessionId}] GRUPOS CONFIGURADOS COM SUCESSO`);
  console.log("=".repeat(60));
  console.log(`📤 Grupo de Origem: ${source.subject}`);
  console.log(`   ID: ${source.id}`);
  if (targets.length) {
    console.log(`📥 Grupos de Destino WhatsApp (${targets.length}):`);
    targets.forEach((t, idx) => {
      console.log(`   ${idx + 1}. ${t.subject} (ID: ${t.id})`);
    });
  }
  if (hasTelegramTargets) {
    console.log(`📥 Grupos de Destino Telegram (${telegramTargets.length}):`);
    telegramTargets.forEach((chat, idx) => {
      console.log(`   ${idx + 1}. ${chat.title} (ID: ${chat.id})`);
    });
  }
  console.log("=".repeat(60) + "\n");
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

  // Limpa mensagens pendentes
  for (const [msgId, data] of pendingMessages.entries()) {
    if (data.sessionId === sessionId) {
      clearTimeout(data.timerId);
      pendingMessages.delete(msgId);
    }
  }

  return { ok: true };
}

export function getPendingMessages(sessionId) {
  const pending = [];
  for (const [msgId, data] of pendingMessages.entries()) {
    if (data.sessionId === sessionId) {
      pending.push({
        msgId: data.msgId || msgId,
        scheduledTime: data.scheduledTime,
        messagePreview: data.messagePreview,
      });
    }
  }
  return pending;
}
