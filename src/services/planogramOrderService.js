// Ciclo 5 · B3 (Fase 8.5) — Orden de los productos dentro de cada repisa, a partir del dibujo.
//
// El PDF trae QUÉ productos van en cada bandeja (UPC, descripción, frentes) pero NO en qué
// orden de izquierda a derecha. Ese orden solo está en el dibujo (página 1).
//
// Método BLOQUES (principal):
//   1. Del PDF se sacan las posiciones EXACTAS de cada imagen de producto (cada frente es una
//      imagen embebida; el mismo producto repite la misma imagen) → bloques B1…Bn por repisa,
//      ya ordenados de izquierda a derecha (planogramDrawingService.bloquesDeSegmento).
//      Entran también las imágenes que se pasan al mueble vecino (productos sobre el corte).
//   2. Al modelo multimodal (AZURE_OPENAI_CHAT_DEPLOYMENT, gpt-5.4-mini) se le pasa el recorte
//      de la repisa con los bloques enmarcados y numerados + la lista CERRADA de productos
//      (ids P1..Pn). Por CADA bloque devuelve hasta 3 candidatos, del más al menos probable
//      (u OTRO si no es de la lista). Clasificar bloque por bloque es lo que el modelo hace
//      bien; pedirle una asignación perfecta producto→bloque falló (repetía productos parecidos).
//   3. La asignación final la arma el código (resolverAsignacion): cada producto a un bloque
//      distinto minimizando el costo (1.º candidato = 0, 2.º = 1, 3.º = 2, no listado = 6;
//      algoritmo húngaro) y luego cada bloque libre se une al producto vecino si es su 1.er
//      candidato (un producto con varias imágenes). Los bloques que quedan sin producto se
//      informan (bloques_sobrantes).
//   4. El orden sale de la posición real de los bloques y la caja (bbox) es la unión exacta de
//      sus imágenes — no la estima el modelo. Cada posición lleva orden_confianza ALTA (fue el
//      1.er candidato), MEDIA (2.º/3.º) o BAJA (el modelo no lo listó) y la repisa queda
//      REVISAR si hay alguna BAJA.
//   Si hay menos bloques que productos (dos productos con la misma imagen), se usa un bloque
//   por frente (columna).
//
// Método LIBRE (respaldo, si el PDF no trae imágenes ubicables): el modelo devuelve el orden y
// el tramo x de cada producto (menos preciso).
//
// Si ambos fallan: orden de la lista del PDF, orden_fuente 'PDF' + orden_estado 'REVISAR'.
// El modelo NO identifica productos contra el catálogo (eso ya lo hizo el UPC en 8.3): solo
// ubica una lista que ya conocemos. No puede "inventar" un SKU.
//
// Bandeja ↔ segmento del dibujo: bandeja = (nivelDesdeAbajo − 1) · M + mueble (regla 8.4). Si
// el dibujo no tiene la cantidad de muebles/niveles que dice la regla, NO se adivina: todo queda
// en orden PDF / REVISAR con una advertencia.

const drawing = require('./planogramDrawingService');

const API_VERSION_DEFAULT = '2025-04-01-preview';
const CONCURRENCIA = 3;
const MAX_TOKENS = 8000;            // gpt-5.x razona: los tokens de razonamiento cuentan aquí
const TIMEOUT_MS = 90_000;          // por llamada; si Azure no responde se reintenta y luego REVISAR
const ESCALA_DETECCION = 3;         // los umbrales de detectarRepisas están calibrados a escala 3
const ESCALA_RECORTE = 6;           // más resolución para que el modelo lea los empaques

function configOpenAI(env = process.env) {
  const endpoint = (env.AZURE_OPENAI_ENDPOINT || '').replace(/\/+$/, '');
  const key = env.AZURE_OPENAI_KEY;
  const deployment = env.AZURE_OPENAI_CHAT_DEPLOYMENT;
  if (!endpoint || !key || !deployment) return null;
  return { endpoint, key, deployment, apiVersion: env.AZURE_OPENAI_API_VERSION || API_VERSION_DEFAULT };
}

const textoProductos = (productos) => productos
  .map((p) => `${p.id} | ${p.descripcion}${p.proveedor ? ` | proveedor: ${p.proveedor}` : ''} | frentes: ${p.frentes ?? '?'}`)
  .join('\n');

// ── Prompts y esquemas ───────────────────────────────────────────────────────
const SISTEMA_BLOQUES = [
  'Sos un asistente que lee dibujos de planogramas de supermercado.',
  'Recibís la imagen de UNA repisa (vista de frente) con los productos enmarcados en bloques numerados B1, B2, … de izquierda a derecha, y la lista de productos que van en esa repisa (con id, descripción abreviada, proveedor y frentes).',
  'Para CADA bloque decí qué producto de la lista es: hasta 3 candidatos, del más probable al menos probable, comparando marca, variante, color, presentación (barra, roll-on, aerosol, gel, paquete) y el texto del empaque con la descripción.',
  'Si el bloque no es ningún producto de la lista (por ejemplo, un producto del mueble vecino que asoma en un borde), poné OTRO como primer candidato.',
  'Todos los productos de la lista están en la imagen. Un mismo producto puede ocupar varios bloques seguidos. Hay productos muy parecidos (misma marca, otra variante o tamaño): fijate en los detalles para distinguirlos.',
  'Los frentes son una pista (cuántas unidades de ancho ocupa), no una regla exacta: hay productos apilados y paquetes.',
].join(' ');

const SISTEMA_LIBRE = [
  'Sos un asistente que lee dibujos de planogramas de supermercado.',
  'Recibís la imagen de UNA repisa (vista de frente) y la lista COMPLETA de productos que van en ella.',
  'Tu única tarea es decir en qué orden aparecen de IZQUIERDA a DERECHA.',
  'Reglas: usá solo los ids de la lista; cada id exactamente una vez; no agregues ni omitas productos.',
  'x_inicio y x_fin son la fracción (0 a 1) del ancho de la imagen donde empieza y termina ese producto.',
  'Un producto con varios frentes ocupa varias unidades contiguas: es UN solo tramo.',
].join(' ');

const esquemaArreglo = (nombre, clave, props) => ({
  name: nombre,
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [clave],
    properties: {
      [clave]: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, required: Object.keys(props), properties: props },
      },
    },
  },
});
const esquemaBloques = (ids) => esquemaArreglo('candidatos_bloques', 'bloques', {
  bloque: { type: 'integer' },
  candidatos: { type: 'array', items: { type: 'string', enum: [...ids, 'OTRO'] } },
});
const esquemaLibre = (ids) => esquemaArreglo('orden_repisa', 'orden', { id: { type: 'string', enum: ids }, x_inicio: { type: 'number' }, x_fin: { type: 'number' } });

// ── Validaciones ─────────────────────────────────────────────────────────────
function idsExactos(items, ids) {
  if (!Array.isArray(items)) return 'La respuesta no trae la lista.';
  const vistos = new Set();
  for (const o of items) {
    if (!ids.includes(o?.id)) return `Id desconocido: ${o?.id}`;
    if (vistos.has(o.id)) return `Id repetido: ${o.id}`;
    vistos.add(o.id);
  }
  const faltan = ids.filter((id) => !vistos.has(id));
  return faltan.length ? `Faltan ids: ${faltan.join(', ')}` : null;
}

// LIBRE → { ok: true, orden } | { ok: false, motivo }
function validarPermutacion(respuesta, ids) {
  const motivo = idsExactos(respuesta?.orden, ids);
  return motivo ? { ok: false, motivo } : { ok: true, orden: respuesta.orden };
}

// BLOQUES (respuesta del modelo) → { ok: true, candidatos: [[ids…] por bloque 1..n] } | { ok: false, motivo }
function validarCandidatos(respuesta, ids, nBloques) {
  const items = respuesta?.bloques;
  if (!Array.isArray(items)) return { ok: false, motivo: 'La respuesta no trae "bloques".' };
  const candidatos = new Array(nBloques + 1).fill(null);
  for (const it of items) {
    const n = it?.bloque;
    if (!Number.isInteger(n) || n < 1 || n > nBloques) return { ok: false, motivo: `Bloque inexistente: B${n} (hay B1–B${nBloques})` };
    if (candidatos[n]) return { ok: false, motivo: `B${n} aparece dos veces` };
    const c = [...new Set((it.candidatos ?? []).filter((x) => x === 'OTRO' || ids.includes(x)))].slice(0, 3);
    if (!c.length) return { ok: false, motivo: `B${n} sin candidatos` };
    candidatos[n] = c;
  }
  const faltan = [];
  for (let n = 1; n <= nBloques; n++) if (!candidatos[n]) faltan.push(`B${n}`);
  if (faltan.length) return { ok: false, motivo: `Faltan bloques: ${faltan.join(', ')}` };
  return { ok: true, candidatos };
}

// Algoritmo húngaro (asignación de costo mínimo) para n filas ≤ m columnas.
// costo[i][j], i en 0..n-1, j en 0..m-1 → columna asignada a cada fila.
function hungaro(costo) {
  const n = costo.length, m = costo[0].length;
  const INF = 1e9;
  const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(INF), usado = new Array(m + 1).fill(false);
    do {
      usado[j0] = true;
      const i0 = p[j0];
      let delta = INF, j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (usado[j]) continue;
        const cur = costo[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (usado[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const asignada = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) asignada[p[j] - 1] = j - 1;
  return asignada;
}

const COSTO_NO_LISTADO = 6;
const confianzaDe = (costo) => (costo === 0 ? 'ALTA' : costo < COSTO_NO_LISTADO ? 'MEDIA' : 'BAJA');

// candidatos[1..n] (de validarCandidatos) → asignación completa y contigua.
// → { asignacion: [{ id, desde, hasta, confianza }] ordenada por bloque, sobrantes: [n…] }
function resolverAsignacion(candidatos, ids) {
  const nB = candidatos.length - 1;
  const costo = ids.map((id) => Array.from({ length: nB }, (_, j) => {
    const k = candidatos[j + 1].indexOf(id);
    return k < 0 ? COSTO_NO_LISTADO : k;
  }));
  const ancla = hungaro(costo);                                  // producto i → bloque ancla (0-based)
  const ocupante = new Array(nB + 1).fill(null);
  ids.forEach((id, i) => { ocupante[ancla[i] + 1] = id; });
  // Bloques libres: se unen al vecino si su 1.er candidato es ese producto (varias imágenes).
  let cambio = true;
  while (cambio) {
    cambio = false;
    for (let n = 1; n <= nB; n++) {
      if (ocupante[n]) continue;
      const top = candidatos[n][0];
      if (top !== 'OTRO' && (ocupante[n - 1] === top || ocupante[n + 1] === top)) { ocupante[n] = top; cambio = true; }
    }
  }
  const asignacion = ids.map((id, i) => {
    let desde = ancla[i] + 1, hasta = desde;
    while (desde > 1 && ocupante[desde - 1] === id) desde--;
    while (hasta < nB && ocupante[hasta + 1] === id) hasta++;
    return { id, desde, hasta, confianza: confianzaDe(costo[i][ancla[i]]) };
  }).sort((x, y) => x.desde - y.desde);
  const sobrantes = [];
  for (let n = 1; n <= nB; n++) if (!ocupante[n]) sobrantes.push(n);
  return { asignacion, sobrantes };
}

const tramoValido = (o) => {
  const a = Number(o.x_inicio), b = Number(o.x_fin);
  return Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b <= 1.0001 && b > a;
};

// ── Llamada al modelo ────────────────────────────────────────────────────────
async function llamarModelo({ cfg, messages, esquema, fetchImpl, timeoutMs }) {
  const url = `${cfg.endpoint}/openai/deployments/${encodeURIComponent(cfg.deployment)}/chat/completions?api-version=${cfg.apiVersion}`;
  const body = { messages, max_completion_tokens: MAX_TOKENS, response_format: { type: 'json_schema', json_schema: esquema } };
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': cfg.key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = new Error(e.name === 'TimeoutError' ? `Azure OpenAI no respondió en ${timeoutMs / 1000} s` : `Azure OpenAI: ${e.message}`);
    err.status = 0;                                          // red / timeout: se puede reintentar
    throw err;
  }
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Azure OpenAI ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const data = JSON.parse(text);
  const contenido = data?.choices?.[0]?.message?.content;
  if (!contenido) throw new Error(`Respuesta vacía (finish_reason: ${data?.choices?.[0]?.finish_reason ?? '?'})`);
  return { contenido, respuesta: JSON.parse(contenido), uso: data.usage ?? null };
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// Conversación con 1 corrección: si la respuesta no valida, se le devuelve el error al modelo.
async function conversar({ cfg, sistema, texto, imagenJpeg, esquema, validar, fetchImpl, reintentos = 1, esperaMs = 1500, timeoutMs = TIMEOUT_MS }) {
  const messages = [
    { role: 'system', content: sistema },
    { role: 'user', content: [
      { type: 'text', text: texto },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imagenJpeg.toString('base64')}`, detail: 'high' } },
    ] },
  ];
  let motivo = null;
  const uso = [];
  for (let intento = 1; intento <= reintentos + 1; intento++) {
    try {
      const r = await llamarModelo({ cfg, messages, esquema, fetchImpl, timeoutMs });
      if (r.uso) uso.push(r.uso);
      const v = validar(r.respuesta);
      if (v.ok) return { ...v, intentos: intento, uso };
      motivo = v.motivo;
      messages.push({ role: 'assistant', content: r.contenido });
      messages.push({ role: 'user', content: `La respuesta no cumple las reglas: ${motivo}. Corregila y devolvé la respuesta completa.` });
    } catch (e) {
      motivo = e.message;
      if (e.status && e.status !== 429 && e.status < 500) break;   // 4xx (salvo 429): no sirve reintentar
      if (intento <= reintentos) await espera(esperaMs * intento);
    }
  }
  return { ok: false, motivo, intentos: reintentos + 1, uso };
}

// LIBRE: ordena UNA repisa sin bloques. productos = [{ id, descripcion, proveedor, frentes }]
async function ordenarRepisa({ cfg, imagenJpeg, productos, fetchImpl = fetch, ...opts }) {
  if (productos.length === 1) return { ok: true, orden: [{ id: productos[0].id, x_inicio: 0, x_fin: 1 }], intentos: 0, uso: [] };
  const ids = productos.map((p) => p.id);
  return conversar({
    cfg, imagenJpeg, fetchImpl, ...opts,
    sistema: SISTEMA_LIBRE,
    texto: `Productos de esta repisa (${productos.length}):\n${textoProductos(productos)}\n\nDevolvé el orden de izquierda a derecha.`,
    esquema: esquemaLibre(ids),
    validar: (r) => validarPermutacion(r, ids),
  });
}

// BLOQUES: candidatos por bloque (modelo) + asignación (código). bloques = [{ n, imagenes }]
// → { ok, asignacion, sobrantes, candidatos, intentos, uso } | { ok: false, motivo, … }
async function asignarBloques({ cfg, imagenJpeg, productos, bloques, fetchImpl = fetch, ...opts }) {
  if (productos.length === 1 && bloques.length === 1) {
    return { ok: true, asignacion: [{ id: productos[0].id, desde: 1, hasta: 1, confianza: 'ALTA' }], sobrantes: [], intentos: 0, uso: [] };
  }
  const ids = productos.map((p) => p.id);
  const lista = bloques.map((b) => `B${b.n} (${b.imagenes} ${b.imagenes === 1 ? 'imagen' : 'imágenes'})`).join(', ');
  const r = await conversar({
    cfg, imagenJpeg, fetchImpl, ...opts,
    sistema: SISTEMA_BLOQUES,
    texto: `Bloques marcados (${bloques.length}): ${lista}\n\nProductos de esta repisa (${productos.length}):\n${textoProductos(productos)}\n\nDevolvé, para cada bloque de B1 a B${bloques.length}, sus candidatos.`,
    esquema: esquemaBloques(ids),
    validar: (resp) => validarCandidatos(resp, ids, bloques.length),
  });
  if (!r.ok) return r;
  return { ...r, ...resolverAsignacion(r.candidatos, ids) };
}

// ── Propuesta completa ──────────────────────────────────────────────────────
async function enParalelo(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const escalarBox = (b, f) => ({ left: Math.round(b.left * f), top: Math.round(b.top * f), width: Math.round(b.width * f), height: Math.round(b.height * f) });
const escalarBloque = (b, f) => ({ ...b, x0: b.x0 * f, x1: b.x1 * f, y0: b.y0 * f, y1: b.y1 * f });
const r4 = (v) => +v.toFixed(4);

function marcarRevisar(nivel, motivo) {
  nivel.orden_fuente = 'PDF';
  nivel.orden_estado = 'REVISAR';
  nivel.orden_motivo = motivo;
}

// Aplica el paso 8.5 sobre la propuesta de construirPropuestaBase() (la MUTA y la devuelve).
// Devuelve también el dibujo (PNG a escala de detección) para guardarlo junto a la propuesta.
// onRepisa(info) se llama al terminar cada repisa (progreso); onRecorte(info, jpeg) recibe la
// imagen que vio el modelo (diagnóstico).
async function ordenarPropuesta({ propuesta, pdfBuffer, fetchImpl = fetch, env = process.env, concurrencia = CONCURRENCIA, escalaRecorte = ESCALA_RECORTE, onRepisa = null, onRecorte = null, timeoutMs = TIMEOUT_MS }) {
  const niveles = propuesta.muebles.flatMap((m) => m.niveles.map((n) => ({ mueble: m.shelfunit_id, nivel: n })));
  const advertencias = [];
  const fin = (dibujo, deteccion) => {
    const ia = niveles.filter(({ nivel }) => nivel.orden_fuente === 'IA');
    propuesta.resumen.orden = {
      niveles: niveles.length,
      ordenados_ia: ia.length,
      por_bloques: ia.filter(({ nivel }) => nivel.orden_metodo === 'BLOQUES').length,
      a_revisar: niveles.filter(({ nivel }) => nivel.orden_estado === 'REVISAR').length,
      confianza: niveles.reduce((acc, { nivel }) => {
        for (const k of ['ALTA', 'MEDIA', 'BAJA']) acc[k] += nivel.orden_confianza?.[k] ?? 0;
        return acc;
      }, { ALTA: 0, MEDIA: 0, BAJA: 0 }),
    };
    propuesta.dibujo = dibujo ? { width: dibujo.width, height: dibujo.height, escala: ESCALA_DETECCION, muebles: deteccion?.muebles?.length ?? 0, niveles: deteccion?.niveles?.length ?? 0 } : null;
    propuesta.advertencias.push(...advertencias);
    return { propuesta, dibujoPng: dibujo?.png ?? null };
  };

  const cfg = configOpenAI(env);
  if (!cfg) {
    advertencias.push('Orden de repisas: Azure OpenAI no configurado (AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_KEY / AZURE_OPENAI_CHAT_DEPLOYMENT). Se dejó el orden de la lista del PDF.');
    niveles.forEach(({ nivel }) => marcarRevisar(nivel, 'IA no configurada'));
    return fin(null, null);
  }

  let dibujo, deteccion, imagenes = [];
  try {
    dibujo = await drawing.renderDibujo(pdfBuffer, { scale: ESCALA_DETECCION });
    deteccion = await drawing.detectarRepisas(dibujo.png);
  } catch (e) {
    advertencias.push(`Orden de repisas: no se pudo leer el dibujo (${e.message}). Se dejó el orden del PDF.`);
    niveles.forEach(({ nivel }) => marcarRevisar(nivel, 'Dibujo ilegible'));
    return fin(null, null);
  }
  advertencias.push(...deteccion.advertencias);
  try {
    imagenes = await drawing.extraerImagenes(pdfBuffer, { scale: ESCALA_DETECCION });
  } catch (e) {
    advertencias.push(`Orden de repisas: no se pudieron ubicar las imágenes del PDF (${e.message}); se usa el método LIBRE.`);
  }

  const { muebles: M, niveles_por_mueble: N } = propuesta.regla_bandejas;
  if (deteccion.muebles.length !== M || deteccion.niveles.length !== N) {
    advertencias.push(`Orden de repisas: el dibujo tiene ${deteccion.muebles.length} mueble(s) × ${deteccion.niveles.length} repisa(s) y el PDF indica ${M} × ${N}. No se ordenó con IA para no asignar repisas equivocadas.`);
    niveles.forEach(({ nivel }) => marcarRevisar(nivel, 'El dibujo no coincide con las bandejas del PDF'));
    return fin(dibujo, deteccion);
  }

  // Recortes desde un render de mayor resolución (cajas y bloques se escalan).
  const f = escalaRecorte / ESCALA_DETECCION;
  const hiRes = f === 1 ? dibujo : await drawing.renderDibujo(pdfBuffer, { scale: escalaRecorte });

  await enParalelo(niveles, concurrencia, async ({ mueble, nivel }) => {
    const t0 = Date.now();
    const nivelDesdeAbajo = N - nivel.shelflevel_id + 1;
    const seg = deteccion.segmentos.find((s) => s.shelfunit_id === mueble && s.nivelDesdeAbajo === nivelDesdeAbajo);
    const avisar = () => onRepisa?.({ mueble, fila: nivel.shelflevel_id, bandeja: nivel.bandeja, metodo: nivel.orden_metodo ?? null, estado: nivel.orden_estado, motivo: nivel.orden_motivo ?? null, segundos: (Date.now() - t0) / 1000 });
    if (!seg) { marcarRevisar(nivel, 'Repisa no encontrada en el dibujo'); avisar(); return; }

    const productos = nivel.posiciones.map((p, i) => ({ id: `P${i + 1}`, descripcion: p.texto_leido, proveedor: p.proveedor, frentes: p.facings }));
    const porId = new Map(nivel.posiciones.map((p, i) => [`P${i + 1}`, p]));
    const boxHi = escalarBox(seg.box, f);

    // 1) BLOQUES (por producto; si no alcanzan, por frente). Incluye los que pisan el corte.
    let bloques = imagenes.length ? drawing.bloquesDeSegmento(imagenes, seg.box, { incluirBordes: true }) : [];
    if (bloques.length && bloques.length < productos.length) bloques = drawing.bloquesDeSegmento(imagenes, seg.box, { incluirBordes: true, agrupar: false });
    let motivoBloques = bloques.length ? null : 'sin imágenes ubicables en la repisa';
    if (bloques.length >= productos.length) {
      // El recorte se ensancha para mostrar entero un producto que pisa el corte entre muebles.
      const x0 = Math.max(0, Math.min(seg.box.left, ...bloques.map((b) => b.x0)));
      const x1 = Math.min(dibujo.width, Math.max(seg.box.left + seg.box.width, ...bloques.map((b) => b.x1)));
      const boxBloques = escalarBox({ left: Math.floor(x0), top: seg.box.top, width: Math.ceil(x1 - Math.floor(x0)), height: seg.box.height }, f);
      boxBloques.width = Math.min(boxBloques.width, hiRes.width - boxBloques.left);
      const imagenJpeg = await drawing.recortarConBloques(hiRes.png, boxBloques, bloques.map((b) => escalarBloque(b, f)));
      await onRecorte?.({ bandeja: nivel.bandeja, metodo: 'BLOQUES' }, imagenJpeg);
      const r = await asignarBloques({ cfg, imagenJpeg, productos, bloques, fetchImpl, timeoutMs });
      nivel.orden_intentos = r.intentos;
      if (r.ok) {
        nivel.posiciones = r.asignacion.map((a, i) => {
          const pos = porId.get(a.id);
          const bs = bloques.slice(a.desde - 1, a.hasta);
          const x0 = Math.min(...bs.map((b) => b.x0)), x1 = Math.max(...bs.map((b) => b.x1));
          const y0 = Math.min(...bs.map((b) => b.y0)), y1 = Math.max(...bs.map((b) => b.y1));
          pos.shelfcolumn_id = i + 1;
          pos.bloques = [a.desde, a.hasta];
          pos.orden_confianza = a.confianza;
          pos.bbox = { x: r4(x0 / dibujo.width), y: r4(y0 / dibujo.height), w: r4((x1 - x0) / dibujo.width), h: r4((y1 - y0) / dibujo.height) };
          return pos;
        });
        const conf = { ALTA: 0, MEDIA: 0, BAJA: 0 };
        r.asignacion.forEach((a) => { conf[a.confianza]++; });
        Object.assign(nivel, { orden_fuente: 'IA', orden_metodo: 'BLOQUES', orden_estado: conf.BAJA ? 'REVISAR' : 'OK', orden_confianza: conf, bloques_total: bloques.length, bloques_sobrantes: r.sobrantes });
        if (conf.BAJA) nivel.orden_motivo = `${conf.BAJA} producto(s) que el modelo no reconoció en ningún bloque`;
        else delete nivel.orden_motivo;
        avisar();
        return;
      }
      motivoBloques = r.motivo;
    } else if (bloques.length) {
      motivoBloques = `${bloques.length} bloques para ${productos.length} productos`;
    }

    // 2) LIBRE (respaldo)
    const imagenJpeg = await drawing.recortarSegmento(hiRes.png, boxHi);
    await onRecorte?.({ bandeja: nivel.bandeja, metodo: 'LIBRE' }, imagenJpeg);
    const r = await ordenarRepisa({ cfg, imagenJpeg, productos, fetchImpl, timeoutMs });
    nivel.orden_intentos = (nivel.orden_intentos ?? 0) + r.intentos;
    if (!r.ok) { marcarRevisar(nivel, `IA: ${r.motivo}${motivoBloques ? ` (bloques: ${motivoBloques})` : ''}`); nivel.orden_metodo = 'LIBRE'; avisar(); return; }
    nivel.posiciones = r.orden.map((o, i) => {
      const pos = porId.get(o.id);
      pos.shelfcolumn_id = i + 1;
      pos.bbox = tramoValido(o) ? {
        x: r4((seg.box.left + o.x_inicio * seg.box.width) / dibujo.width),
        y: r4(seg.box.top / dibujo.height),
        w: r4(((o.x_fin - o.x_inicio) * seg.box.width) / dibujo.width),
        h: r4(seg.box.height / dibujo.height),
      } : null;
      return pos;
    });
    // LIBRE es menos preciso: queda marcado para revisar siempre.
    Object.assign(nivel, { orden_fuente: 'IA', orden_metodo: 'LIBRE', orden_estado: 'REVISAR', orden_motivo: `Ordenado sin bloques${motivoBloques ? ` (${motivoBloques})` : ''}` });
    avisar();
  });

  return fin(dibujo, deteccion);
}

module.exports = { ordenarPropuesta, ordenarRepisa, asignarBloques, validarPermutacion, validarCandidatos, resolverAsignacion, hungaro, configOpenAI, esquemaBloques, esquemaLibre };
