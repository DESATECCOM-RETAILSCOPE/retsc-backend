// Ciclo 5 · B3 — Propuesta de planograma a partir del PDF (pasos 8.3 y 8.4).
//
//   8.3 Identificación del SKU por código (UPC del PDF → RETSC_OP_SKUS.EAN):
//       EXACTO → SIN_CEROS (el catálogo guarda ceros a la izquierda) → SIN_VERIFICADOR (el PDF
//       omitió el dígito verificador; se calcula). Si un código válido NO está en el catálogo,
//       el producto no está cargado: queda SIN_MATCH / REVISAR (decisión de María, opción A:
//       se cargan antes en el catálogo). NO se busca por texto en ese caso: un "parecido" por
//       descripción sería OTRO producto (otro EAN). La búsqueda por texto (buscarSkuPorTexto,
//       umbral SKU_MATCH_THRESHOLD) queda solo para filas que vengan sin código.
//
//   8.4 Bandeja → mueble y fila (decisiones del ciclo 5):
//       · En el PDF: bandeja impar = mueble izquierdo, par = derecho; se cuenta de abajo hacia
//         arriba. Generalizado a M muebles: mueble = ((bandeja − 1) mod M) + 1.
//       · En el sistema: muebles numerados de IZQUIERDA a DERECHA (mueble 1 = izquierda, sin
//         importar la dirección del pasillo); dentro de cada mueble fila 1 = repisa de ARRIBA.
//
// La columna (orden dentro de la repisa) NO viene en el PDF: acá queda provisoria en el orden
// de la lista (orden_fuente = 'PDF') y la define el paso 8.5 con el dibujo.
//
// Formato del JSON: el del plan (B3) — muebles → niveles → posiciones, con match
// EAN_EXACTO | TEXTO | SIN_MATCH y estado OK | REVISAR — más campos extra (bandeja, upc,
// match_detalle, proveedor, unidades) que la pantalla de revisión necesita.

const skuRepo = require('../repositories/skuRepo');
const { stripZeros, lookupCandidates, dbVariants } = require('../utils/gtin');

const DEFAULT_MUEBLES = 2;

// Bandeja (numeración del PDF) → { shelfunit_id, shelflevel_id } (numeración del sistema).
function mapearBandeja(bandeja, { muebles = DEFAULT_MUEBLES, nivelesPorMueble }) {
  const b = Number(bandeja);
  if (!Number.isInteger(b) || b < 1) throw new Error(`Bandeja inválida: ${bandeja}`);
  const shelfunit_id = ((b - 1) % muebles) + 1;
  const nivelDesdeAbajo = Math.ceil(b / muebles);
  const shelflevel_id = nivelesPorMueble - nivelDesdeAbajo + 1;
  if (shelflevel_id < 1) throw new Error(`La bandeja ${b} no entra en ${nivelesPorMueble} niveles por mueble`);
  return { shelfunit_id, shelflevel_id };
}

// UPCs → Map(upc → { sku, match_detalle }) consultando el catálogo en lote.
async function identificarPorCodigo(upcs) {
  const variants = upcs.flatMap((u) => lookupCandidates(u).flatMap((c) => dbVariants(c.key)));
  const skus = await skuRepo.findSkusByEans(variants);
  const byKey = new Map(skus.map((s) => [stripZeros(s.EAN), s]));
  const out = new Map();
  for (const upc of upcs) {
    let hit = null;
    for (const c of lookupCandidates(upc)) {
      const sku = byKey.get(c.key);
      if (sku) {
        const exacto = String(sku.EAN).trim() === String(upc).trim();
        hit = { sku, match_detalle: c.tipo === 'EXACTO' && !exacto ? 'SIN_CEROS' : c.tipo };
        break;
      }
    }
    out.set(upc, hit);
  }
  return out;
}

// pdf = resultado de planogramPdfService.leerPlanogramaPdf()
async function construirPropuestaBase({ pdf, planogramSeq = null, flowDirection = null, muebles = DEFAULT_MUEBLES }) {
  const productos = pdf.productos.filter((p) => p.bandeja != null);
  const maxBandeja = Math.max(0, ...productos.map((p) => p.bandeja));
  const nivelesPorMueble = Math.ceil(maxBandeja / muebles);
  const ids = await identificarPorCodigo([...new Set(productos.map((p) => p.upc))]);

  // Agrupar por mueble → nivel, respetando el orden de la lista del PDF dentro de cada bandeja.
  const tree = new Map();
  for (const p of productos) {
    const { shelfunit_id, shelflevel_id } = mapearBandeja(p.bandeja, { muebles, nivelesPorMueble });
    if (!tree.has(shelfunit_id)) tree.set(shelfunit_id, new Map());
    const niveles = tree.get(shelfunit_id);
    if (!niveles.has(shelflevel_id)) niveles.set(shelflevel_id, { shelflevel_id, bandeja: p.bandeja, orden_fuente: 'PDF', posiciones: [] });
    const nivel = niveles.get(shelflevel_id);
    const hit = ids.get(p.upc);
    nivel.posiciones.push({
      shelfcolumn_id: nivel.posiciones.length + 1,      // provisoria — la define el paso 8.5
      ean: hit ? String(hit.sku.EAN).trim() : p.upc,
      upc: p.upc,
      texto_leido: p.descripcion,
      proveedor: p.proveedor,
      sku_id: hit ? hit.sku.SKU_ID : null,
      sku_dsc: hit ? hit.sku.Product_dsc : null,
      match: hit ? 'EAN_EXACTO' : 'SIN_MATCH',
      match_detalle: hit ? hit.match_detalle : 'NO_ESTA_EN_CATALOGO',
      confianza: hit ? 1 : 0,
      facings: p.frentes,
      unidades: p.unidades,
      width: null, height: null, depth: null,          // el PDF no trae medidas
      bbox: null,                                       // lo completa el paso 8.5 si el modelo lo devuelve
      estado: hit ? 'OK' : 'REVISAR',
    });
  }

  const mueblesJson = [...tree.keys()].sort((a, b) => a - b).map((unit) => ({
    shelfunit_id: unit,
    niveles: [...tree.get(unit).values()].sort((a, b) => a.shelflevel_id - b.shelflevel_id),
  }));
  const todas = mueblesJson.flatMap((m) => m.niveles.flatMap((n) => n.posiciones));
  const cuenta = (k, v) => todas.filter((p) => p[k] === v).length;

  return {
    planogram_seq: planogramSeq,
    flow_direction: flowDirection,
    fuente: { tipo: 'PDF', archivo: pdf.header?.archivo ?? null, fecha: pdf.header?.fecha ?? null, titulos: pdf.header?.titulos ?? [] },
    regla_bandejas: { muebles, niveles_por_mueble: nivelesPorMueble, descripcion: 'impar = mueble izquierdo, par = derecho, de abajo hacia arriba (PDF) → mueble 1 = izquierda, fila 1 = arriba (sistema)' },
    muebles: mueblesJson,
    resumen: {
      posiciones: todas.length,
      frentes: todas.reduce((s, p) => s + (p.facings ?? 0), 0),
      ean_exacto: cuenta('match', 'EAN_EXACTO'),
      sin_match: cuenta('match', 'SIN_MATCH'),
      a_revisar: cuenta('estado', 'REVISAR'),
      detalle_match: {
        EXACTO: cuenta('match_detalle', 'EXACTO'),
        SIN_CEROS: cuenta('match_detalle', 'SIN_CEROS'),
        SIN_VERIFICADOR: cuenta('match_detalle', 'SIN_VERIFICADOR'),
        NO_ESTA_EN_CATALOGO: cuenta('match_detalle', 'NO_ESTA_EN_CATALOGO'),
      },
    },
    advertencias: [...(pdf.advertencias ?? [])],
  };
}

module.exports = { construirPropuestaBase, mapearBandeja, identificarPorCodigo };
