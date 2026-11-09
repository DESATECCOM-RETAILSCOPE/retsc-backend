// Ciclo 5 · B3 — Utilidades de códigos de barras (GTIN: EAN-8, UPC-A/EAN-12, EAN-13, GTIN-14).
//
// Hallazgo de B0 (planograma Automercado Desodorantes): el programa de planimetría exporta
// muchos códigos SIN el dígito verificador (7, 11 y 12 dígitos), y el catálogo
// (RETSC_OP_SKUS.EAN) a veces guarda el código con ceros a la izquierda. Verificado: en los 14
// casos "sin verificador" el EAN del catálogo es exactamente el código + su verificador GTIN.

const onlyDigits = (s) => String(s ?? '').replace(/\D/g, '');
const stripZeros = (s) => onlyDigits(s).replace(/^0+/, '');

// Dígito verificador GTIN (módulo 10, pesos 3-1 desde la derecha) para un cuerpo sin verificador.
function checkDigit(body) {
  const d = onlyDigits(body).split('').reverse().map(Number);
  const sum = d.reduce((acc, n, i) => acc + n * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10;
}

// ¿El código (con su último dígito como verificador) es un GTIN válido?
function isValidGtin(code) {
  const c = onlyDigits(code);
  if (![8, 12, 13, 14].includes(c.length)) return false;
  return checkDigit(c.slice(0, -1)) === Number(c.at(-1));
}

// Candidatos para buscar un código del planograma en el catálogo, en orden de preferencia:
//   1. tal cual                          → match EXACTO
//   2. sin ceros a la izquierda           → match SIN_CEROS
//   3. + dígito verificador calculado     → match SIN_VERIFICADOR (el PDF lo omitió)
// Cada candidato se compara contra el EAN del catálogo SIN ceros a la izquierda.
function lookupCandidates(code) {
  const raw = onlyDigits(code);
  if (!raw) return [];
  const out = [{ key: stripZeros(raw), tipo: 'EXACTO' }];
  const withCheck = raw + checkDigit(raw);
  if (raw.length <= 13) out.push({ key: stripZeros(withCheck), tipo: 'SIN_VERIFICADOR' });
  return out;
}

// Variantes con ceros a la izquierda para un WHERE EAN IN (...) — el catálogo guarda a veces
// '0099176370659' para el código 99176370659.
function dbVariants(code) {
  const k = stripZeros(code);
  if (!k) return [];
  return [...new Set([k, k.padStart(8, '0'), k.padStart(12, '0'), k.padStart(13, '0'), k.padStart(14, '0')])]
    .filter((v) => v.length <= 18);
}

module.exports = { onlyDigits, stripZeros, checkDigit, isValidGtin, lookupCandidates, dbVariants };
