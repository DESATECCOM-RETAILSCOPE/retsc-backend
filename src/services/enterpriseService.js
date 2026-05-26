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
    throw serviceError('Rol "Admin" no encontrado en la base de datos.', 500);
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

function toDTO(row, activeUsersCount = undefined) {
  const dto = {
    enterpriseId:  row.Enterprise_id,
    fiscalId:      row.Fiscal_id,
    enterpriseDsc: row.Enterprise_dsc,
    country:       row.Country,
    state:         row.State,
    county:        row.County,
    city:          row.City,
    telephone:     row.Telephone,
    address:       row.Address,
    invoiceMail:   row.Invoice_mail,
    contact:       row.Contact,
    contactMail:   row.Contact_mail,
    contactPhone:  row.Contact_phone,
    type:          row.Type,
  };
  if (activeUsersCount !== undefined) dto.activeUsersCount = activeUsersCount;
  return dto;
}

const listAll = async () => {
  const enterprises = await enterpriseRepo.listAll();
  return Promise.all(
    enterprises.map(async (e) => {
      const relations = await userEnterpriseRepo.findByEnterprise(e.Enterprise_id);
      const activeUsersCount = relations.filter(r => r.Status === 1).length;
      return toDTO(e, activeUsersCount);
    })
  );
};

const findById = async (enterpriseId) => {
  const e = await enterpriseRepo.findById(enterpriseId);
  if (!e) throw serviceError('Empresa no encontrada', 404);
  const relations = await userEnterpriseRepo.findByEnterprise(e.Enterprise_id);
  const activeUsersCount = relations.filter(r => r.Status === 1).length;
  return toDTO(e, activeUsersCount);
};

const createEnterprise = async (payload) => {
  const {
    fiscalId, enterpriseDsc, country, state, county, city,
    telephone, address, invoiceMail, contact, contactMail, contactPhone, type,
  } = payload;

  const required = {
    fiscalId, enterpriseDsc, country, state, county, city,
    telephone, address, invoiceMail, contact, contactMail, contactPhone, type,
  };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) throw serviceError(`Campos requeridos faltantes: ${missing.join(', ')}`, 400);

  if (!VALID_TYPES.includes(type)) {
    throw serviceError(`El campo type debe ser uno de: ${VALID_TYPES.join(', ')}`, 400);
  }

  if (await enterpriseRepo.findByFiscalId(fiscalId)) {
    throw serviceError('Ya existe una empresa registrada con ese fiscalId', 409);
  }

  const inserted = await enterpriseRepo.insert({
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

  return toDTO(inserted, 0);
};

const updateEnterprise = async (enterpriseId, payload) => {
  const existing = await enterpriseRepo.findById(enterpriseId);
  if (!existing) throw serviceError('Empresa no encontrada', 404);

  if (payload.fiscalId !== undefined) {
    throw serviceError('El fiscalId no puede modificarse', 400);
  }

  if (payload.type !== undefined && !VALID_TYPES.includes(payload.type)) {
    throw serviceError(`El campo type debe ser uno de: ${VALID_TYPES.join(', ')}`, 400);
  }

  const partial = {};
  if (payload.enterpriseDsc !== undefined) partial.Enterprise_dsc = payload.enterpriseDsc;
  if (payload.country       !== undefined) partial.Country        = payload.country;
  if (payload.state         !== undefined) partial.State          = payload.state;
  if (payload.county        !== undefined) partial.County         = payload.county;
  if (payload.city          !== undefined) partial.City           = payload.city;
  if (payload.telephone     !== undefined) partial.Telephone      = payload.telephone;
  if (payload.address       !== undefined) partial.Address        = payload.address;
  if (payload.invoiceMail   !== undefined) partial.Invoice_mail   = payload.invoiceMail;
  if (payload.contact       !== undefined) partial.Contact        = payload.contact;
  if (payload.contactMail   !== undefined) partial.Contact_mail   = payload.contactMail;
  if (payload.contactPhone  !== undefined) partial.Contact_phone  = payload.contactPhone;
  if (payload.type          !== undefined) partial.Type           = payload.type;

  if (Object.keys(partial).length === 0) return toDTO(existing);

  const updated = await enterpriseRepo.update(enterpriseId, partial);
  return toDTO(updated ?? existing);
};

module.exports = { registerEnterprise, listAll, findById, createEnterprise, updateEnterprise };
