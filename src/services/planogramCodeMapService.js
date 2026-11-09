// Ciclo 5 · B3 — Mapeo "código de la cadena → EAN" para planogramas que no traen UPC (formato
// SPACE_PLANNING: cada producto viene con el código interno de la cadena, ej. 460940).
//
// SIN migración: el mapeo es un archivo por empresa + cadena en el mismo contenedor de los
// planogramas: enterprise-planograms/_codigos-cadena/{enterpriseId}-{supermarketchainId}.json
//   { actualizado, usuario, archivo, total, codigos: { "460940": "7501234567890", … } }
// Lo carga el ADMIN de la empresa con un CSV (codigo,ean) desde la pantalla Planogramas. Cada
// empresa carga el suyo (el código es de la cadena, pero la lista la arma cada proveedor).
// Al (re)interpretar un PDF de esa cadena, el lector usa el mapeo para llegar al EAN y de ahí al
// SKU por el mismo camino que el formato con UPC (identificarPorCodigo).

const blobStorageService = require('./blobStorageService');

const CONTAINER = () => process.env.AZURE_PLANOGRAM_CONTAINER || 'enterprise-planograms';
const MAX_FILAS = 50000;
const rutaMapeo = (enterpriseId, chainId) => `_codigos-cadena/${Number(enterpriseId)}-${Number(chainId)}.json`;

function svcError(message, statusCode, errorCode, extra = {}) {
  return Object.assign(new Error(message), { statusCode, errorCode, ...extra });
}

// CSV/TXT → { codigos: {codigo: ean}, errores: [{ linea, texto, motivo }], filas }
// Acepta separador coma, punto y coma o tabulador; encabezado opcional (cualquier fila cuyo
// primer campo no sea numérico se toma como encabezado). Columnas: código de cadena, EAN/UPC.
function parsearCsv(texto) {
  const lineas = String(texto ?? '').replace(/^﻿/, '').split(/\r?\n/);
  const codigos = {};
  const errores = [];
  let filas = 0;
  lineas.forEach((raw, i) => {
    const linea = raw.trim();
    if (!linea) return;
    const campos = linea.split(/[;,\t]/).map((c) => c.trim().replace(/^"|"$/g, '').trim());
    if (i === 0 && !/^\d+$/.test(campos[0] ?? '')) return;            // encabezado
    filas++;
    if (filas > MAX_FILAS) { if (filas === MAX_FILAS + 1) errores.push({ linea: i + 1, texto: linea, motivo: `Más de ${MAX_FILAS} filas: se ignoró el resto` }); return; }
    const [codigo, ean] = campos;
    if (!/^\d{1,20}$/.test(codigo ?? '')) { errores.push({ linea: i + 1, texto: linea, motivo: 'El código de cadena debe ser numérico' }); return; }
    const eanLimpio = String(ean ?? '').replace(/\D/g, '');
    if (eanLimpio.length < 7 || eanLimpio.length > 14) { errores.push({ linea: i + 1, texto: linea, motivo: 'El EAN/UPC debe tener entre 7 y 14 dígitos' }); return; }
    if (codigos[codigo] && codigos[codigo] !== eanLimpio) errores.push({ linea: i + 1, texto: linea, motivo: `Código repetido con otro EAN (se usa el último: ${eanLimpio})` });
    codigos[codigo] = eanLimpio;
  });
  return { codigos, errores, filas };
}

async function leerMapeo(enterpriseId, chainId) {
  if (!enterpriseId || !chainId) return null;
  try {
    const buf = await blobStorageService.downloadFromContainer({ containerName: CONTAINER(), blobPath: rutaMapeo(enterpriseId, chainId) });
    return JSON.parse(buf.toString('utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.statusCode === 404 || err?.details?.errorCode === 'BlobNotFound') return null;
    throw err;
  }
}

async function guardarMapeo({ enterpriseId, chainId, buffer, nombreArchivo, userId }) {
  if (!enterpriseId) throw svcError('La sesión no tiene empresa asociada.', 400, 'ERR_SIN_EMPRESA');
  if (!Number(chainId)) throw svcError('La cadena es requerida.', 400, 'ERR_CAMPO_REQUERIDO');
  if (!buffer?.length) throw svcError('Se requiere el archivo CSV con los códigos.', 400, 'ERR_ARCHIVO_REQUERIDO');
  const { codigos, errores, filas } = parsearCsv(buffer.toString('utf8'));
  const total = Object.keys(codigos).length;
  if (!total) throw svcError('El archivo no trae ninguna fila válida (formato esperado: codigo,ean).', 400, 'ERR_MAPEO_VACIO', { errores: errores.slice(0, 50) });
  const doc = { actualizado: new Date().toISOString(), usuario: userId ?? null, archivo: nombreArchivo ?? null, total, codigos };
  await blobStorageService.ensureContainerExists(CONTAINER());
  await blobStorageService.uploadToContainer({
    containerName: CONTAINER(), blobPath: rutaMapeo(enterpriseId, chainId),
    buffer: Buffer.from(JSON.stringify(doc)), contentType: 'application/json',
  });
  return { total, filas, errores: errores.slice(0, 50), con_errores: errores.length, actualizado: doc.actualizado };
}

async function resumenMapeo(enterpriseId, chainId) {
  const doc = await leerMapeo(enterpriseId, chainId);
  return doc ? { existe: true, total: doc.total, actualizado: doc.actualizado, archivo: doc.archivo } : { existe: false, total: 0 };
}

module.exports = { parsearCsv, leerMapeo, guardarMapeo, resumenMapeo, rutaMapeo };
