import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  extractImageThumb,
  generateWAMessageFromContent,
  prepareWAMessageMedia,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import path from "path";
import fs from "fs";
import P from "pino";
import TelegramBot from "node-telegram-bot-api";
import { db } from "./db/index.js";
import { sessions as dbSessions, mlCredentials } from "./db/schema.js";
import { eq } from "drizzle-orm";
import { convertMessageText } from "./lib/mercadoLivre/linkReplacer.js";
import {
  ML_ERROR,
  USER_AGENT,
  fetchWithTimeout,
} from "./lib/mercadoLivre/mlAffiliate.service.js";
import {
  convertShopeeMessageText,
  extractShopeeUrls,
} from "./lib/shopee/shopeeLinkReplacer.js";
import { SHOPEE_ERROR } from "./lib/shopee/shopeeAffiliate.service.js";

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

// ---------------------------------------------------------------------------
// Convite de grupo da margem
// ---------------------------------------------------------------------------

// Só mensagens com texto/legenda podem receber o convite (áudio/figurinha não).
function messageSupportsCaption(message) {
  const content = message.message || {};
  return !!(
    content.conversation ||
    content.extendedTextMessage ||
    content.imageMessage ||
    content.videoMessage ||
    content.documentMessage
  );
}

// A promo já mostra alguma imagem? Conta tanto mídia de verdade quanto o
// thumbnail de um link preview. É o que decide se vale buscar a imagem do
// produto na página do agregador — o visual que veio da origem tem prioridade.
function messageHasImage(message) {
  const content = message.message || {};
  if (content.imageMessage) return true;

  const preview = content.extendedTextMessage;
  return !!(preview?.jpegThumbnail || preview?.thumbnailDirectPath);
}

// Hosts de convite de grupo conhecidos (WhatsApp/Telegram).
const INVITE_HOSTS_REGEX = /(?:chat\.whatsapp\.com|t\.me|telegram\.me)/i;
// Linha que convida/leva para um grupo (marcador). Pega também domínios
// personalizados (ex.: sosfitnes.com/convite-para-o-grupo/), que não têm host
// conhecido, quando vêm precedidos por essa chamada.
const GROUP_MARKER_REGEX =
  /(?:convide|convites?|entre|entrar|participe|acesse|junte-?se|receba)[^\n]*grupo/i;
// Linha que "parece" uma URL/domínio (com ou sem http).
const URLISH_LINE_REGEX =
  /^\s*(?:https?:\/\/\S+|(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?)\s*$/i;

// Remove um convite de grupo já presente na mensagem: linha-marcador de grupo
// (+ a URL na linha seguinte, se houver) e linhas com URL de host conhecido.
function removeExistingGroupInvite(text) {
  const lines = text.split("\n");
  const keep = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (GROUP_MARKER_REGEX.test(line)) {
      // Se a próxima linha for a URL do convite, descarta as duas.
      if (i + 1 < lines.length && URLISH_LINE_REGEX.test(lines[i + 1])) {
        i++;
      }
      continue;
    }

    if (INVITE_HOSTS_REGEX.test(line)) continue;

    keep.push(line);
  }

  return keep.join("\n");
}

// Garante o convite do dono no final da mensagem, substituindo um convite que já
// venha na promo. Formato fixo: "Convide amigos para o grupo:\n<link>".
function applyGroupInvite(text, inviteLink) {
  const base = removeExistingGroupInvite(text || "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();

  const block = `Convide amigos para o grupo:\n${inviteLink}`;
  return base ? `${base}\n\n${block}` : block;
}

// ---------------------------------------------------------------------------
// Limpeza de referrals do criador da promo (ex.: "Salve um amigo")
// ---------------------------------------------------------------------------

// Chamada de "indique/salve um amigo" (referral do agregador).
const SAVE_FRIEND_MARKER = /salve\s+(?:um|seu)\s+amigo/i;
// Subdomínio de referral do salvouofertas (ex.: whatsapp.salvouofertas.com). Não
// casa com o domínio nu (salvouofertas.com/p/...), que é o link do produto.
const REFERRAL_HOST_REGEX = /[a-z0-9-]+\.salvouofertas\.com/i;

// Remove os referrals do criador da promo (não é o convite de grupo): a linha
// "Salve um amigo" (+ a URL seguinte) e linhas com URL de host de referral.
// Sempre aplicada — o produto (salvouofertas.com/p/...) é preservado.
function cleanSourceReferrals(text) {
  const lines = (text || "").split("\n");
  const keep = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (SAVE_FRIEND_MARKER.test(line)) {
      if (i + 1 < lines.length && URLISH_LINE_REGEX.test(lines[i + 1])) i++;
      continue;
    }

    if (REFERRAL_HOST_REGEX.test(line)) continue;

    keep.push(line);
  }

  return keep.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
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

// Teto do download da imagem do produto. Thumbnail de link é pequeno; o limite
// existe só para uma URL hostil não conseguir estourar a memória do processo.
const MAX_IMAGEM_BYTES = 5 * 1024 * 1024;

/**
 * Baixa a imagem do produto (descoberta na página do agregador) para virar
 * thumbnail do preview. O host já foi validado contra a allowlist no
 * `parseImageUrl`; aqui só sobram as guardas de conteúdo e tamanho.
 *
 * Devolve `null` em qualquer falha — nunca lança. A imagem é enfeite: uma promo
 * que já converteu o link não pode deixar de ser enviada por causa disso.
 */
async function baixarImagemDoProduto(url) {
  try {
    const response = await fetchWithTimeout(url, {
      headers: { "user-agent": USER_AGENT, accept: "image/*" },
    });

    if (!response.ok) {
      console.warn(`⚠️ Imagem do produto respondeu ${response.status}: ${url}`);
      return null;
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) {
      console.warn(`⚠️ Imagem do produto não é imagem (${contentType}): ${url}`);
      return null;
    }

    const declarado = Number(response.headers.get("content-length"));
    if (declarado > MAX_IMAGEM_BYTES) {
      console.warn(`⚠️ Imagem do produto grande demais (${declarado} bytes): ${url}`);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    // O content-length é opcional e pode mentir: confere o tamanho real também.
    if (!buffer.length || buffer.length > MAX_IMAGEM_BYTES) {
      console.warn(`⚠️ Imagem do produto com tamanho inválido (${buffer.length} bytes)`);
      return null;
    }

    return buffer;
  } catch (error) {
    console.warn(`⚠️ Falha ao baixar a imagem do produto: ${error.message}`);
    return null;
  }
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

// `captionOverride` é usado quando a promoção teve links do Mercado Livre
// convertidos: sem ele, o Telegram sairia com o link original, sem afiliado.
async function createTelegramPayload(sock, message, fallbackText, captionOverride) {
  const caption = captionOverride ?? getMessageCaption(message);
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

// ---------------------------------------------------------------------------
// Mercado Livre: conversão de links de afiliado
// ---------------------------------------------------------------------------

// O manager é chaveado pelo NOME da sessão; o id serial (chave das credenciais)
// só existe no banco. Cacheamos o mapeamento nome -> id para não consultar toda
// promoção.
const sessionRowIds = new Map(); // sessionName -> sessions.id
const credentialAlerts = new Map(); // sessionId -> timestamp do último aviso

const CREDENTIAL_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

async function getSessionRowId(sessionName) {
  if (sessionRowIds.has(sessionName)) return sessionRowIds.get(sessionName);

  const [row] = await db
    .select({ id: dbSessions.id })
    .from(dbSessions)
    .where(eq(dbSessions.sessionId, sessionName));

  const id = row?.id ?? null;
  sessionRowIds.set(sessionName, id);
  return id;
}

// Credenciais do Mercado Livre DA MARGEM (não mais do usuário). São buscadas
// frescas a cada chamada, então cadastrar credenciais passa a valer na hora.
async function getSessionMlCredentials(sessionName) {
  const sessionRowId = await getSessionRowId(sessionName);
  if (!sessionRowId) return null;

  const [row] = await db
    .select()
    .from(mlCredentials)
    .where(eq(mlCredentials.sessionId, sessionRowId));

  // Sem tag ou sem cookie, a margem simplesmente não converte.
  if (!row?.mlAffiliateTag || !row?.cookieString) return null;

  return { credentials: row };
}

// Indica se a margem já tem credenciais do Mercado Livre cadastradas.
// Margens nessa condição enviam na hora (ignoram a regra de tempo).
async function sessionHasMlCredentials(sessionName) {
  return (await getSessionMlCredentials(sessionName)) !== null;
}

// Credenciais da Shopee. Hoje GLOBAIS (variáveis de ambiente). Enquanto
// SHOPEE_APP_ID/SHOPEE_SECRET não estiverem no .env, a conversão da Shopee é
// no-op total. Quando migrar para tabela por margem, trocar só o corpo desta
// função por uma consulta espelhando getSessionMlCredentials.
function getShopeeCredentials(/* sessionName */) {
  const appId = process.env.SHOPEE_APP_ID?.trim();
  const appSecret = process.env.SHOPEE_SECRET?.trim();
  if (!appId || !appSecret) return null;
  return { appId, appSecret };
}

// O JID do próprio bot vem como "5511999999999:12@s.whatsapp.net" — o sufixo de
// device (":12") precisa sair, senão o envio falha.
function getOwnJid(sock) {
  const rawId = sock?.user?.id;
  if (!rawId) return null;
  return rawId.replace(/:\d+(?=@)/, "");
}

// Avisa o dono no próprio chip. Com cooldown: 30 promoções falhando em sequência
// não podem virar 30 mensagens no WhatsApp dele.
async function notifyCredentialsExpired(sock, sessionId, errorType) {
  const lastAlert = credentialAlerts.get(sessionId) || 0;
  if (Date.now() - lastAlert < CREDENTIAL_ALERT_COOLDOWN_MS) return;

  const jid = getOwnJid(sock);
  if (!jid) return;

  const detail =
    errorType === ML_ERROR.CREDENTIALS_EXPIRED
      ? "Suas credenciais do Mercado Livre expiraram."
      : "Não consegui converter o link do Mercado Livre.";

  const text =
    `⚠️ *Conversão do Mercado Livre falhou*\n\n${detail}\n\n` +
    `As promoções do Mercado Livre *não estão sendo enviadas* para os grupos, ` +
    `para não divulgar link sem a sua tag de afiliado.\n\n` +
    `Atualize o cookie e o CSRF token no painel para voltar a converter os links.`;

  try {
    await sock.sendMessage(jid, { text });
    credentialAlerts.set(sessionId, Date.now());
    console.log(`[${sessionId}] 📨 Aviso de credencial enviado ao dono (${jid}).`);
  } catch (error) {
    console.error(`[${sessionId}] ❌ Falha ao avisar o dono: ${error.message}`);
  }
}

// Título do card de preview. Não dá para omitir nem mandar string vazia: sem
// título com conteúdo o WhatsApp não desenha o card e a promo sai como texto
// puro (a imagem vai junto, mas só aparece no thumbnail da citação) — os dois
// casos foram testados em grupo.
//
// Como o formato desejado é só o banner + o domínio, sem bloco de texto no
// card, o título é um espaço de largura zero: satisfaz o "não vazio" sem
// desenhar nada. A descrição fica de fora pelo mesmo motivo.
const TITULO_INVISIVEL = "​";

/**
 * Sobe uma imagem como thumbnail de link e devolve o `imageMessage` do Baileys.
 *
 * `mediaTypeOverride: "thumbnail-link"` faz o upload devolver o thumbnail de
 * alta qualidade (directPath + mediaKey + sha) além do `jpegThumbnail` inline
 * reduzido, sem que a gente precise redimensionar nada aqui. É esse thumbnail
 * de alta qualidade que faz o preview renderizar grande em vez de virar uma
 * miniatura ao lado do texto.
 */
async function subirThumbnailDeLink(sock, buffer) {
  const { imageMessage } = await prepareWAMessageMedia(
    { image: buffer },
    {
      upload: sock.waUploadToServer,
      mediaTypeOverride: "thumbnail-link",
      // O Baileys gera o jpegThumbnail dentro de um try/catch que só reporta via
      // `logger?.warn`. Sem logger a falha é ENGOLIDA: o upload conclui, mas o
      // preview sai sem o thumbnail inline e o card renderiza vazio. Passar o
      // logger é o que torna esse modo de falha visível.
      logger: P({ level: "warn" }),
    },
  );

  return imageMessage;
}

// Os mesmos dados do thumbnail, mas no formato cru do `extendedTextMessage` —
// é o mapeamento que o `generateWAMessageContent` do Baileys faz internamente
// a partir do `highQualityThumbnail`.
async function camposDePreviewDeImagem(sock, buffer) {
  const imageMessage = await subirThumbnailDeLink(sock, buffer);
  if (!imageMessage) return null;

  let jpegThumbnail = imageMessage.jpegThumbnail
    ? Buffer.from(imageMessage.jpegThumbnail)
    : undefined;
  let largura = imageMessage.width;
  let altura = imageMessage.height;

  // O card só renderiza a imagem com o jpegThumbnail INLINE; o thumbnail de alta
  // qualidade sozinho não basta — sem ele o preview sai como uma faixa só com o
  // domínio. Como a geração dentro do Baileys é best-effort (e falha em
  // silêncio), refazemos aqui em vez de mandar um card vazio.
  if (!jpegThumbnail) {
    try {
      const { buffer: thumb, original } = await extractImageThumb(buffer);
      jpegThumbnail = thumb;
      largura = largura || original?.width;
      altura = altura || original?.height;
      console.log("ℹ️  jpegThumbnail gerado localmente (o Baileys não devolveu).");
    } catch (error) {
      console.warn(
        `⚠️ Não foi possível gerar o jpegThumbnail (${error.message}) — o card vai sair sem imagem.`,
      );
    }
  }

  return {
    jpegThumbnail,
    thumbnailDirectPath: imageMessage.directPath,
    thumbnailSha256: imageMessage.fileSha256,
    thumbnailEncSha256: imageMessage.fileEncSha256,
    mediaKey: imageMessage.mediaKey,
    mediaKeyTimestamp: imageMessage.mediaKeyTimestamp,
    thumbnailWidth: largura,
    thumbnailHeight: altura,
  };
}

// Monta o `__rawContent` de uma promo como texto + card de preview, usando o
// buffer recebido como thumbnail. Devolve `null` quando não dá para montar
// (sem URL para ancorar ou falha no upload), para o chamador cair no formato
// original em vez de deixar a promo sem imagem.
async function payloadComPreview(sock, buffer, caption, url, previewOriginal) {
  if (!buffer || !url) return null;

  try {
    const campos = await camposDePreviewDeImagem(sock, buffer);
    if (!campos) return null;

    return {
      __rawContent: {
        extendedTextMessage: {
          text: caption,
          matchedText: url,
          canonicalUrl: url,
          // Sem título com conteúdo o WhatsApp não desenha o card.
          title: previewOriginal?.title || TITULO_INVISIVEL,
          previewType: 0,
          ...campos,
        },
      },
    };
  } catch (error) {
    console.warn(`⚠️ Falha ao montar o preview da promo: ${error.message}`);
    return null;
  }
}

// Espelha o createTelegramPayload, mas para reenviar no WhatsApp. Só é usado
// quando o texto muda (promo do ML), porque o forward nativo não permite editar
// o conteúdo da mensagem.
//
// `imagemDoProduto` (Buffer ou null) é a imagem do produto tirada da página do
// agregador. Ela é o ÚLTIMO recurso: a imagem que já veio na mensagem tem
// prioridade, e a do site só entra quando a promo chega sem imagem nenhuma.
async function buildWhatsAppPayload(sock, message, caption, imagemDoProduto = null) {
  const content = message.message || {};
  const url = (caption.match(/https?:\/\/[^\s<>"')\]}]+/i) || [])[0];

  // Vídeo e documento seguem no formato original — não faz sentido virarem card.
  if (content.videoMessage) {
    return { video: await downloadWhatsAppMedia(sock, message), caption };
  }

  if (content.documentMessage) {
    return {
      document: await downloadWhatsAppMedia(sock, message),
      caption,
      fileName: content.documentMessage.fileName || "arquivo",
      mimetype: content.documentMessage.mimetype,
    };
  }

  // 1º) FOTO com legenda: vira card usando a PRÓPRIA foto da mensagem. Numa foto
  // anexada o toque na imagem não abre nada; no card ele abre o link de afiliado.
  // Sem link para ancorar (ou se o upload falhar), volta a ser foto com legenda.
  if (content.imageMessage) {
    const foto = await downloadWhatsAppMedia(sock, message);
    return (
      (await payloadComPreview(sock, foto, caption, url)) || {
        image: foto,
        caption,
      }
    );
  }

  // 2º) Promoções que chegam como texto COM link preview (a imagem grande + o
  // card "meli.la" são o preview do link, não um imageMessage). O fallback de
  // texto puro descartaria o preview. Preservamos TODOS os campos do preview
  // original (inclusive o thumbnail de alta qualidade: thumbnailDirectPath +
  // mediaKey + sha, que é o que faz o preview renderizar GRANDE) e só trocamos o
  // texto e a URL destacada pela versão de afiliado. contextInfo é removido para
  // não arrastar citação/encaminhamento do grupo de origem. Sinalizado com
  // __rawContent porque precisa ir como mensagem crua (relayMessage).
  const preview = content.extendedTextMessage;
  if (preview && messageHasImage(message)) {
    const { contextInfo, ...previewFields } = preview;
    return {
      __rawContent: {
        extendedTextMessage: {
          ...previewFields,
          text: caption,
          matchedText: url || preview.matchedText,
          canonicalUrl: url || preview.canonicalUrl,
        },
      },
    };
  }

  // 3º) Nada de imagem na mensagem (texto puro, ou preview só com título): aí
  // sim entra a imagem tirada da página do agregador.
  const comImagemDoProduto = await payloadComPreview(
    sock,
    imagemDoProduto,
    caption,
    url,
    preview,
  );
  if (comImagemDoProduto) return comImagemDoProduto;

  // 4º) Sem imagem alguma, mas com card de texto na origem: mantém o card.
  if (preview?.title) {
    const { contextInfo, ...previewFields } = preview;
    return {
      __rawContent: {
        extendedTextMessage: {
          ...previewFields,
          text: caption,
          matchedText: url || preview.matchedText,
          canonicalUrl: url || preview.canonicalUrl,
        },
      },
    };
  }

  // Áudio e figurinha não têm texto para converter — não deveriam chegar aqui.
  return { text: caption };
}

/**
 * Decide o que fazer com uma promoção antes de repassá-la.
 *
 * @returns {Promise<{ action: "forward" } | { action: "rebuild", caption: string, imageUrl: string | null } | { action: "block", errorType: string }>}
 *   - forward: não é do Mercado Livre (ou o dono não usa o recurso) → fluxo normal, intacto.
 *   - rebuild: links convertidos → a mensagem precisa ser remontada com o novo texto.
 *              `imageUrl` é a imagem do produto achada na página do agregador
 *              (só links de agregador têm; `null` no resto).
 *   - block:   conversão falhou → não enviar e avisar o dono.
 */
async function resolveMercadoLivreConversion(sessionId, message) {
  const caption = getMessageCaption(message);
  if (!caption) return { action: "forward" };

  let owner;
  try {
    owner = await getSessionMlCredentials(sessionId);
  } catch (error) {
    console.error(`[${sessionId}] ❌ Erro ao buscar credenciais ML: ${error.message}`);
    return { action: "forward" };
  }

  // Margem sem credenciais cadastradas continua recebendo as promoções como sempre.
  if (!owner) return { action: "forward" };

  // Cache de conversão por MARGEM (tags diferentes por margem não compartilham cache).
  const result = await convertMessageText(caption, owner.credentials, sessionId);

  if (!result.hadMl) return { action: "forward" };

  if (result.failed) {
    console.warn(
      `[${sessionId}] 🛑 Conversão do ML falhou (${result.failed.type}) para ${result.failed.url}`,
    );
    return { action: "block", errorType: result.failed.type };
  }

  // Voltou a converter: zera o cooldown para que uma futura expiração avise de imediato.
  credentialAlerts.delete(sessionId);

  console.log(`[${sessionId}] 🔗 Link(s) do Mercado Livre convertido(s) para afiliado.`);
  return { action: "rebuild", caption: result.text, imageUrl: result.imageUrl };
}

/**
 * Decide o que fazer com os links da Shopee de uma promoção. Roda DEPOIS do
 * Mercado Livre, sobre o texto já convertido.
 *
 * @param {string} sessionId nome da margem
 * @param {string} text texto/legenda (já com os links do ML trocados, se houver)
 * @returns {Promise<{ action: "forward" } | { action: "rebuild", caption: string } | { action: "block", errorType: string }>}
 *   - forward: sem link da Shopee, ou recurso desligado (sem credenciais globais) → segue o fluxo.
 *   - rebuild: links convertidos → o texto mudou.
 *   - block:   conversão falhou (inclui "produto fora do programa") → não enviar.
 */
async function resolveShopeeConversion(sessionId, text) {
  const creds = getShopeeCredentials(sessionId);
  if (!creds) return { action: "forward" };

  if (!text) return { action: "forward" };

  const result = await convertShopeeMessageText(text, creds, sessionId);

  if (!result.hadShopee) return { action: "forward" };

  if (result.failed) {
    if (result.failed.type === SHOPEE_ERROR.NOT_IN_PROGRAM) {
      console.warn(
        `[${sessionId}] 🛑 Shopee: NÃO enviado — produto fora do programa de afiliados (${result.failed.url})`,
      );
    } else if (result.failed.type === SHOPEE_ERROR.MISSING_CREDENTIALS) {
      console.warn(
        `[${sessionId}] 🛑 Shopee: NÃO enviado — credenciais globais inválidas. Confira SHOPEE_APP_ID/SHOPEE_SECRET no .env (${result.failed.url})`,
      );
    } else {
      console.warn(
        `[${sessionId}] 🛑 Shopee: conversão falhou (${result.failed.type}) para ${result.failed.url}`,
      );
    }
    return { action: "block", errorType: result.failed.type };
  }

  console.log(`[${sessionId}] 🔗 Link(s) da Shopee convertido(s) para afiliado.`);
  return { action: "rebuild", caption: result.text };
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
          convertLink: dbSession.convertLink ?? false,
          groupInviteLink: dbSession.groupInviteLink ?? null,
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
      convertLink: false,
      groupInviteLink: null,
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

      // Enviam NA HORA (sem passar pela janela de throttling): margens com
      // credenciais do Mercado Livre cadastradas, e mensagens que trazem link da
      // Shopee para converter (conversão global ligada). As demais seguem a
      // regra de tempo (gap aleatório dentro da janela).
      const temShopeeParaConverter =
        getShopeeCredentials(sessionId) !== null &&
        extractShopeeUrls(text).length > 0;
      const sendNow =
        (await sessionHasMlCredentials(sessionId)) || temShopeeParaConverter;

      let nextTime;
      let delayMs;

      if (sendNow) {
        nextTime = now;
        delayMs = 0;
        console.log(
          `[${sessionId}] ⚡ Envio imediato (credenciais ML ou link da Shopee para converter) (ID: ${msg.key.id})`,
        );
      } else {
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

        nextTime = schedule.lastTime + gap;

        // Garante que não ultrapasse o fim da janela atual de 15 min (deixa margem de 1 min)
        const windowEnd = schedule.windowStart + WINDOW_MS - 60000;
        if (nextTime > windowEnd) {
          nextTime = windowEnd;
        }

        schedule.lastTime = nextTime;
        schedule.count++;
        sessionSchedules.set(sessionId, schedule);

        delayMs = nextTime - now;

        console.log(
          `[${sessionId}] ⏳ Aguardando ${(delayMs / 60000).toFixed(2)} minutos antes de encaminhar... (ID: ${msg.key.id})`,
        );
      }

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

        // Conversão de links:
        // - Mercado Livre: só quando a margem está em MODO CONVERSÃO
        //   (config.convertLink === true, derivado de ter credenciais ML).
        // - Shopee: sempre que a conversão global estiver ligada
        //   (SHOPEE_APP_ID/SHOPEE_SECRET no .env), INDEPENDENTE de convertLink.
        //
        // Em modo conversão, a mensagem sem nenhum link convertível é ignorada.
        // Fora do modo conversão, os links da Shopee são trocados e o resto da
        // mensagem segue normal. Se uma conversão falhar (ex.: produto fora do
        // programa), nada é enviado — para não divulgar oferta sem a tag.
        let outgoingText = text;
        let needsRebuild = false;
        let imagemDoProdutoUrl = null;

        const convertMode = currentConfig.convertLink === true;
        const shopeeEnabled = getShopeeCredentials(sessionId) !== null;

        if (convertMode || shopeeEnabled) {
          let workingText = getMessageCaption(frozenMsg);
          let hadMl = false;
          let hadShopee = false;

          if (convertMode) {
            const ml = await resolveMercadoLivreConversion(sessionId, frozenMsg);
            if (ml.action === "block") {
              console.log(
                `[${sessionId}] 🛑 Envio cancelado: promoção do Mercado Livre não convertida (ID: ${msg.key.id})`,
              );
              await notifyCredentialsExpired(currentSock, sessionId, ml.errorType);
              return;
            }
            hadMl = ml.action === "rebuild";
            if (hadMl) {
              workingText = ml.caption;
              imagemDoProdutoUrl = ml.imageUrl;
            }
          }

          if (shopeeEnabled) {
            const shp = await resolveShopeeConversion(sessionId, workingText);
            if (shp.action === "block") {
              // resolveShopeeConversion já registrou o motivo no log (inclui o
              // caso "produto fora do programa de afiliados").
              console.log(
                `[${sessionId}] 🛑 Envio cancelado: promoção da Shopee não convertida (ID: ${msg.key.id})`,
              );
              return;
            }
            hadShopee = shp.action === "rebuild";
            if (hadShopee) workingText = shp.caption;
          }

          // Modo conversão: só repassa promo que deu para converter.
          if (convertMode && !hadMl && !hadShopee) {
            console.log(
              `[${sessionId}] ⏭️ Mensagem sem link convertível (Mercado Livre/Shopee) ignorada (margem de conversão) (ID: ${msg.key.id})`,
            );
            return;
          }

          if (hadMl || hadShopee) {
            outgoingText = workingText;
            needsRebuild = true;
          }
        }

        // Referrals do criador da promo (ex.: "Salve um amigo") são removidos
        // SEMPRE, em qualquer margem, quando a mensagem tem texto/legenda. Só
        // remonta quando de fato há algo para remover.
        if (messageSupportsCaption(frozenMsg)) {
          const cleaned = cleanSourceReferrals(outgoingText);
          if (cleaned !== outgoingText) {
            outgoingText = cleaned;
            needsRebuild = true;
          }
        }

        // Convite de grupo da margem: garante o convite do dono no final (substitui
        // um convite que já venha na promo). Só em mensagens com texto/legenda —
        // áudio/figurinha seguem por forward nativo, sem convite.
        if (currentConfig.groupInviteLink && messageSupportsCaption(frozenMsg)) {
          const withInvite = applyGroupInvite(outgoingText, currentConfig.groupInviteLink);
          if (withInvite !== outgoingText) {
            outgoingText = withInvite;
            needsRebuild = true;
          }
        }

        // Imagem do produto tirada da página do agregador. Só é baixada quando a
        // promo chega SEM imagem — a que veio na mensagem tem prioridade, então
        // no caso comum nem há requisição. Uma vez só, fora do loop de destinos.
        const imagemDoProduto =
          imagemDoProdutoUrl && !messageHasImage(frozenMsg)
            ? await baixarImagemDoProduto(imagemDoProdutoUrl)
            : null;

        if (imagemDoProduto) {
          console.log(
            `[${sessionId}] 🖼️  Promo sem imagem: usando a do site (${imagemDoProdutoUrl}) no preview.`,
          );
          needsRebuild = true;
        }

        // Quando o texto muda (conversão e/ou convite), a mensagem é remontada.
        // A mídia é baixada uma única vez e reusada em todos os destinos.
        const rebuiltPayload = needsRebuild
          ? await buildWhatsAppPayload(
              currentSock,
              deepCloneMessage(frozenMsg),
              outgoingText,
              imagemDoProduto,
            )
          : null;

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

            if (rebuiltPayload?.__rawContent) {
              // Promo com link preview: enviada como mensagem CRUA para preservar
              // a imagem/preview (o sendMessage de texto puro não carrega o preview).
              const waMsg = generateWAMessageFromContent(
                target.id,
                rebuiltPayload.__rawContent,
                { userJid: getOwnJid(currentSock) || undefined },
              );
              await currentSock.relayMessage(target.id, waMsg.message, {
                messageId: waMsg.key.id,
              });
            } else if (rebuiltPayload) {
              // O forward do Baileys copia a mensagem byte a byte e não permite
              // editar o texto — por isso a promo do ML é remontada.
              await currentSock.sendMessage(target.id, rebuiltPayload);
            } else {
              // Clona a mensagem congelada para evitar que o Baileys a corrompa ao enviar para o próximo alvo do loop
              const targetMsgCopy = deepCloneMessage(frozenMsg);

              // Usa a funcionalidade nativa de forward do Baileys para repassar qualquer tipo de mensagem com perfeição
              await currentSock.sendMessage(target.id, { forward: targetMsgCopy });
            }

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
            console.log(`💬 Mensagem: "${outgoingText}"`);
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
                outgoingText,
                // Só sobrescreve a legenda quando a promo do ML foi remontada.
                rebuiltPayload ? outgoingText : undefined,
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
                console.log(`💬 Mensagem: "${outgoingText}"`);
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
      convertLink: false,
      groupInviteLink: null,
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
  sessionRowIds.delete(sessionId);
  credentialAlerts.delete(sessionId);

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

// ---------------------------------------------------------------------------
// Disparo manual de promoção (tela "Criar promoção")
// ---------------------------------------------------------------------------

function erroDeEnvio(mensagem, statusCode) {
  const erro = new Error(mensagem);
  erro.statusCode = statusCode;
  return erro;
}

// Converte a imagem vinda do front (data URL ou base64 puro) em Buffer.
function imagemBase64ParaBuffer(imageBase64) {
  const conteudo = String(imageBase64 || "").replace(
    /^data:image\/[a-z0-9.+-]+;base64,/i,
    "",
  );
  const buffer = Buffer.from(conteudo, "base64");

  if (!buffer.length) {
    throw erroDeEnvio("Imagem inválida.", 400);
  }

  return buffer;
}

/**
 * Monta o `linkPreview` da promoção para o `sendMessage`: banner no topo, o
 * domínio logo abaixo e o texto completo na sequência. É o formato `WAUrlInfo`
 * que o Baileys espera — o repasse usa `camposDePreviewDeImagem`, que monta os
 * mesmos dados no formato cru do `extendedTextMessage`.
 */
async function montarLinkPreview(sock, buffer, url) {
  const imageMessage = await subirThumbnailDeLink(sock, buffer);

  return {
    "canonical-url": url,
    "matched-text": url,
    title: TITULO_INVISIVEL,
    jpegThumbnail: imageMessage?.jpegThumbnail
      ? Buffer.from(imageMessage.jpegThumbnail)
      : undefined,
    highQualityThumbnail: imageMessage || undefined,
  };
}

/**
 * Publica uma promoção montada pelo usuário no **grupo de envio** (origem) da
 * margem. Não envia direto para os grupos de destino de propósito: ao cair no
 * grupo de origem, a promo entra no fluxo normal do bot (`messages.upsert`,
 * logo abaixo do `sock.sendMessage` porque `emitOwnEvents` é true por padrão) e
 * é repassada com todo o tratamento de sempre — conversão de link do Mercado
 * Livre, convite de grupo, agendamento/limite de envio e espelho no Telegram.
 *
 * A imagem vai como **preview do link** do produto, não como `imageMessage`.
 */
export async function sendPromoMessage(sessionId, { imageBase64, caption }) {
  // O preview se ancora numa URL que exista no texto — é o link do produto.
  const url = (caption.match(/https?:\/\/[^\s<>"')\]}]+/i) || [])[0];
  if (!url) {
    throw erroDeEnvio(
      "A mensagem precisa conter um link (http:// ou https://) para a imagem virar preview.",
      400,
    );
  }

  const buffer = imagemBase64ParaBuffer(imageBase64);

  const sock = sessions.get(sessionId);
  if (!sock || sessionStatus.get(sessionId) !== "CONNECTED") {
    throw erroDeEnvio(
      "A margem não está conectada. Inicie a margem e leia o QR Code antes de enviar.",
      409,
    );
  }

  // O grupo é resolvido por prefixo quando a sessão conecta; se a config em
  // memória ainda não tem a origem (ex.: grupo criado depois), tenta de novo.
  let config = sessionConfigs.get(sessionId);
  if (!config?.sourceGroup) {
    await resolveGroupsByPrefix(sock, sessionId);
    config = sessionConfigs.get(sessionId);
  }

  if (!config?.sourceGroup) {
    throw erroDeEnvio(
      `Nenhum grupo de envio encontrado para o prefixo "${config?.sourceGroupPrefix || ""}".`,
      409,
    );
  }

  const destino = {
    id: config.sourceGroup,
    name: config.sourceGroupName || config.sourceGroupPrefix || "grupo de envio",
    canal: "whatsapp",
  };

  try {
    const linkPreview = await montarLinkPreview(sock, buffer, url);

    await simulateTyping(sock, destino.id, 1500 + Math.random() * 1500);
    // Via `sendMessage` (e não `relayMessage`) de propósito: só ele emite o
    // `messages.upsert` local, que é o que faz o fluxo normal do bot enxergar a
    // promo e repassá-la para os grupos de destino.
    await sock.sendMessage(destino.id, { text: caption, linkPreview });

    console.log("\n" + "=".repeat(60));
    console.log(`✅ [${sessionId}] PROMOÇÃO PUBLICADA NO GRUPO DE ENVIO`);
    console.log("=".repeat(60));
    console.log(`📤 Grupo: ${destino.name}`);
    console.log(`🆔 ID do Grupo: ${destino.id}`);
    console.log(`🔗 Preview ancorado em: ${url}`);
    console.log("ℹ️  O repasse para os destinos segue o fluxo normal do bot.");
    console.log("=".repeat(60) + "\n");

    return { sent: [destino], failed: [] };
  } catch (err) {
    const mensagem = err.message || String(err);
    console.error(
      `❌ [${sessionId}] Falha ao publicar promoção em ${destino.name}: ${mensagem}`,
    );

    if (mensagem.includes("Closed") || err.output?.statusCode === 428) {
      sessionStatus.set(sessionId, "DISCONNECTED");
    }

    return { sent: [], failed: [{ name: destino.name, error: mensagem }] };
  }
}
