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

// Guarda o par { affiliate, imageUrl }: a imagem sai da mesma página do
// agregador que o link, então revisitar o cache também evita rebuscá-la.
function getCached(userId, url) {
  const entry = cache.get(cacheKey(userId, url));
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    cache.delete(cacheKey(userId, url));
    return null;
  }

  return { affiliate: entry.affiliate, imageUrl: entry.imageUrl };
}

function setCached(userId, url, affiliate, imageUrl) {
  cache.set(cacheKey(userId, url), {
    affiliate,
    imageUrl: imageUrl || null,
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
 * `imageUrl` é a imagem do produto descoberta na página do agregador (a primeira
 * encontrada, quando há mais de um link). Vem `null` para promoções que só têm
 * link direto do ML — nesse caso nenhuma página é baixada.
 *
 * @returns {Promise<{ text: string, hadMl: boolean, imageUrl: string | null, failed: null | { type: string, url: string } }>}
 */
export async function convertMessageText(text, credentials, cacheScope) {
  const mlUrls = extractMlUrls(text);
  const aggregatorUrls = extractAggregatorUrls(text);

  if (mlUrls.length === 0 && aggregatorUrls.length === 0) {
    return { text, hadMl: false, imageUrl: null, failed: null };
  }

  if (!credentials?.mlAffiliateTag || !credentials?.cookieString) {
    return {
      text,
      hadMl: true,
      imageUrl: null,
      failed: {
        type: ML_ERROR.MISSING_CREDENTIALS,
        url: mlUrls[0] || aggregatorUrls[0],
      },
    };
  }

  // Alvos a converter: { original, mlUrl, imageUrl }. URLs do ML entram diretas
  // (sem imagem, porque não há página baixada); links de agregador são resolvidos
  // para a URL do ML da oferta (mantendo o `original` para substituir no texto
  // pelo link de afiliado) e trazem junto a imagem do produto.
  const targets = mlUrls.map((url) => ({
    original: url,
    mlUrl: url,
    imageUrl: null,
  }));

  for (const aggregatorUrl of aggregatorUrls) {
    try {
      const resolved = await resolveAggregatorToMl(aggregatorUrl);
      if (resolved) {
        targets.push({
          original: aggregatorUrl,
          mlUrl: resolved.mlUrl,
          imageUrl: resolved.imageUrl,
        });
      }
    } catch (error) {
      const type = error.mlError || ML_ERROR.TEMPORARY;
      // Página sem link do ML = não é promo do Mercado Livre → ignora o link
      // (não bloqueia). Falhas transitórias/host inválido bloqueiam o envio.
      if (type === ML_ERROR.PRODUCT_NOT_FOUND) continue;
      return { text, hadMl: true, imageUrl: null, failed: { type, url: aggregatorUrl } };
    }
  }

  // Só havia links de agregador e nenhum resolveu para o ML → não é promo do ML.
  if (targets.length === 0) {
    return { text, hadMl: false, imageUrl: null, failed: null };
  }

  let converted = text;
  let imageUrl = null;

  for (const target of targets) {
    const { original, mlUrl } = target;
    const cached = getCached(cacheScope, original);

    if (cached) {
      converted = converted.replaceAll(original, cached.affiliate);
      imageUrl = imageUrl || cached.imageUrl;
      continue;
    }

    const result = await convertToAffiliate(mlUrl, credentials);

    if (!result.affiliate) {
      return {
        text,
        hadMl: true,
        imageUrl: null,
        failed: { type: result.error.type, url: original },
      };
    }

    setCached(cacheScope, original, result.affiliate, target.imageUrl);
    converted = converted.replaceAll(original, result.affiliate);
    imageUrl = imageUrl || target.imageUrl;
  }

  return { text: converted, hadMl: true, imageUrl, failed: null };
}
