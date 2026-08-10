// buscarSkuPorTexto — guía v1.9 sección 7.2 (entregable para Daniel) + pedido de María
// (umbral configurable desde RETSC_CONFIG). Por cada texto de OCR de una cajita detectada en
// una foto de visita, genera su embedding y busca el SKU más parecido en el índice
// `retsc-sku-vectors` (Azure AI Search, similitud coseno).
//
// Módulo AISLADO del flujo de carga de catálogo (skuImageService.js/queueService.js no lo
// importan, y viceversa) — Daniel lo llama directo desde código (no hay endpoint HTTP
// todavía, ver nota al final del archivo).
//
// ⚠ ASIMETRÍA CONOCIDA entre indexado y búsqueda (investigada antes de escribir este
// archivo, ver Functions/src/functions/ProcessSkuImageQueue.js:buildEnrichedText — repo
// hermano, NO se toca): el índice se pobló embebiendo TEXTO ENRIQUECIDO
// ("EAN: ... | Producto: ... | Categoría: ... | <OCR>"), no el OCR pelado. Acá solo
// tenemos el OCR crudo de la cajita — no hay EAN/Producto/Categoría todavía, es justamente
// lo que se busca (problema circular: para enriquecer necesitaríamos ya saber el SKU).
// Se embebe el OCR TAL CUAL, sin inventar placeholders para imitar el formato enriquecido
// (agregar "EAN: desconocido | Producto: ..." degradaría el embedding, no lo mejoraría).
// Riesgo aceptado: los scores de coseno pueden salir sistemáticamente más bajos que si
// comparáramos texto-enriquecido contra texto-enriquecido, aunque el ranking relativo
// (cuál SKU es el más parecido) debería mantenerse razonablemente estable — el nombre de
// marca/producto suele ser la parte semánticamente más densa de ambos textos. El umbral
// configurable (RETSC_CONFIG.SKU_MATCH_THRESHOLD, ver configService.js) es la palanca para
// absorber esto con datos reales una vez haya uso real, no una corrección de código.

const embeddingService = require('./embeddingService');
const configService     = require('./configService');

const SKU_MATCH_THRESHOLD_KEY = 'SKU_MATCH_THRESHOLD';
const FALLBACK_THRESHOLD      = 0.85;
const SEARCH_API_VERSION      = '2023-11-01'; // misma versión usada para verificar el índice en el diagnóstico previo

// Llamadas concurrentes en vez de en serie (una visita puede traer muchas cajitas) SIN
// mandar todo de golpe (evita saturar/rate-limitar Azure OpenAI y Azure Search). Ver
// embeddingService.js para por qué esto reemplaza a un único batch de OpenAI.
const CONCURRENCY = 8;

function getSearchConfig() {
  const endpoint = process.env.AZURE_SEARCH_ENDPOINT;
  const key      = process.env.AZURE_SEARCH_KEY;
  const index    = process.env.AZURE_SEARCH_INDEX || 'retsc-sku-vectors';
  if (!endpoint || !key) {
    throw new Error('Azure AI Search no configurado — faltan AZURE_SEARCH_ENDPOINT/AZURE_SEARCH_KEY en .env.');
  }
  return { endpoint: endpoint.replace(/\/+$/, ''), key, index };
}

// Busca el top-1 documento del índice para un vector dado (REST directo, mismo patrón que
// customVisionService.js — sin SDK; el backend no tiene @azure/search-documents como
// dependencia y agregar el paquete solo para un query no se justificó frente a un POST
// simple). Devuelve { skuId, score } o null si el índice no devolvió resultados.
async function searchTopMatch({ endpoint, key, index }, vector) {
  const url = `${endpoint}/indexes/${index}/docs/search?api-version=${SEARCH_API_VERSION}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vectorQueries: [{ kind: 'vector', vector, fields: 'embedding', k: 1 }],
      select: 'sku_id',
      top: 1,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Azure AI Search HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }

  const data = await resp.json();
  const top = data?.value?.[0];
  if (!top) return null;

  return { skuId: top.sku_id ?? null, score: top['@search.score'] ?? null };
}

// Pool de concurrencia simple — sin dependencias nuevas (no hay p-limit en package.json).
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function getThreshold() {
  return configService.getNumberConfig(SKU_MATCH_THRESHOLD_KEY, FALLBACK_THRESHOLD, { min: 0, max: 1 });
}

// Resuelve el match de UN texto — aislado en su propia función para que un fallo (embedding
// o búsqueda) se capture acá y no se propague al resto del arreglo (regla dura del
// entregable). Nunca lanza: en el peor caso devuelve matched:false con el error logueado.
async function resolveOne(texto, threshold, searchConfig) {
  try {
    const vector = await embeddingService.embedText(texto);
    const top = await searchTopMatch(searchConfig, vector);

    if (!top || top.score == null) {
      return { texto_original: texto, sku_id: null, similarity_score: null, matched: false };
    }

    const matched = top.score > threshold;
    return {
      texto_original: texto,
      sku_id: matched ? top.skuId : null,
      similarity_score: top.score,
      matched,
    };
  } catch (err) {
    console.error(`[skuSearch] fallo resolviendo match para texto="${texto}":`, err.message);
    return { texto_original: texto, sku_id: null, similarity_score: null, matched: false };
  }
}

/**
 * buscarSkuPorTexto(textos: string[]) → { texto_original, sku_id, similarity_score, matched }[]
 *
 * Por cada texto (OCR de una cajita), genera su embedding y busca el SKU más parecido en
 * retsc-sku-vectors. matched=true solo si el score de coseno supera el umbral configurado en
 * RETSC_CONFIG.SKU_MATCH_THRESHOLD (fallback 0.85 si la fila falta o no es parseable).
 *
 * Acepta arreglos — pensado para resolver todas las cajitas de una visita en una sola
 * llamada. Un texto que falla (Azure OpenAI o Azure Search caídos/lentos para ese ítem en
 * particular) no rompe el resto: sale como matched:false, logueado, y el arreglo completo
 * siempre tiene la misma longitud que `textos`.
 */
async function buscarSkuPorTexto(textos) {
  if (!Array.isArray(textos) || textos.length === 0) return [];

  // Se resuelven una sola vez por llamada (no por texto) — evitan N lecturas de RETSC_CONFIG
  // y N validaciones de env vars cuando el arreglo trae muchas cajitas.
  const threshold = await getThreshold();
  const searchConfig = getSearchConfig();

  return mapWithConcurrency(textos, CONCURRENCY, (texto) => resolveOne(texto, threshold, searchConfig));
}

module.exports = { buscarSkuPorTexto };

// NOTA — ¿endpoint HTTP? Por ahora NO se expone (Daniel/mobile todavía no llama directo al
// backend para este paso del flujo de v1.9 — la guía lo describe como función interna que
// el propio backend invocará al procesar una foto de visita). Si más adelante otro
// componente (frontend, otro servicio) necesita llamarlo por HTTP, agregar una ruta
// delgada en su propio controller/route que solo valide el body y delegue acá — no
// duplicar la lógica de arriba.
