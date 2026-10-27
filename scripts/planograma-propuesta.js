// Ciclo 5 · B3 (Fase 8.2–8.5) — Prueba de punta a punta de la interpretación de un PDF de
// planograma, SIN guardar nada (no crea planograma, no escribe en BD ni en Blob).
// Primero detecta el formato (planogramInterpretService.detectarFormato):
//
//   LISTA_BANDEJAS (Automercado): PDF → lista de productos (8.2) → SKU por UPC contra
//       RETSC_OP_SKUS (8.3, SOLO LECTURA) → bandeja → mueble/fila (8.4) → orden con IA (8.5)
//   SPACE_PLANNING: PDF → códigos de cadena por fila y posición (sin IA, sin BD)
//
// Salida (carpeta --salida, por defecto la del PDF):
//   propuesta.json          → el JSON que verá la pantalla de revisión (8.7)
//   propuesta-dibujo.png    → el dibujo con cada producto enmarcado y numerado (columna)
//                             verde = OK · naranja = SKU no está en catálogo · rojo = repisa a revisar
//   recortes/bandeja-N.jpg  → (con --recortes) la imagen que vio el modelo, con los bloques B1…Bn
//
// Uso (desde la raíz de Back End, con .env de QA: BD + AZURE_OPENAI_* + AZURE_OPENAI_CHAT_DEPLOYMENT):
//   node scripts/planograma-propuesta.js "../Automercado Desodorantes pro.plnx.pdf" --salida ../B0
//   node scripts/planograma-propuesta.js "<pdf>" --sin-ia     → solo 8.2–8.4 (no llama al modelo)
//   node scripts/planograma-propuesta.js "<pdf>" --salida ../B0 --recortes   → + imágenes enviadas al modelo
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { leerPlanogramaPdf } = require('../src/services/planogramPdfService');
const { construirPropuestaBase } = require('../src/services/planogramProposalService');
const { ordenarPropuesta } = require('../src/services/planogramOrderService');
const { detectarFormato } = require('../src/services/planogramInterpretService');
const { construirPropuestaSpacePlanning } = require('../src/services/planogramSpacePlanningService');
const { renderDibujo } = require('../src/services/planogramDrawingService');

const args = process.argv.slice(2);
const pdfPath = args.find((a) => !a.startsWith('--'));
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
if (!pdfPath || !fs.existsSync(pdfPath)) {
  console.error('Uso: node scripts/planograma-propuesta.js "<archivo.pdf>" [--salida <carpeta>] [--sin-ia] [--recortes]');
  process.exit(1);
}
const salida = opt('--salida') || path.dirname(pdfPath);

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

async function dibujoConCajas(png, propuesta) {
  const { width: W, height: H } = await sharp(png).metadata();
  const rects = [];
  for (const m of propuesta.muebles) for (const n of m.niveles) for (const p of n.posiciones) {
    if (!p.bbox) continue;
    const x = p.bbox.x * W, y = p.bbox.y * H, w = p.bbox.w * W, h = p.bbox.h * H;
    const color = n.orden_estado === 'REVISAR' ? '#e00000' : p.sku_id ? '#00a000' : '#ff8c00';
    rects.push(`<rect x="${x + 1}" y="${y + 1}" width="${Math.max(w - 2, 1)}" height="${h - 2}" fill="none" stroke="${color}" stroke-width="3"/>`);
    rects.push(`<rect x="${x + 2}" y="${y + 2}" width="34" height="26" fill="${color}"/><text x="${x + 19}" y="${y + 21}" font-size="20" font-family="Arial" font-weight="bold" fill="#fff" text-anchor="middle">${p.shelfcolumn_id}</text>`);
  }
  // Etiqueta por repisa: M<mueble> F<fila> B<bandeja> + fuente del orden.
  for (const m of propuesta.muebles) for (const n of m.niveles) {
    const b = n.posiciones.find((p) => p.bbox)?.bbox;
    if (!b) continue;
    // Sobre la barra negra de la repisa (debajo de los productos), en blanco.
    rects.push(`<text x="${b.x * W + 6}" y="${(b.y + b.h) * H + 17}" font-size="16" font-family="Arial" fill="#ffffff" stroke="#000" stroke-width="0.6" font-weight="bold">${esc(`M${m.shelfunit_id} F${n.shelflevel_id}${n.bandeja ? ` B${n.bandeja}` : ''} · ${n.orden_fuente}`)}</text>`);
  }
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${rects.join('')}</svg>`);
  return sharp(png).composite([{ input: svg }]).png().toBuffer();
}

(async () => {
  const pdfBuffer = fs.readFileSync(pdfPath);
  console.log(`PDF: ${pdfPath}`);
  const formato = await detectarFormato(pdfBuffer);
  console.log(`Formato: ${formato ?? 'NO RECONOCIDO'}`);
  if (!formato) process.exit(2);

  if (formato === 'SPACE_PLANNING') {
    const propuesta = await construirPropuestaSpacePlanning({ buffer: pdfBuffer });
    console.log(`Planograma: ${propuesta.fuente.titulos.join(' · ')} · archivo ${propuesta.fuente.archivo} · impreso ${propuesta.fuente.fecha}`);
    console.log(`${propuesta.resumen.posiciones} posiciones · ${propuesta.regla_bandejas.muebles} mueble(s) × ${propuesta.regla_bandejas.niveles_por_mueble} filas\n`);
    for (const m of propuesta.muebles) for (const n of m.niveles) {
      console.log(`   Mueble ${m.shelfunit_id} · Fila ${n.shelflevel_id} (${n.posiciones.length}): ${n.posiciones.map((p) => p.codigo_cadena).join(' ')}`);
    }
    if (propuesta.advertencias.length) console.log('Advertencias:\n - ' + propuesta.advertencias.join('\n - '));
    fs.mkdirSync(salida, { recursive: true });
    fs.writeFileSync(path.join(salida, 'propuesta.json'), JSON.stringify(propuesta, null, 2));
    fs.writeFileSync(path.join(salida, 'propuesta-dibujo.png'), await dibujoConCajas((await renderDibujo(pdfBuffer)).png, propuesta));
    console.log(`\n→ ${path.join(salida, 'propuesta.json')}\n→ ${path.join(salida, 'propuesta-dibujo.png')}`);
    process.exit(0);
  }

  const pdf = await leerPlanogramaPdf(pdfBuffer);
  console.log(`8.2 · ${pdf.resumen.productos} productos, ${pdf.resumen.frentes} frentes, bandejas ${pdf.resumen.bandejas.join(',')}`);

  const propuesta = await construirPropuestaBase({ pdf });
  const r = propuesta.resumen;
  console.log(`8.3 · SKU por UPC: ${r.ean_exacto}/${r.posiciones} encontrados (${JSON.stringify(r.detalle_match)})`);
  console.log(`8.4 · ${propuesta.regla_bandejas.muebles} muebles × ${propuesta.regla_bandejas.niveles_por_mueble} filas`);

  let dibujoPng = null;
  if (!flag('--sin-ia')) {
    const t0 = Date.now();
    const dirRecortes = path.join(salida, 'recortes');
    if (flag('--recortes')) fs.mkdirSync(dirRecortes, { recursive: true });
    console.log('8.5 · ordenando repisas con IA…');
    ({ dibujoPng } = await ordenarPropuesta({
      propuesta,
      pdfBuffer,
      onRepisa: (r) => console.log(`   ${r.estado === 'OK' ? '✓' : '⚠'} Mueble ${r.mueble} · Fila ${r.fila} (bandeja ${r.bandeja}) · ${r.metodo ?? '-'} · ${r.segundos.toFixed(1)} s${r.motivo ? ` — ${r.motivo}` : ''}`),
      onRecorte: flag('--recortes') ? (r, jpg) => fs.writeFileSync(path.join(dirRecortes, `bandeja-${String(r.bandeja).padStart(2, '0')}-${r.metodo.toLowerCase()}.jpg`), jpg) : null,
    }));
    const o = propuesta.resumen.orden;
    console.log(`8.5 · ${o.ordenados_ia}/${o.niveles} repisas ordenadas con IA (${o.por_bloques} por bloques), ${o.a_revisar} a revisar (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    console.log(`      confianza por producto: ${o.confianza.ALTA} ALTA · ${o.confianza.MEDIA} MEDIA (?) · ${o.confianza.BAJA} BAJA (!)\n`);
    for (const m of propuesta.muebles) for (const n of m.niveles) {
      const marca = n.orden_estado === 'REVISAR' ? '⚠' : '✓';
      const sobran = n.bloques_sobrantes?.length ? ` · bloques sin producto: ${n.bloques_sobrantes.map((b) => `B${b}`).join(',')}` : '';
      console.log(`   ${marca} Mueble ${m.shelfunit_id} · Fila ${n.shelflevel_id} (bandeja ${n.bandeja}) · ${n.orden_fuente}/${n.orden_metodo ?? '-'}${sobran}`);
      console.log(`      ${n.posiciones.map((p) => `${p.shelfcolumn_id}.${p.bloques ? `[B${p.bloques[0]}${p.bloques[1] !== p.bloques[0] ? `-${p.bloques[1]}` : ''}]` : ''}${{ MEDIA: '?', BAJA: '!' }[p.orden_confianza] ?? ''}${p.texto_leido.slice(0, 22)}`).join(' | ')}`);
    }
  }
  if (propuesta.advertencias.length) console.log('Advertencias:\n - ' + propuesta.advertencias.join('\n - '));

  fs.mkdirSync(salida, { recursive: true });
  fs.writeFileSync(path.join(salida, 'propuesta.json'), JSON.stringify(propuesta, null, 2));
  console.log(`\n→ ${path.join(salida, 'propuesta.json')}`);
  if (dibujoPng) {
    fs.writeFileSync(path.join(salida, 'propuesta-dibujo.png'), await dibujoConCajas(dibujoPng, propuesta));
    console.log(`→ ${path.join(salida, 'propuesta-dibujo.png')}`);
  }
  process.exit(0);
})().catch((e) => { console.error('ERROR:', e); process.exit(1); });
