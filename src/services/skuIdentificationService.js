// PLACEHOLDER — este módulo pertenece a Joel, no a Daniel.
//
// La guía "Fotos de Visita" v1.9 (María Royo, sección 7.2) es explícita: "Esto no es algo
// que Daniel y Joel tengan que diseñar juntos — es una función concreta que Joel debe
// construir". Este archivo existe para que el resto del pipeline de visita (Paso 5,
// productIdentificationService.js) tenga algo que llamar HOY con el contrato exacto que la
// guía define, y así el flujo completo sea end-to-end probable (con matched:false siempre)
// antes de que Joel entregue la implementación real.
//
// CONTRATO (sección 7.2 de la guía — no inventar otro, es el acordado):
//   buscarSkuPorTexto(textos: string[]) → resultados[]
//   Entrada: arreglo de textos (uno por cada cajita detectada en la foto)
//   Salida:  arreglo de { texto_original, sku_id, similarity_score, matched }
//
// Lo que la implementación real debe hacer (documentado acá solo como referencia — la
// implementa Joel, no este archivo):
//   1. Generar embedding con Azure OpenAI (aoai-rscope-prod, deployment text-embedding-ada-002)
//   2. Buscar el vector en retsc-sku-vectors (Azure AI Search, cosine, HNSW)
//   3. score > 0.85 (umbral inicial, ver SKU_MATCH_SIMILARITY_THRESHOLD) → matched:true
//   4. si no → matched:false, sku_id:null (cajita detectada pero sin identificar — válido)
//   Debe vivir en un módulo propio (separado del flujo de carga del catálogo) y aceptar
//   arreglos completos, no una llamada por cajita (ver guía, sección 7.2).
//
// CUANDO JOEL ENTREGUE EL MÓDULO REAL:
//   No hay que tocar productIdentificationService.js — solo reemplazar la implementación de
//   buscarSkuPorTexto() en este archivo (o, si Joel lo pone en otra ruta del mismo repo,
//   cambiar el require() en productIdentificationService.js para apuntar ahí). Ver
//   docs/TODO-joel-visitas.md para el resto de entregables pendientes (sección 9 de la guía).
//
// TEMPORAL — devuelve matched:false para todo texto, sin llamar a ningún servicio externo.
// A propósito NO es un stub "permisivo" (no inventa matches) — inventar un sku_id sin
// haberlo buscado de verdad sería peor que dejar la cajita sin identificar.

const SIMILARITY_THRESHOLD = () =>
  parseFloat(process.env.SKU_MATCH_SIMILARITY_THRESHOLD || '0.85');

// textos: string[] (uno por cajita, ya extraído por OCR — ver azureVisionService.readText()).
// Devuelve: [{ texto_original, sku_id, similarity_score, matched }] — mismo orden de entrada.
async function buscarSkuPorTexto(textos) {
  if (!textos || textos.length === 0) return [];

  console.warn(
    `[skuIdentificationService] PLACEHOLDER activo (${textos.length} texto(s)) — ` +
    'esperando el módulo real de Joel (guía v1.9, sección 7.2). Ver docs/TODO-joel-visitas.md.'
  );

  return textos.map((texto) => ({
    texto_original:    texto,
    sku_id:            null,
    similarity_score:  null,
    matched:           false,
  }));
}

module.exports = { buscarSkuPorTexto, SIMILARITY_THRESHOLD };
