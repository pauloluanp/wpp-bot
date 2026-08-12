// Conversão de URLs do Mercado Livre em links de afiliado.
//
// Portado do microserviço `gera-link`, com duas diferenças importantes:
//   1. as credenciais entram por parâmetro (aqui elas são POR USUÁRIO, vindas de
//      `ml_credentials`), em vez de serem lidas do process.env;
//   2. a validação de domínio é feita pelo hostname da URL, nunca por substring
//      (`url.includes("mercadolivre.com")` deixa passar `http://169.254.169.254/#mercadolivre.com`).

const ALLOWED_HOSTS = ["mercadolivre.com.br", "mercadolivre.com", "meli.la"];
const AFFILIATE_ENDPOINT =
  "https://www.mercadolivre.com.br/affiliate-program/api/v2/stripe/user/links";

export const USER_AGENT =
  process.env.ML_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = Number(process.env.ML_REQUEST_TIMEOUT || 15000);
const MAX_REDIRECTS = 10;

export const ML_ERROR = {
  UNSUPPORTED_STORE: "unsupported_store",
  MISSING_CREDENTIALS: "missing_credentials",
  CREDENTIALS_EXPIRED: "credentials_expired",
  RATE_LIMITED: "rate_limited",
  TEMPORARY: "temporary",
  NO_SHORT_URL: "no_short_url",
  PRODUCT_NOT_FOUND: "product_not_found",
};

// Aceita apenas http/https e hosts do Mercado Livre (domínio exato ou subdomínio).
// Rejeita `mercadolivre.com.atacante.com` e qualquer IP/host interno.
export function parseMlUrl(rawUrl) {
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

export function isMlUrl(rawUrl) {
  return parseMlUrl(rawUrl) !== null;
}

// O endpoint de afiliados espera a URL do produto sem query string.
function cleanMlUrl(url) {
  return `${url.origin}${url.pathname}`;
}

function extractCsrfFromCookie(cookieString) {
  const match = (cookieString || "").match(/(?:^|;)\s*_(?:csrf_token|csrf)=([^;]+)/i);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function needsResolution(url) {
  return (
    url.hostname.endsWith("meli.la") ||
    url.pathname.includes("/sec/") ||
    url.pathname.includes("/social/")
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

// Segue os redirects MANUALMENTE, revalidando o host a cada salto. Seguindo
// automaticamente, um encurtado poderia redirecionar para um host interno e a
// requisição sairia sem passar por nenhuma validação.
async function followRedirects(startUrl) {
  let current = startUrl;

  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    const response = await fetchWithTimeout(current.toString(), {
      redirect: "manual",
      headers: { "user-agent": USER_AGENT },
    });

    const location = response.headers.get("location");
    if (!location) return { url: current, response };

    const next = parseMlUrl(new URL(location, current).toString());
    if (!next) {
      throw Object.assign(new Error("Redirect para host não permitido"), {
        mlError: ML_ERROR.UNSUPPORTED_STORE,
      });
    }
    current = next;
  }

  throw Object.assign(new Error("Excesso de redirects"), {
    mlError: ML_ERROR.TEMPORARY,
  });
}

// Produtos do ML sempre têm o id na URL: /p/MLB123456 (catálogo), /up/MLBU123456
// (anúncio unificado, formato usado pelos kits) ou /MLB-123456 (anúncio).
// Sem esse filtro, o primeiro href da página seria algo como /acessibilidade/feedback, e o
// endpoint de afiliados responderia 400.
const PRODUCT_PATH_REGEX = /\/p\/MLB\d+|\/up\/MLBU?\d+|\/MLB-?\d+/i;

export function isProductUrl(url) {
  return PRODUCT_PATH_REGEX.test(url.pathname);
}

// Páginas /social/ não são o produto, e sim uma vitrine: o link real está no HTML.
function extractProductUrlFromHtml(html) {
  const hrefs = [...html.matchAll(/href="([^"]+)"/gi)].map((match) => match[1]);

  for (const href of hrefs) {
    const candidate = parseMlUrl(href.replace(/&amp;/g, "&"));
    if (candidate && isProductUrl(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function resolveProductUrl(url) {
  if (!needsResolution(url)) return url;

  const { url: finalUrl, response } = await followRedirects(url);

  if (!finalUrl.pathname.includes("/social/")) return finalUrl;

  const html = await response.text();
  const productUrl = extractProductUrlFromHtml(html);

  if (!productUrl) {
    throw Object.assign(new Error("Produto não encontrado no link social"), {
      mlError: ML_ERROR.PRODUCT_NOT_FOUND,
    });
  }

  return productUrl;
}

// Cookie vencido nunca se resolve com retry — só 429/5xx/rede merecem nova tentativa.
function classifyStatus(status) {
  if (status === 401 || status === 403) return ML_ERROR.CREDENTIALS_EXPIRED;
  if (status === 429) return ML_ERROR.RATE_LIMITED;
  if (status >= 500) return ML_ERROR.TEMPORARY;
  return null;
}

function isRetryable(errorType) {
  return errorType === ML_ERROR.RATE_LIMITED || errorType === ML_ERROR.TEMPORARY;
}

async function requestAffiliateLink(productUrl, credentials) {
  const cookieString = (credentials.cookieString || "").trim();
  const csrfToken = (
    credentials.csrfToken ||
    extractCsrfFromCookie(cookieString) ||
    ""
  ).trim();
  const cleanUrl = cleanMlUrl(productUrl);

  const response = await fetchWithTimeout(AFFILIATE_ENDPOINT, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "accept-language": "pt-BR,pt;q=0.9,en;q=0.8",
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
      cookie: cookieString,
      origin: "https://www.mercadolivre.com.br",
      referer: cleanUrl,
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify({ url: cleanUrl, tag: credentials.mlAffiliateTag }),
  });

  if (!response.ok) {
    throw Object.assign(new Error(`Mercado Livre respondeu ${response.status}`), {
      mlError: classifyStatus(response.status) || ML_ERROR.TEMPORARY,
      status: response.status,
    });
  }

  const data = await response.json().catch(() => null);

  if (!data?.short_url) {
    throw Object.assign(new Error("Resposta do Mercado Livre sem short_url"), {
      mlError: ML_ERROR.NO_SHORT_URL,
      status: response.status,
    });
  }

  return data.short_url;
}

async function withRetry(fn, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      // Falha de rede vem sem `mlError` — tratamos como temporária.
      const type = error.mlError || ML_ERROR.TEMPORARY;
      if (!isRetryable(type) || attempt === retries) throw error;

      const delay = 700 * 2 ** attempt * (0.7 + Math.random() * 0.6);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Converte uma URL do Mercado Livre no link de afiliado do usuário.
 * Nunca lança: devolve o erro classificado para o chamador decidir o que fazer.
 *
 * @returns {Promise<{ affiliate: string|null, original: string, error: null | { type: string, status?: number, message?: string } }>}
 */
export async function convertToAffiliate(rawUrl, credentials) {
  const url = parseMlUrl(rawUrl);

  if (!url) {
    return {
      affiliate: null,
      original: rawUrl,
      error: { type: ML_ERROR.UNSUPPORTED_STORE },
    };
  }

  if (!credentials?.mlAffiliateTag || !credentials?.cookieString) {
    return {
      affiliate: null,
      original: rawUrl,
      error: { type: ML_ERROR.MISSING_CREDENTIALS },
    };
  }

  try {
    const productUrl = await withRetry(() => resolveProductUrl(url));
    const affiliate = await withRetry(() =>
      requestAffiliateLink(productUrl, credentials),
    );

    return { affiliate, original: productUrl.toString(), error: null };
  } catch (error) {
    return {
      affiliate: null,
      original: rawUrl,
      error: {
        type: error.mlError || ML_ERROR.TEMPORARY,
        status: error.status,
        message: error.message,
      },
    };
  }
}
