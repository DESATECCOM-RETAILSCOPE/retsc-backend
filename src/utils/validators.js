const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_RE.test(email.trim());
}

// Cédulas de Costa Rica — física (persona) = 9 dígitos, jurídica (empresa) = 10.
// normalizeCedula quita guiones/espacios; usar SIEMPRE su resultado tanto para
// validar como para guardar en BD (Issue B5, feedback dueña) — así el chequeo
// de duplicados no falla porque una vez se tipeó con guiones y otra sin ellos.
function normalizeCedula(ced) {
  return String(ced ?? '').replace(/[-\s]/g, '');
}

function isValidCedulaFisica(ced) {
  return /^\d{9}$/.test(normalizeCedula(ced));
}

function isValidCedulaJuridica(ced) {
  return /^\d{10}$/.test(normalizeCedula(ced));
}

module.exports = { isValidEmail, normalizeCedula, isValidCedulaFisica, isValidCedulaJuridica };
