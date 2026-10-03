// Token de corta duración para abrir el PDF de cumplimiento de surtido desde el navegador
// del sistema (Linking.openURL en el mobile no manda el header Authorization). Se firma con
// el mismo JWT_SECRET pero separado del JWT de sesión (7d) — este vive 5 minutos y solo
// sirve para este recurso puntual (purpose: 'compliance-report'), así no queda un token de
// sesión de larga vida flotando en el historial del navegador.

const jwt = require('jsonwebtoken');

const REPORT_TOKEN_TTL = process.env.REPORT_TOKEN_EXPIRES_IN || '5m';
const PURPOSE = 'compliance-report';

function mintReportToken({ visitId, categoryId, enterpriseId }) {
  return jwt.sign(
    { purpose: PURPOSE, visitId, categoryId, enterpriseId },
    process.env.JWT_SECRET,
    { expiresIn: REPORT_TOKEN_TTL }
  );
}

function verifyReportToken(token) {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  if (decoded.purpose !== PURPOSE) {
    throw Object.assign(new Error('Token inválido para este recurso.'), { statusCode: 401 });
  }
  return decoded;
}

module.exports = { mintReportToken, verifyReportToken };
