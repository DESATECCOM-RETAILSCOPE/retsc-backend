// Lectura de RETSC_CONFIG con cache corto en memoria — genérico, pensado para reusarse en
// cualquier config futura que viva en esa tabla, no solo SKU_MATCH_THRESHOLD (su primer
// consumidor, ver skuSearchService.js). No existía ningún helper de este tipo en el repo
// antes de este archivo.
//
// Cache simple por proceso (Map en memoria, TTL fijo) — no hay invalidación activa si
// alguien edita RETSC_CONFIG a mano; el valor viejo puede seguir sirviéndose hasta
// CACHE_TTL_MS después del cambio. Aceptable para un umbral de matching (no es una config
// de seguridad/permisos que necesite propagarse al instante).

const configRepo = require('../repositories/configRepo');

const CACHE_TTL_MS = 60_000;
const cache = new Map(); // clave -> { value, expiresAt }

// Devuelve el valor crudo (string) de una clave, o null si no existe la fila o falló la
// consulta (se trata igual — el caller decide el fallback). Nunca lanza.
async function getConfigValue(clave) {
  const cached = cache.get(clave);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let value = null;
  try {
    const row = await configRepo.findByKey(clave);
    value = row?.valor ?? null;
  } catch (err) {
    console.error(`[configService] error leyendo RETSC_CONFIG.${clave}:`, err.message);
  }

  cache.set(clave, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

// Lee un valor numérico con fallback y validación de rango. Normaliza coma decimal a punto
// (por si alguien edita RETSC_CONFIG a mano desde una herramienta en configuración regional
// ES, ej. Excel/SSMS con locale es-CR, que escribiría "0,85" en vez de "0.85").
async function getNumberConfig(clave, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = await getConfigValue(clave);
  if (raw == null) return fallback;

  const normalized = String(raw).trim().replace(',', '.');
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    console.warn(`[configService] valor inválido para ${clave}="${raw}" (esperaba número en [${min}, ${max}]) — usando fallback ${fallback}`);
    return fallback;
  }
  return parsed;
}

module.exports = { getConfigValue, getNumberConfig };
