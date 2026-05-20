const bcrypt = require('bcryptjs');
const fs = require('fs').promises;
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

async function writeJson(filename, data) {
  await fs.writeFile(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2), 'utf8');
}

async function main() {
  const now = new Date().toISOString();
  const passwordHash = await bcrypt.hash('demo1234', 10);

  await writeJson('users.json', [
    {
      User_id: 1,
      User_name: 'Admin Demo',
      Email: 'admin@retailscope.com',
      PasswordHash: passwordHash,
      Status: 1,
      Created_date: now,
      ced_identidad: '000000000',
    },
  ]);

  await writeJson('enterprises.json', [
    {
      Enterprise_id: 1,
      Fiscal_id: '3101000001',
      Enterprise_dsc: 'Empresa Demo',
      Country: 'Costa Rica',
      Telephone: '0000-0000',
      Address: 'San José',
      State: 'San José',
      County: 'San José',
      City: 'San José',
      Invoice_mail: 'facturacion@demo.com',
      Contact: 'Admin Demo',
      Contact_mail: 'admin@retailscope.com',
      Contact_phone: '0000-0000',
      Type: 'Detallista',
    },
  ]);

  await writeJson('usrsxenterp.json', [
    {
      Id: 1,
      User_id: 1,
      Enterprise_id: 1,
      Role_id: 1,
      Status: 1,
      Fecha_activacion: now,
      Fecha_inactivacion: null,
    },
  ]);

  console.log('Seed completado. Credenciales:');
  console.log('  Email:    admin@retailscope.com');
  console.log('  Password: demo1234');
}

main().catch(err => { console.error(err); process.exit(1); });
