// Detecta links da Shopee no texto de uma promoção e troca cada um pelo shortlink
// de afiliado do dono da margem.
//
// Contrato usado pelo manager: se `hadShopee` for false, a promoção não tem link
// da Shopee (ou o recurso está desligado) e deve seguir o fluxo normal. Se
// `failed` vier preenchido, NENHUM envio deve acontecer — divulgar o link
// original entregaria a venda sem a tag de afiliado.
//
// Espelha `src/lib/mercadoLivre/linkReplacer.js`, sem a parte de agregador:
// promoções da Shopee chegam como link direto ou encurtado (s.shopee.com.br).

import {
  convertToShopeeAffiliate,
  isShopeeUrl,
} from "./shopeeAffiliate.service.js";

const URL_REGEX = /https?:\/\/[^\s<>"')\]}]+/gi;

// A mesma promo é enviada para vários grupos/pastas e o mesmo link se repete ao
// longo do dia. O cache evita bater na Open API à toa (rate limit por app).
const CACHE_TTL_MS = Number(
  process.env.SHOPEE_CACHE_TTL_MS || 6 * 60 * 60 * 1000,
);
const cache = new Map();

function cacheKey(scope, url) {
  return `${scope}:${url}`;
}

function getCached(scope, url) {
  const entry = cache.get(cacheKey(scope, url));
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    cache.delete(cacheKey(scope, url));
    return null;
  }

  return { affiliate: entry.affiliate };
}

function setCached(scope, url, affiliate) {
  cache.set(cacheKey(scope, url), {
    affiliate,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

// URLs em texto corrido costumam vir grudadas em pontuação final.
function trimTrailingPunctuation(url) {
  return url.replace(/[.,;:!?]+$/, "");
}

export function extractShopeeUrls(text) {
  if (!text) return [];

  const found = (text.match(URL_REGEX) || [])
    .map(trimTrailingPunctuation)
    .filter(isShopeeUrl);

  return [...new Set(found)];
}

/**
 * Troca os links da Shopee presentes no texto pelos shortlinks de afiliado.
 *
 * `credentials` = { appId, appSecret }. Sem credenciais utilizáveis, a função é
 * no-op (`hadShopee: false`) — o recurso fica dormente até o `.env` ser
 * preenchido, sem bloquear nenhum envio.
 *
 * @returns {Promise<{ text: string, hadShopee: boolean, imageUrl: null, failed: null | { type: string, url: string } }>}
 */
export async function convertShopeeMessageText(text, credentials, cacheScope) {
  const urls = extractShopeeUrls(text);

  if (urls.length === 0) {
    return { text, hadShopee: false, imageUrl: null, failed: null };
  }

  if (!credentials?.appId || !credentials?.appSecret) {
    // Recurso desligado (sem credenciais globais): não é "falha", só não converte.
    return { text, hadShopee: false, imageUrl: null, failed: null };
  }

  let converted = text;

  for (const url of urls) {
    const cached = getCached(cacheScope, url);
    if (cached) {
      converted = converted.replaceAll(url, cached.affiliate);
      continue;
    }

    const result = await convertToShopeeAffiliate(url, credentials, [cacheScope]);

    if (!result.affiliate) {
      return {
        text,
        hadShopee: true,
        imageUrl: null,
        failed: { type: result.error.type, url },
      };
    }

    setCached(cacheScope, url, result.affiliate);
    converted = converted.replaceAll(url, result.affiliate);
  }

  return { text: converted, hadShopee: true, imageUrl: null, failed: null };
}
