// Detecta links do Mercado Livre no texto de uma promoção e troca cada um pelo
// link de afiliado do usuário.
//
// Contrato usado pelo manager: se `hadMl` for false, a promoção não é do Mercado
// Livre e deve seguir o fluxo normal (forward intacto). Se `failed` vier
// preenchido, NENHUM envio deve acontecer — divulgar o link original significaria
// entregar a venda sem a tag de afiliado.

import { convertToAffiliate, isMlUrl, ML_ERROR } from "./mlAffiliate.service.js";
import {
  isAggregatorUrl,
  resolveAggregatorToMl,
} from "./aggregatorResolver.js";

const URL_REGEX = /https?:\/\/[^\s<>"')\]}]+/gi;

// A mesma promo é enviada para vários grupos/pastas, e o mesmo link costuma se
// repetir ao longo do dia. O cache evita bater no Mercado Livre à toa — que é o
// recurso escasso aqui (cookie queima, IP bloqueia).
const CACHE_TTL_MS = Number(process.env.ML_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const cache = new Map();

function cacheKey(userId, url) {
  return `${userId}:${url}`;
}

function getCached(userId, url) {
  const entry = cache.get(cacheKey(userId, url));
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    cache.delete(cacheKey(userId, url));
    return null;
  }

  return entry.affiliate;
}

function setCached(userId, url, affiliate) {
  cache.set(cacheKey(userId, url), {
    affiliate,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

// URLs em texto corrido costumam vir grudadas em pontuação final.
function trimTrailingPunctuation(url) {
  return url.replace(/[.,;:!?]+$/, "");
}

export function extractMlUrls(text) {
  if (!text) return [];

  const found = (text.match(URL_REGEX) || [])
    .map(trimTrailingPunctuation)
    .filter(isMlUrl);

  return [...new Set(found)];
}

// Links de agregadores de promoção (ex.: salvouofertas.com), cuja página aponta
// para uma oferta do Mercado Livre.
export function extractAggregatorUrls(text) {
  if (!text) return [];

  const found = (text.match(URL_REGEX) || [])
    .map(trimTrailingPunctuation)
    .filter(isAggregatorUrl);

  return [...new Set(found)];
}

/**
 * Troca os links do Mercado Livre presentes no texto pelos links de afiliado.
 *
 * @returns {Promise<{ text: string, hadMl: boolean, failed: null | { type: string, url: string } }>}
 */
export async function convertMessageText(text, credentials, cacheScope) {
  const mlUrls = extractMlUrls(text);
  const aggregatorUrls = extractAggregatorUrls(text);

  if (mlUrls.length === 0 && aggregatorUrls.length === 0) {
    return { text, hadMl: false, failed: null };
  }

  if (!credentials?.mlAffiliateTag || !credentials?.cookieString) {
    return {
      text,
      hadMl: true,
      failed: {
        type: ML_ERROR.MISSING_CREDENTIALS,
        url: mlUrls[0] || aggregatorUrls[0],
      },
    };
  }

  // Alvos a converter: { original, mlUrl }. URLs do ML entram diretas; links de
  // agregador são resolvidos para a URL do ML da oferta (mantendo o `original`
  // para substituir no texto pelo link de afiliado).
  const targets = mlUrls.map((url) => ({ original: url, mlUrl: url }));

  for (const aggregatorUrl of aggregatorUrls) {
    try {
      const mlUrl = await resolveAggregatorToMl(aggregatorUrl);
      if (mlUrl) targets.push({ original: aggregatorUrl, mlUrl });
    } catch (error) {
      const type = error.mlError || ML_ERROR.TEMPORARY;
      // Página sem link do ML = não é promo do Mercado Livre → ignora o link
      // (não bloqueia). Falhas transitórias/host inválido bloqueiam o envio.
      if (type === ML_ERROR.PRODUCT_NOT_FOUND) continue;
      return { text, hadMl: true, failed: { type, url: aggregatorUrl } };
    }
  }

  // Só havia links de agregador e nenhum resolveu para o ML → não é promo do ML.
  if (targets.length === 0) {
    return { text, hadMl: false, failed: null };
  }

  let converted = text;

  for (const { original, mlUrl } of targets) {
    const cached = getCached(cacheScope, original);
    if (cached) {
      converted = converted.replaceAll(original, cached);
      continue;
    }

    const result = await convertToAffiliate(mlUrl, credentials);

    if (!result.affiliate) {
      return { text, hadMl: true, failed: { type: result.error.type, url: original } };
    }

    setCached(cacheScope, original, result.affiliate);
    converted = converted.replaceAll(original, result.affiliate);
  }

  return { text: converted, hadMl: true, failed: null };
}
