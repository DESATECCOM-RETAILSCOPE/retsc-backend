require('dotenv').config();
const sql = require('mssql');

console.log('Probando conexión con:');
console.log('  Server  :', process.env.SQL_SERVER);
console.log('  Database:', process.env.SQL_DATABASE);
console.log('  User    :', process.env.SQL_USER);
console.log('  Password:', process.env.SQL_PASSWORD ? `"${process.env.SQL_PASSWORD}" (${process.env.SQL_PASSWORD.length} chars)` : 'NO DEFINIDA');

sql.connect({
  server:   process.env.SQL_SERVER,
  port:     parseInt(process.env.SQL_PORT) || 1433,
  user:     process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  database: process.env.SQL_DATABASE,
  options:  { encrypt: true, trustServerCertificate: false },
}).then(() => {
  console.log('\n✅ Conexión exitosa');
  process.exit(0);
}).catch(err => {
  console.log('\n❌ Falló:', err.message);
  process.exit(1);
});
