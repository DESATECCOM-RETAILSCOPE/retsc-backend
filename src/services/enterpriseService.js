const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const enterpriseRepo    = require('../repositories/enterpriseRepo');
const userRepo          = require('../repositories/userRepo');
const userEnterpriseRepo = require('../repositories/userEnterpriseRepo');
const roleRepo          = require('../repositories/roleRepo');

const VALID_TYPES = ['Proveedor', 'Detallista', 'Empresa de servicios'];

function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(16);
  let pwd = '';
  for (let i = 0; i < 8; i++) pwd += chars[bytes[i] % chars.length];
  return pwd;
}

function serviceError(msg, statusCode) {
  const err = new Error(msg);
  err.statusCode = statusCode;
  return err;
}

const registerEnterprise = async (payload) => {
  const {
    fiscalId, enterpriseDsc, country, state, county, city,
    telephone, address, invoiceMail, contact, contactMail, contactPhone, type,
    adminCedula, adminName, adminEmail, adminPhone,
  } = payload;

  // Validar campos obligatorios
  const required = {
    fiscalId, enterpriseDsc, country, state, county, city,
    telephone, address, invoiceMail, contact, contactMail, contactPhone, type, adminCedula,
  };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    throw serviceError(`Campos requeridos faltantes: ${missing.join(', ')}`, 400);
  }

  if (!VALID_TYPES.includes(type)) {
    throw serviceError(`El campo type debe ser uno de: ${VALID_TYPES.join(', ')}`, 400);
  }

  // Verificar duplicado de fiscalId
  if (await enterpriseRepo.findByFiscalId(fiscalId)) {
    throw serviceError('Ya existe una empresa registrada con ese fiscalId', 409);
  }

  // Buscar o crear usuario administrador
  let user = await userRepo.findByCedula(adminCedula);
  let isNewUser = false;
  let generatedPassword = null;
  let insertedUserId = null;

  if (!user) {
    if (!adminName || !adminEmail) {
      throw serviceError('adminName y adminEmail son requeridos cuando el administrador no existe en el sistema', 400);
    }
    generatedPassword = generatePassword();
    const passwordHash = await bcrypt.hash(generatedPassword, 10);
    const inserted = await userRepo.insert({
      User_name:     adminName,
      Email:         adminEmail,
      PasswordHash:  passwordHash,
      ced_identidad: adminCedula,
      Status:        1,
      Created_date:  new Date().toISOString(),
    });
    user = inserted;
    insertedUserId = inserted.User_id;
    isNewUser = true;
  }

  // Insertar empresa
  let insertedEnterprise = null;
  try {
    insertedEnterprise = await enterpriseRepo.insert({
      Fiscal_id:      fiscalId,
      Enterprise_dsc: enterpriseDsc,
      Country:        country,
      State:          state,
      County:         county,
      City:           city,
      Telephone:      telephone,
      Address:        address,
      Invoice_mail:   invoiceMail,
      Contact:        contact,
      Contact_mail:   contactMail,
      Contact_phone:  contactPhone,
      Type:           type,
    });
  } catch (err) {
    if (insertedUserId) await userRepo.remove(insertedUserId).catch(() => {});
    throw err;
  }

  // Obtener rol Admin
  const adminRole = await roleRepo.findByName('Admin');
  if (!adminRole) {
    await enterpriseRepo.remove(insertedEnterprise.Enterprise_id).catch(() => {});
    if (insertedUserId) await userRepo.remove(insertedUserId).catch(() => {});
    throw serviceError('Rol "Admin" no encontrado. Verifique que el seed se ejecutó correctamente.', 500);
  }

  // Insertar relación usuario-empresa
  try {
    await userEnterpriseRepo.insert({
      User_id:            user.User_id,
      Enterprise_id:      insertedEnterprise.Enterprise_id,
      Role_id:            adminRole.Role_id,
      Status:             1,
      Fecha_activacion:   new Date().toISOString(),
      Fecha_inactivacion: null,
    });
  } catch (err) {
    await enterpriseRepo.remove(insertedEnterprise.Enterprise_id).catch(() => {});
    if (insertedUserId) await userRepo.remove(insertedUserId).catch(() => {});
    throw err;
  }

  return {
    enterpriseId:      insertedEnterprise.Enterprise_id,
    userId:            user.User_id,
    isNewUser,
    generatedPassword, // null si isNewUser === false
  };
};

module.exports = { registerEnterprise };
