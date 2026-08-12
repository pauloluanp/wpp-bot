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

// Hosts de onde aceitamos BAIXAR a imagem do produto. A URL vem do HTML de um
// terceiro e quem busca é o servidor, então vale a mesma regra anti-SSRF dos
// links: allowlist explícita.
//
// De onde vem cada um:
// - mlstatic.com ............ CDN do Mercado Livre, usado quando a oferta sai
//                             com a foto oficial do produto (is_custom_image=false).
// - divulgadorinteligente.com CDN de imagens do próprio salvou, usado quando o
//                             divulgador sobe uma imagem própria (is_custom_image=true).
//
// Ao contrário do ML_AGGREGATOR_HOSTS, o ML_IMAGE_HOSTS SOMA à lista em vez de
// substituí-la: um CDN novo não deve derrubar os que já funcionam.
const IMAGE_HOSTS = [
  "mlstatic.com",
  "divulgadorinteligente.com",
  ...(process.env.ML_IMAGE_HOSTS || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
  ...AGGREGATOR_HOSTS,
];

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

// Aceita http/https e apenas hosts (ou subdomínios) da allowlist de imagem.
// Devolve string (e não URL) porque o valor só trafega até o download.
export function parseImageUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return null;

  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const host = url.hostname.toLowerCase();
  const allowed = IMAGE_HOSTS.some(
    (base) => host === base || host.endsWith(`.${base}`),
  );

  return allowed ? url.toString() : null;
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

// Nomes possíveis do campo de imagem no `product` do __NEXT_DATA__. O site não
// documenta o schema e ele já mudou antes, então testamos os candidatos usuais
// e caímos na og:image quando nenhum casa.
const CAMPOS_DE_IMAGEM = ["image", "image_url", "imageUrl", "thumbnail", "picture"];

// Aceita tanto string quanto objeto no formato { url }.
function urlDaImagem(valor) {
  if (typeof valor === "string") return valor;
  if (valor && typeof valor.url === "string") return valor.url;
  return null;
}

function extractImageFromProduct(product) {
  if (!product) return null;

  const candidatos = [
    // `originalValues` é o anúncio como ele existe no Mercado Livre: a imagem
    // aqui é a foto oficial, sempre no CDN do ML. Os campos de fora podem
    // trazer uma imagem própria que o divulgador subiu.
    product.originalValues?.image,
    ...CAMPOS_DE_IMAGEM.map((campo) => product[campo]),
    Array.isArray(product.images) ? product.images[0] : null,
  ];

  for (const candidato of candidatos) {
    const imagem = parseImageUrl(urlDaImagem(candidato));
    if (imagem) return imagem;
  }

  return null;
}

function extractOgImage(html) {
  const match =
    html.match(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    ) ||
    html.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    );

  return match ? parseImageUrl(match[1].replace(/&amp;/g, "&")) : null;
}

// Extrai a URL do ML da oferta PRINCIPAL e a imagem do produto a partir do
// __NEXT_DATA__ (props.pageProps.product), que aponta só para a oferta principal
// — não para os "produtos similares". Fallback: 1ª URL do ML no HTML. A imagem é
// opcional: sem ela o retorno vem com `imageUrl: null`.
//
// A ordem dos candidatos importa e não é cosmética:
//
//   originalValues.url  É o anúncio real no Mercado Livre. USAR SEMPRE QUE HOUVER.
//   link                Encurtador de rastreio do salvou. Ele NÃO leva ao produto:
//                       cai numa vitrine /social/ do perfil, com dezenas de itens.
//                       O resolveProductUrl então pescava o primeiro produto da
//                       vitrine — e o link de afiliado saía de OUTRO produto.
//   initial_link        Visto sempre null nas ofertas testadas; fica por garantia.
function extractFromPage(html) {
  const nextData = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
  );

  let mlUrl = null;
  let imageUrl = null;

  if (nextData) {
    try {
      const product = JSON.parse(nextData[1])?.props?.pageProps?.product;
      for (const candidate of [
        product?.originalValues?.url,
        product?.link,
        product?.initial_link,
      ]) {
        const ml = parseMlUrl(candidate);
        if (ml) {
          mlUrl = ml.toString();
          break;
        }
      }
      imageUrl = extractImageFromProduct(product);
    } catch {
      // Estrutura do site mudou / JSON inválido → cai nos fallbacks por regex.
    }
  }

  if (!mlUrl) {
    const mlUrls = (html.match(/https?:\/\/[^\s<>"')\]}]+/gi) || [])
      .map((raw) => parseMlUrl(raw.replace(/&amp;/g, "&")))
      .filter(Boolean);

    const product = mlUrls.find(isProductUrl);
    mlUrl = (product || mlUrls[0])?.toString() || null;
  }

  return { mlUrl, imageUrl: imageUrl || extractOgImage(html) };
}

/**
 * Busca a página do agregador e devolve a URL do Mercado Livre da oferta e a
 * imagem do produto (ou lança erro classificado). Não converte — quem converte
 * é o convertToAffiliate.
 *
 * @returns {Promise<null | { mlUrl: string, imageUrl: string | null }>}
 *   `null` quando a URL não é de um agregador conhecido. `imageUrl` é opcional:
 *   página sem imagem reconhecível não é erro.
 */
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
  const { mlUrl, imageUrl } = extractFromPage(html);
  if (!mlUrl) {
    throw Object.assign(
      new Error("Link do Mercado Livre não encontrado na página do agregador"),
      { mlError: ML_ERROR.PRODUCT_NOT_FOUND },
    );
  }

  return { mlUrl, imageUrl };
}
