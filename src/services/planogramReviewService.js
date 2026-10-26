// Ciclo 5 · B4 / B5 (Fases 8.7, 8.8 y 9) — Lógica PURA de la revisión de un planograma:
// sin BD ni blob (eso vive en planogramService / planogramRepo), para poder probarla aislada.
//
//   asignarPosIds(propuesta)            → id estable por posición (pos_id), para comparar la
//                                         propuesta original con la revisada.
//   normalizarEdicion(muebles, …)       → valida y ordena lo que manda la pantalla de revisión:
//                                         renumera columnas 1..n en el orden recibido, completa
//                                         el SKU desde el catálogo y recalcula el estado.
//   recalcularResumen(propuesta)        → totales para la pantalla.
//   filasParaAprobar(propuesta)         → filas de RETSC_OP_PLANOGRAMDET; falla si queda alguna
//                                         posición sin SKU (regla del plan B4) o numeración repetida.
//   calcularPrecision(original, final)  → métricas del reporte de precisión (B5).

function svcError(message, statusCode, errorCode, extra = {}) {
  return Object.assign(new Error(message), { statusCode, errorCode, ...extra });
}

const posiciones = (propuesta) => (propuesta?.muebles ?? [])
  .flatMap((m) => (m.niveles ?? []).flatMap((n) => (n.posiciones ?? []).map((p) => ({ mueble: m.shelfunit_id, nivel: n.shelflevel_id, p }))));

function asignarPosIds(propuesta) {
  let max = 0;
  for (const { p } of posiciones(propuesta)) {
    const m = /^pos-(\d+)$/.exec(p.pos_id || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  for (const { p } of posiciones(propuesta)) if (!p.pos_id) p.pos_id = `pos-${++max}`;
  return propuesta;
}

const entero = (v, label, { min = 1, max = 999, nulo = false } = {}) => {
  if ((v === null || v === undefined || v === '') && nulo) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw svcError(`${label} inválido: ${v}`, 400, 'ERR_REVISION_INVALIDA');
  return n;
};
const medida = (v, label) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 10000) throw svcError(`${label} inválido: ${v}`, 400, 'ERR_REVISION_INVALIDA');
  return n;
};

// muebles: lo que manda la pantalla. Puede venir "liviano" — por posición solo pos_id + lo
// editable (sku_id, facings, medidas); el resto (código, texto leído, caja…) se toma de la
// propuesta anterior por pos_id, y los datos de cada fila (bandeja, orden…) por mueble+fila.
// original: propuesta antes de esta edición. catalogo: Map(sku_id → { SKU_ID, EAN, Product_dsc }).
function normalizarEdicion(muebles, { original = null, catalogo = new Map() } = {}) {
  if (!Array.isArray(muebles) || !muebles.length) throw svcError('La revisión no trae muebles.', 400, 'ERR_REVISION_INVALIDA');
  const previo = new Map(posiciones(original).map(({ p }) => [p.pos_id, p]));
  const nivelesPrevios = new Map((original?.muebles ?? []).flatMap((m) => (m.niveles ?? []).map((n) => [`${m.shelfunit_id}-${n.shelflevel_id}`, n])));
  const porMueble = new Map();
  for (const m of muebles) {
    const unit = entero(m?.shelfunit_id, 'Mueble');
    for (const n of m?.niveles ?? []) {
      const level = entero(n?.shelflevel_id, 'Fila');
      if (!porMueble.has(unit)) porMueble.set(unit, new Map());
      const niveles = porMueble.get(unit);
      if (!niveles.has(level)) {
        const { posiciones: _p, ...datosNivel } = nivelesPrevios.get(`${unit}-${level}`) ?? {};
        const { posiciones: _q, ...datosEnviados } = n;
        niveles.set(level, { ...datosNivel, ...datosEnviados, shelflevel_id: level, posiciones: [] });
      }
      const destino = niveles.get(level);
      for (const p of n?.posiciones ?? []) {
        const skuId = entero(p?.sku_id, 'SKU', { min: 1, max: 2 ** 31 - 1, nulo: true });
        const sku = skuId ? catalogo.get(skuId) : null;
        if (skuId && !sku) throw svcError(`El SKU ${skuId} no existe en el catálogo.`, 400, 'ERR_SKU_NO_EXISTE');
        const antes = p.pos_id ? previo.get(p.pos_id) : null;
        const cambioSku = (antes?.sku_id ?? null) !== skuId;
        const pos = {
          ...(antes ?? {}),
          ...p,
          pos_id: p.pos_id || null,
          sku_id: skuId,
          sku_dsc: sku ? sku.Product_dsc : null,
          ean: sku ? String(sku.EAN).trim() : (p.ean ?? antes?.ean ?? null),
          facings: entero(p.facings, 'Frentes', { min: 1, max: 99, nulo: true }),
          width: medida(p.width, 'Ancho'),
          height: medida(p.height, 'Alto'),
          depth: medida(p.depth, 'Profundidad'),
        };
        if (cambioSku) {
          pos.match = skuId ? 'MANUAL' : 'SIN_MATCH';
          pos.match_detalle = skuId ? 'ASIGNADO_EN_REVISION' : (antes ? 'QUITADO_EN_REVISION' : 'AGREGADO_SIN_SKU');
          pos.confianza = skuId ? 1 : 0;
        }
        pos.estado = skuId ? 'OK' : 'REVISAR';
        destino.posiciones.push(pos);
      }
    }
  }
  const out = [...porMueble.keys()].sort((a, b) => a - b).map((unit) => ({
    shelfunit_id: unit,
    niveles: [...porMueble.get(unit).values()]
      .sort((a, b) => a.shelflevel_id - b.shelflevel_id)
      .map((n) => ({ ...n, posiciones: n.posiciones.map((p, i) => ({ ...p, shelfcolumn_id: i + 1 })) })),
  }));
  // Las posiciones nuevas reciben su pos_id acá (las existentes lo conservan).
  asignarPosIds({ muebles: out });
  return out;
}

function recalcularResumen(propuesta) {
  const todas = posiciones(propuesta).map((x) => x.p);
  const cuenta = (k, v) => todas.filter((p) => p[k] === v).length;
  const detalle = {};
  todas.forEach((p) => { detalle[p.match_detalle ?? '—'] = (detalle[p.match_detalle ?? '—'] ?? 0) + 1; });
  propuesta.resumen = {
    ...(propuesta.resumen ?? {}),
    posiciones: todas.length,
    frentes: todas.some((p) => p.facings != null) ? todas.reduce((s, p) => s + (p.facings ?? 0), 0) : null,
    con_sku: todas.filter((p) => p.sku_id).length,
    sin_sku: todas.filter((p) => !p.sku_id).length,
    ean_exacto: cuenta('match', 'EAN_EXACTO'),
    sin_match: cuenta('match', 'SIN_MATCH'),
    a_revisar: cuenta('estado', 'REVISAR'),
    detalle_match: detalle,
  };
  return propuesta;
}

// → [{ Shelfunit_id, Shelflevel_id, Shelfcolumn_id, Facings, Height, Width, Depth, sku_id }]
function filasParaAprobar(propuesta) {
  const todas = posiciones(propuesta);
  if (!todas.length) throw svcError('El planograma no tiene posiciones.', 409, 'ERR_PLANOGRAMA_VACIO');
  const sinSku = todas.filter(({ p }) => !p.sku_id);
  if (sinSku.length) {
    throw svcError(
      `No se puede aprobar: ${sinSku.length} posición(es) sin SKU. Asigná el SKU o borrá la posición.`,
      409, 'ERR_POSICIONES_SIN_SKU',
      { pendientes: sinSku.slice(0, 50).map(({ mueble, nivel, p }) => ({ mueble, fila: nivel, columna: p.shelfcolumn_id, codigo: p.codigo_cadena ?? p.upc ?? null })) },
    );
  }
  const vistos = new Set();
  return todas.map(({ mueble, nivel, p }) => {
    const k = `${mueble}-${nivel}-${p.shelfcolumn_id}`;
    if (vistos.has(k)) throw svcError(`Posición repetida: mueble ${mueble}, fila ${nivel}, columna ${p.shelfcolumn_id}.`, 409, 'ERR_POSICION_REPETIDA');
    vistos.add(k);
    return {
      Shelfunit_id: mueble, Shelflevel_id: nivel, Shelfcolumn_id: p.shelfcolumn_id,
      Facings: p.facings ?? null, Height: p.height ?? null, Width: p.width ?? null, Depth: p.depth ?? null,
      sku_id: p.sku_id,
    };
  });
}

// Subsecuencia creciente más larga: cuántos elementos NO hubo que mover para llegar al orden final.
function lis(arr) {
  const tails = [];
  for (const v of arr) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < v) lo = mid + 1; else hi = mid; }
    tails[lo] = v;
  }
  return tails.length;
}
const pct = (n, d) => (d ? +((100 * n) / d).toFixed(1) : null);

// original: propuesta tal como la leyó el sistema. final: la revisada/aprobada.
// Una posición original cuenta como "corregida" si en la revisión se borró, se le cambió el SKU,
// se movió de mueble/fila, se cambió de lugar dentro de su fila o se le cambiaron los frentes.
// "Cambio de lugar" = no queda dentro de la subsecuencia más larga que conserva el orden (si se
// inserta un producto al inicio, los demás NO cuentan como corregidos).
function calcularPrecision(original, final) {
  const orig = posiciones(original);
  const fin = posiciones(final);
  const finPorId = new Map(fin.map((x) => [x.p.pos_id, x]));
  const origIds = new Set(orig.map((x) => x.p.pos_id));

  const c = { eliminadas: 0, sku_cambiado: 0, otra_fila: 0, orden: 0, frentes: 0 };
  const corregidas = new Set();
  // Orden: por fila final, posiciones originales que siguen en la misma fila.
  const filas = new Map();
  for (const o of orig) {
    const f = finPorId.get(o.p.pos_id);
    if (!f) { c.eliminadas++; corregidas.add(o.p.pos_id); continue; }
    if ((o.p.sku_id ?? null) !== (f.p.sku_id ?? null)) { c.sku_cambiado++; corregidas.add(o.p.pos_id); }
    if (o.mueble !== f.mueble || o.nivel !== f.nivel) { c.otra_fila++; corregidas.add(o.p.pos_id); continue; }
    if ((o.p.facings ?? null) !== (f.p.facings ?? null)) { c.frentes++; corregidas.add(o.p.pos_id); }
    const k = `${o.mueble}-${o.nivel}`;
    if (!filas.has(k)) filas.set(k, []);
    filas.get(k).push({ id: o.p.pos_id, antes: o.p.shelfcolumn_id, despues: f.p.shelfcolumn_id });
  }
  for (const items of filas.values()) {
    const ordenados = [...items].sort((a, b) => a.antes - b.antes);
    const quietos = lis(ordenados.map((x) => x.despues));
    const movidos = ordenados.length - quietos;
    if (!movidos) continue;
    // Marca como movidos los que no están en una subsecuencia creciente máxima (reconstrucción simple).
    const seq = ordenados.map((x) => x.despues);
    const n = seq.length;
    const len = new Array(n).fill(1), prev = new Array(n).fill(-1);
    for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) if (seq[j] < seq[i] && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
    let best = len.indexOf(Math.max(...len));
    const enLis = new Set();
    while (best >= 0) { enLis.add(best); best = prev[best]; }
    ordenados.forEach((x, i) => { if (!enLis.has(i)) { c.orden++; corregidas.add(x.id); } });
  }
  const agregadas = fin.filter((x) => !origIds.has(x.p.pos_id)).length;
  const total = orig.length;
  const sinCorregir = total - corregidas.size;
  const eanExacto = orig.filter((x) => x.p.match === 'EAN_EXACTO').length;
  const sinIdent = orig.filter((x) => !x.p.sku_id).length;
  // Validación del plan: ningún SKU propuesto por el sistema que no venga de un código leído.
  const skuSinCodigo = orig.filter((x) => x.p.sku_id && x.p.match !== 'EAN_EXACTO').length;
  return {
    posiciones_leidas: total,
    posiciones_finales: fin.length,
    sin_corregir: sinCorregir,
    pct_sin_corregir: pct(sinCorregir, total),
    ean_exacto: eanExacto,
    pct_ean_exacto: pct(eanExacto, total),
    sin_identificar: sinIdent,
    pct_sin_identificar: pct(sinIdent, total),
    agregadas,
    correcciones: c,
    sku_propuesto_sin_codigo: skuSinCodigo,
  };
}

module.exports = { asignarPosIds, normalizarEdicion, recalcularResumen, filasParaAprobar, calcularPrecision, posiciones };
