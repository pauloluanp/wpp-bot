// Resolve links de agregadores de promoções (ex.: salvouofertas.com) para a URL
// do Mercado Livre da oferta principal, para então convertê-la em afiliado.
//
// Segurança: só busca hosts explicitamente permitidos (anti-SSRF), no mesmo
// espírito do parseMlUrl do mlAffiliate.service. Um redirect só é seguido se
// continuar dentro da allowlist do agregador.

import {
  ML_ERROR,
  USER_AGENT,
  fetchWithTimeout,
  isProductUrl,
  parseMlUrl,
} from "./mlAffiliate.service.js";

const AGGREGATOR_HOSTS = (process.env.ML_AGGREGATOR_HOSTS || "salvouofertas.com")
  .split(",")
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);

const MAX_REDIRECTS = 5;

// Aceita http/https e apenas hosts (ou subdomínios) da allowlist do agregador.
export function parseAggregatorUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return null;

  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const host = url.hostname.toLowerCase();
  const allowed = AGGREGATOR_HOSTS.some(
    (base) => host === base || host.endsWith(`.${base}`),
  );

  return allowed ? url : null;
}

export function isAggregatorUrl(rawUrl) {
  return parseAggregatorUrl(rawUrl) !== null;
}

// Segue redirects manualmente, revalidando que o host continua na allowlist do
// agregador a cada salto.
async function fetchAggregatorPage(startUrl) {
  let current = startUrl;

  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    const response = await fetchWithTimeout(current.toString(), {
      redirect: "manual",
      headers: { "user-agent": USER_AGENT, accept: "text/html,*/*" },
    });

    const location = response.headers.get("location");
    if (!location) return response;

    const next = parseAggregatorUrl(new URL(location, current).toString());
    if (!next) {
      throw Object.assign(
        new Error("Redirect do agregador para host não permitido"),
        { mlError: ML_ERROR.UNSUPPORTED_STORE },
      );
    }
    current = next;
  }

  throw Object.assign(new Error("Excesso de redirects no agregador"), {
    mlError: ML_ERROR.TEMPORARY,
  });
}

// Extrai a URL do ML da oferta PRINCIPAL. Prioriza o __NEXT_DATA__
// (props.pageProps.product.link / .initial_link), que aponta só para a oferta
// principal — não para os "produtos similares". Fallback: 1ª URL do ML no HTML.
function extractMlUrlFromPage(html) {
  const nextData = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
  );
  if (nextData) {
    try {
      const product = JSON.parse(nextData[1])?.props?.pageProps?.product;
      for (const candidate of [product?.link, product?.initial_link]) {
        const ml = parseMlUrl(candidate);
        if (ml) return ml.toString();
      }
    } catch {
      // Estrutura do site mudou / JSON inválido → cai no fallback por regex.
    }
  }

  const mlUrls = (html.match(/https?:\/\/[^\s<>"')\]}]+/gi) || [])
    .map((raw) => parseMlUrl(raw.replace(/&amp;/g, "&")))
    .filter(Boolean);

  const product = mlUrls.find(isProductUrl);
  return (product || mlUrls[0])?.toString() || null;
}

// Busca a página do agregador e devolve a URL do Mercado Livre da oferta (ou
// lança erro classificado). Não converte — quem converte é o convertToAffiliate.
export async function resolveAggregatorToMl(rawUrl) {
  const url = parseAggregatorUrl(rawUrl);
  if (!url) return null;

  const response = await fetchAggregatorPage(url);
  if (!response.ok) {
    throw Object.assign(new Error(`Agregador respondeu ${response.status}`), {
      mlError:
        response.status >= 500 ? ML_ERROR.TEMPORARY : ML_ERROR.PRODUCT_NOT_FOUND,
      status: response.status,
    });
  }

  const html = await response.text();
  const mlUrl = extractMlUrlFromPage(html);
  if (!mlUrl) {
    throw Object.assign(
      new Error("Link do Mercado Livre não encontrado na página do agregador"),
      { mlError: ML_ERROR.PRODUCT_NOT_FOUND },
    );
  }

  return mlUrl;
}
