const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const enterpriseRepo     = require('../repositories/enterpriseRepo');
const userRepo           = require('../repositories/userRepo');
const userEnterpriseRepo = require('../repositories/userEnterpriseRepo');
const roleRepo           = require('../repositories/roleRepo');

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

  // ───── Validación de campos obligatorios ─────
  // adminName y adminEmail ahora son SIEMPRE requeridos
  const required = {
    fiscalId, enterpriseDsc, country, state, county, city,
    telephone, address, invoiceMail, contact, contactMail, contactPhone, type,
    adminCedula, adminName, adminEmail,
  };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    throw serviceError(`Campos requeridos faltantes: ${missing.join(', ')}`, 400);
  }

  if (!VALID_TYPES.includes(type)) {
    throw serviceError(`El campo type debe ser uno de: ${VALID_TYPES.join(', ')}`, 400);
  }

  // ───── Fail-fast: verificar duplicados ANTES de cualquier insert ─────

  // 1. Empresa: fiscalId único
  if (await enterpriseRepo.findByFiscalId(fiscalId)) {
    throw serviceError('Ya existe una empresa registrada con ese fiscalId', 409);
  }

  // 2. Email único en RETSC_OP_USERS
  //    (puede pertenecer al mismo usuario que estamos reactivando — lo validamos abajo)
  const userByEmail = await userRepo.findByEmail(adminEmail);

  // 3. Cédula: si existe, no debe tener relaciones activas
  const userByCedula = await userRepo.findByCedula(adminCedula);

  if (userByCedula) {
    const activeRelations = await userEnterpriseRepo.findActiveByUserId(userByCedula.User_id);
    if (activeRelations.length > 0) {
      throw serviceError(
        'El administrador con esa cédula ya tiene una empresa activa asignada. Debe ser desactivado en su empresa anterior antes de registrarlo en una nueva.',
        409
      );
    }
  }

  // 4. Si el email ya existe, debe pertenecer al MISMO usuario (cédula).
  //    Si pertenece a otro usuario distinto, lo rechazamos.
  if (userByEmail && (!userByCedula || userByEmail.User_id !== userByCedula.User_id)) {
    throw serviceError('Ya existe un usuario con ese email en el sistema', 409);
  }

  // ───── Fail-fast: rol Admin debe existir antes de tocar nada ─────
  const adminRole = await roleRepo.findByName('Admin');
  if (!adminRole) {
    throw serviceError('Rol "Admin" no encontrado. Verifique que el seed se ejecutó correctamente.', 500);
  }

  // ───── Crear o actualizar usuario admin ─────
  let user = userByCedula;
  let isNewUser = false;
  let generatedPassword = null;
  let insertedUserId = null;
  let updatedExistingUser = false;

  if (!user) {
    // Caso A: usuario nuevo
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
  } else {
    // Caso B: usuario existente sin relaciones activas → reactivación con nuevos datos de trabajo
    generatedPassword = generatePassword();
    const passwordHash = await bcrypt.hash(generatedPassword, 10);
    const updated = await userRepo.update(user.User_id, {
      User_name:    adminName,
      Email:        adminEmail,
      PasswordHash: passwordHash,
      Status:       1,
    });
    user = updated || user;
    updatedExistingUser = true;
    isNewUser = true; // semánticamente "nuevo" porque entrega un password fresco
  }

  // ───── Insertar empresa ─────
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

  // ───── Insertar relación usuario-empresa ─────
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
    enterpriseId:        insertedEnterprise.Enterprise_id,
    userId:              user.User_id,
    isNewUser,
    updatedExistingUser, // true cuando reactivamos un usuario existente
    generatedPassword,
  };
};

module.exports = { registerEnterprise };