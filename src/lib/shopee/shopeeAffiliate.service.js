// Conversão de URLs da Shopee em links de afiliado (shortlink) do dono da margem.
//
// Espelha `src/lib/mercadoLivre/mlAffiliate.service.js`, mas o mecanismo é
// diferente: a Shopee usa a Open API GraphQL de afiliados, autenticada por uma
// assinatura SHA256 de `appId + timestamp + payload + appSecret` (não cookie de
// sessão + CSRF como o Mercado Livre).
//
// As credenciais entram SEMPRE por parâmetro (`{ appId, appSecret }`). Hoje elas
// vêm de variáveis de ambiente globais lidas no manager; quando migrarmos para
// uma tabela por margem, só muda quem passa o objeto — esta lib não muda.

import crypto from "node:crypto";

// Hosts aceitos: o domínio da loja e os encurtadores. Domínio exato ou
// subdomínio — nunca `includes` (deixaria passar `shopee.com.br.atacante.com`
// ou um host interno via `#shopee.com.br`).
const ALLOWED_HOSTS = [
  "shopee.com.br",
  "s.shopee.com.br",
  "shope.ee",
  ...(process.env.SHOPEE_SHORTLINK_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
];

// Encurtadores que precisam ser resolvidos até a URL final do produto.
const SHORTLINK_HOSTS = ["s.shopee.com.br", "shope.ee"];

const GRAPHQL_ENDPOINT =
  process.env.SHOPEE_GRAPHQL_ENDPOINT ||
  "https://open-api.affiliate.shopee.com.br/graphql";

export const USER_AGENT =
  process.env.SHOPEE_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = Number(process.env.SHOPEE_REQUEST_TIMEOUT || 15000);
const MAX_REDIRECTS = 10;

export const SHOPEE_ERROR = {
  INVALID_URL: "invalid_url",
  MISSING_CREDENTIALS: "missing_credentials",
  NOT_IN_PROGRAM: "not_in_program",
  RATE_LIMITED: "rate_limited",
  TEMPORARY: "temporary",
  NO_SHORT_LINK: "no_short_link",
};

// Aceita apenas http/https e hosts da Shopee (domínio exato ou subdomínio).
export function parseShopeeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return null;

  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const host = url.hostname.toLowerCase();
  const allowed = ALLOWED_HOSTS.some(
    (base) => host === base || host.endsWith(`.${base}`),
  );

  return allowed ? url : null;
}

export function isShopeeUrl(rawUrl) {
  return parseShopeeUrl(rawUrl) !== null;
}

function isShortlink(url) {
  const host = url.hostname.toLowerCase();
  return SHORTLINK_HOSTS.some(
    (base) => host === base || host.endsWith(`.${base}`),
  );
}

export async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Segue os redirects MANUALMENTE, revalidando o host a cada salto. O
// `s.shopee.com.br` costuma devolver uma página intermediária com UA padrão, daí
// a UA de browser. Seguir automaticamente sairia sem validar host nenhum.
export async function resolveShortLink(rawUrl) {
  const start = parseShopeeUrl(rawUrl);
  if (!start) return null;
  if (!isShortlink(start)) return start.toString();

  let current = start;

  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    const response = await fetchWithTimeout(current.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": USER_AGENT, accept: "text/html,*/*" },
    });

    const location = response.headers.get("location");
    if (!location) return current.toString();

    const next = parseShopeeUrl(new URL(location, current).toString());
    if (!next) {
      throw Object.assign(new Error("Redirect para host não permitido"), {
        shopeeError: SHOPEE_ERROR.INVALID_URL,
      });
    }
    current = next;
  }

  throw Object.assign(new Error("Excesso de redirects"), {
    shopeeError: SHOPEE_ERROR.TEMPORARY,
  });
}

// Formatos de URL de produto da Shopee:
//   /product/{shopId}/{itemId}
//   /nome-do-produto-i.{shopId}.{itemId}
//   /{prefixo}/{shopId}/{itemId}  (ex.: /opaanlp/... — destino dos shortlinks de afiliado)
export function extractIds(rawUrl) {
  let path;
  try {
    path = new URL(rawUrl).pathname;
  } catch {
    return null;
  }

  const byItem = path.match(/-i\.(\d+)\.(\d+)/);
  if (byItem) return { shopId: byItem[1], itemId: byItem[2] };

  // Dois segmentos numéricos consecutivos = {shopId}/{itemId}. Cobre /product/
  // e os prefixos usados pelos redirects (/opaanlp/, /universal-link/, etc.).
  const byPath = path.match(/\/(\d{5,})\/(\d{5,})(?:[/?#]|$)/);
  if (byPath) return { shopId: byPath[1], itemId: byPath[2] };

  return null;
}

// URL canônica do produto, sem nenhum parâmetro de tracking do afiliado original
// (utm_*, gads_t_sig, uls_trackid, mmp_pid, exp_group...).
export function canonicalUrl({ shopId, itemId }) {
  return `https://shopee.com.br/product/${shopId}/${itemId}`;
}

// Parâmetros de atribuição/tracking de afiliado de terceiro. Removidos de links
// que NÃO são de produto (cupom, campanha, loja) antes de reencurtar no ID da
// margem — para produto usamos canonicalUrl, que já dropa tudo.
const TRACKING_PARAMS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
  "utm_id", "mmp_pid", "uls_trackid", "gads_t_sig", "exp_group", "__mobile__",
  "af_siteid", "af_sub_siteid", "af_channel", "pid", "is_retargeting",
  "af_click_lookback", "af_viewthrough_lookback", "deep_link_value", "smtt",
];

function stripTrackingParams(rawUrl) {
  try {
    const u = new URL(rawUrl);
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
    return u.searchParams.toString()
      ? u.toString()
      : `${u.origin}${u.pathname}`;
  } catch {
    return rawUrl;
  }
}

// Assinatura da Open API: SHA256 de appId + timestamp(segundos) + payload + secret.
// `payload` precisa ser byte a byte o mesmo string que vai no body.
function sign(appId, appSecret, payload, timestamp) {
  return crypto
    .createHash("sha256")
    .update(appId + timestamp + payload + appSecret)
    .digest("hex");
}

function classifyStatus(status) {
  // 401/403 aqui = assinatura/credencial rejeitada (problema de config global).
  if (status === 401 || status === 403) return SHOPEE_ERROR.MISSING_CREDENTIALS;
  if (status === 429) return SHOPEE_ERROR.RATE_LIMITED;
  if (status >= 500) return SHOPEE_ERROR.TEMPORARY;
  return null;
}

// Mapeia a mensagem de erro do GraphQL para o nosso enum. "Produto fora do
// programa" NÃO cai aqui — isso é detectado explicitamente via productOfferV2
// (nodes vazio). Aqui ficam só erros de credencial / rate limit / transitórios.
function classifyGraphqlError(message) {
  const m = (message || "").toLowerCase();
  if (/rate.?limit|too many requests/.test(m)) return SHOPEE_ERROR.RATE_LIMITED;
  if (/invalid.*signature|unauthorized|invalid.*credential|invalid.*app|auth/.test(m)) {
    return SHOPEE_ERROR.MISSING_CREDENTIALS;
  }
  return SHOPEE_ERROR.TEMPORARY;
}

async function callGraphql(query, { appId, appSecret }) {
  // O payload assinado precisa ser idêntico ao body enviado.
  const payload = JSON.stringify({ query });
  const timestamp = Math.floor(Date.now() / 1000); // segundos, não ms

  const response = await fetchWithTimeout(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": USER_AGENT,
      Authorization: `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${sign(
        appId,
        appSecret,
        payload,
        timestamp,
      )}`,
    },
    body: payload,
  });

  if (!response.ok) {
    throw Object.assign(new Error(`Shopee respondeu ${response.status}`), {
      shopeeError: classifyStatus(response.status) || SHOPEE_ERROR.TEMPORARY,
      status: response.status,
    });
  }

  const json = await response.json().catch(() => null);

  if (json?.errors?.length) {
    const message = json.errors[0]?.message || "erro desconhecido";
    throw Object.assign(new Error(`Shopee API: ${message}`), {
      shopeeError: classifyGraphqlError(message),
    });
  }

  return json?.data;
}

// A Shopee só aceita subId ALFANUMÉRICO (hífen/underscore/espaço são rejeitados
// com "invalid sub id"), máx. 50 chars.
function sanitizeSubId(value) {
  return String(value || "")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 50);
}

/**
 * Gera o shortlink de afiliado a partir da URL canônica do produto.
 * `subIds`: até 5 rótulos livres que voltam no relatório de conversão. Entradas
 * que ficam vazias após a sanitização são descartadas.
 */
export async function generateShortLink(originUrl, credentials, subIds = []) {
  const slots = subIds.map(sanitizeSubId).filter(Boolean).slice(0, 5);
  const subIdsField = slots.length ? `,subIds:${JSON.stringify(slots)}` : "";
  const query = `mutation{generateShortLink(input:{originUrl:"${originUrl}"${subIdsField}}){shortLink}}`;

  const data = await callGraphql(query, credentials);
  const shortLink = data?.generateShortLink?.shortLink;

  if (!shortLink) {
    throw Object.assign(new Error("Resposta da Shopee sem shortLink"), {
      shopeeError: SHOPEE_ERROR.NO_SHORT_LINK,
    });
  }

  return shortLink;
}

/**
 * Consulta o produto no programa de afiliados. `generateShortLink` encurta
 * QUALQUER URL sem validar elegibilidade, então a checagem de "produto dentro do
 * programa" é feita aqui: `productOfferV2` devolve 1 nó para produto elegível e
 * `nodes: []` para produto fora do programa (ou inexistente).
 *
 * @returns {Promise<object | null>} o nó da oferta, ou null se fora do programa
 */
export async function fetchProductOffer({ shopId, itemId }, credentials) {
  // shopId/itemId são só dígitos (vêm de extractIds) → seguros como literais.
  const query = `{productOfferV2(shopId:${shopId},itemId:${itemId}){nodes{itemId shopId productName productLink offerLink commissionRate imageUrl}}}`;
  const data = await callGraphql(query, credentials);
  return data?.productOfferV2?.nodes?.[0] || null;
}

function isRetryable(errorType) {
  return (
    errorType === SHOPEE_ERROR.RATE_LIMITED ||
    errorType === SHOPEE_ERROR.TEMPORARY
  );
}

async function withRetry(fn, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      // Falha de rede vem sem `shopeeError` — tratamos como temporária.
      const type = error.shopeeError || SHOPEE_ERROR.TEMPORARY;
      if (!isRetryable(type) || attempt === retries) throw error;

      const delay = 700 * 2 ** attempt * (0.7 + Math.random() * 0.6);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Converte uma URL da Shopee (curta ou completa, com ou sem tracking de terceiro)
 * no shortlink de afiliado do dono da margem.
 * Nunca lança: devolve o erro classificado para o chamador decidir o que fazer.
 *
 * @returns {Promise<{ affiliate: string|null, original: string, error: null | { type: string, status?: number, message?: string } }>}
 */
export async function convertToShopeeAffiliate(rawUrl, credentials, subIds = []) {
  if (!credentials?.appId || !credentials?.appSecret) {
    return {
      affiliate: null,
      original: rawUrl,
      error: { type: SHOPEE_ERROR.MISSING_CREDENTIALS },
    };
  }

  if (!parseShopeeUrl(rawUrl)) {
    return {
      affiliate: null,
      original: rawUrl,
      error: { type: SHOPEE_ERROR.INVALID_URL },
    };
  }

  try {
    const resolved = await withRetry(() => resolveShortLink(rawUrl));
    const ids = extractIds(resolved);

    // Link de PRODUTO: precisa estar no programa de afiliados (senão a margem
    // não ganha comissão — não faz sentido divulgar).
    if (ids) {
      const canonical = canonicalUrl(ids);

      const offer = await withRetry(() => fetchProductOffer(ids, credentials));
      if (!offer) {
        return {
          affiliate: null,
          original: canonical,
          error: { type: SHOPEE_ERROR.NOT_IN_PROGRAM },
        };
      }

      const affiliate = await withRetry(() =>
        generateShortLink(canonical, credentials, subIds),
      );
      return { affiliate, original: canonical, error: null };
    }

    // Link que NÃO é produto (cupom, campanha, loja, vitrine): encurta direto
    // no ID da margem, sem checar elegibilidade — não há produto a validar.
    // É o que faz uma promo com "link de cupom + link do produto" funcionar.
    const cleanUrl = stripTrackingParams(resolved);
    const affiliate = await withRetry(() =>
      generateShortLink(cleanUrl, credentials, subIds),
    );
    return { affiliate, original: cleanUrl, error: null };
  } catch (error) {
    return {
      affiliate: null,
      original: rawUrl,
      error: {
        type: error.shopeeError || SHOPEE_ERROR.TEMPORARY,
        status: error.status,
        message: error.message,
      },
    };
  }
}
