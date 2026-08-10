const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const enterpriseRepo = require("../repositories/enterpriseRepo");
const userRepo = require("../repositories/userRepo");
const userEnterpriseRepo = require("../repositories/userEnterpriseRepo");
const roleRepo = require("../repositories/roleRepo");
const { isValidEmail, normalizeCedula, isValidCedulaFisica, isValidCedulaJuridica } = require("../utils/validators");
const { ROLES } = require("../config/roles");

const VALID_TYPES = ["Proveedor", "Detallista", "Empresa de servicios"];

function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(16);
  let pwd = "";
  for (let i = 0; i < 8; i++) pwd += chars[bytes[i] % chars.length];
  return pwd;
}

// extra (Issue B6): { field, errorCode } opcional — permite que el controller devuelva
// qué campo específico causó el error (sobre todo duplicados 409) sin que el frontend
// tenga que parsear el mensaje en español para saber qué input marcar.
function serviceError(msg, statusCode, extra) {
  const err = new Error(msg);
  err.statusCode = statusCode;
  if (extra) Object.assign(err, extra);
  return err;
}

// ────────────── Registro de empresa con admin (issue 1.1) ──────────────

const registerEnterprise = async (payload) => {
  const {
    fiscalId,
    enterpriseDsc,
    country,
    state,
    county,
    city,
    telephone,
    address,
    invoiceMail,
    contact,
    contactMail,
    contactPhone,
    type,
    adminCedula,
    adminName,
    adminEmail,
    adminPhone,
  } = payload;

  // ───── Validación de campos obligatorios ─────
  // adminName y adminEmail son SIEMPRE requeridos
  const required = {
    fiscalId,
    enterpriseDsc,
    country,
    state,
    county,
    city,
    telephone,
    address,
    invoiceMail,
    contact,
    contactMail,
    contactPhone,
    type,
    adminCedula,
    adminName,
    adminEmail,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw serviceError(
      `Campos requeridos faltantes: ${missing.join(", ")}`,
      400,
    );
  }

  if (!VALID_TYPES.includes(type)) {
    throw serviceError(
      `El campo type debe ser uno de: ${VALID_TYPES.join(", ")}`,
      400,
    );
  }

  if (!isValidEmail(invoiceMail)) throw serviceError('Formato de invoiceMail inválido', 400);
  if (!isValidEmail(contactMail)) throw serviceError('Formato de contactMail inválido', 400);
  if (!isValidEmail(adminEmail))  throw serviceError('Formato de adminEmail inválido', 400);
  if (!isValidCedulaJuridica(fiscalId)) {
    throw serviceError('La cédula jurídica debe tener 10 dígitos (formato Costa Rica).', 400);
  }
  if (!isValidCedulaFisica(adminCedula)) {
    throw serviceError('La cédula física del administrador debe tener 9 dígitos (formato Costa Rica).', 400);
  }

  // Normalizadas a solo dígitos — mismo criterio en toda la app (Issue B5),
  // así el chequeo de duplicados no falla por formato (guiones sí/no).
  const normalizedFiscalId = normalizeCedula(fiscalId);
  const normalizedAdminCedula = normalizeCedula(adminCedula);

  // ───── Fail-fast: verificar duplicados ANTES de cualquier insert ─────

  // 1. Empresa: fiscalId único
  if (await enterpriseRepo.findByFiscalId(normalizedFiscalId)) {
    throw serviceError(
      "Ya existe una empresa registrada con ese fiscalId",
      409,
      { field: 'fiscalId', errorCode: 'ERR_DUP_FISCAL_ID' },
    );
  }

  // 2. Email único en RETSC_OP_USERS
  //    (puede pertenecer al mismo usuario que estamos reactivando — lo validamos abajo)
  const userByEmail = await userRepo.findByEmail(adminEmail);

  // 3. Cédula: si existe, no debe tener relaciones activas
  const userByCedula = await userRepo.findByCedula(normalizedAdminCedula);

  if (userByCedula) {
    const activeRelations = await userEnterpriseRepo.findActiveByUserId(
      userByCedula.User_id,
    );
    if (activeRelations.length > 0) {
      throw serviceError(
        "El administrador con esa cédula ya tiene una empresa activa asignada. Debe ser desactivado en su empresa anterior antes de registrarlo en una nueva.",
        409,
        { field: 'adminCedula', errorCode: 'ERR_CEDULA_ACTIVE_ELSEWHERE' },
      );
    }
  }

  // 4. Si el email ya existe, debe pertenecer al MISMO usuario (cédula).
  //    Si pertenece a otro usuario distinto, lo rechazamos.
  if (
    userByEmail &&
    (!userByCedula || userByEmail.User_id !== userByCedula.User_id)
  ) {
    throw serviceError(
      "Ya existe un usuario con ese email en el sistema",
      409,
      { field: 'adminEmail', errorCode: 'ERR_DUP_EMAIL' },
    );
  }

  // ───── Fail-fast: rol Admin debe existir antes de tocar nada ─────
  const adminRole = await roleRepo.findByName(ROLES.ADMIN);
  if (!adminRole) {
    throw serviceError(
      `Rol "${ROLES.ADMIN}" no encontrado. Verifique que el seed se ejecutó correctamente.`,
      500,
    );
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
      User_name: adminName,
      Email: adminEmail,
      PasswordHash: passwordHash,
      ced_identidad: normalizedAdminCedula,
      Status: 1,
      Created_date: new Date().toISOString(),
    });
    user = inserted;
    insertedUserId = inserted.User_id;
    isNewUser = true;
  } else {
    // Caso B: usuario existente sin relaciones activas → reactivación con nuevos datos de trabajo
    generatedPassword = generatePassword();
    const passwordHash = await bcrypt.hash(generatedPassword, 10);
    const updated = await userRepo.update(user.User_id, {
      User_name: adminName,
      Email: adminEmail,
      PasswordHash: passwordHash,
      Status: 1,
    });
    user = updated || user;
    updatedExistingUser = true;
    isNewUser = true; // semánticamente "nuevo" porque entrega un password fresco
  }

  // ───── Insertar empresa ─────
  let insertedEnterprise = null;
  try {
    insertedEnterprise = await enterpriseRepo.insert({
      Fiscal_id: normalizedFiscalId,
      Enterprise_dsc: enterpriseDsc,
      Country: country,
      State: state,
      County: county,
      City: city,
      Telephone: telephone,
      Address: address,
      Invoice_mail: invoiceMail,
      Contact: contact,
      Contact_mail: contactMail,
      Contact_phone: contactPhone,
      Type: type,
    });
  } catch (err) {
    if (insertedUserId) await userRepo.remove(insertedUserId).catch(() => {});
    throw err;
  }

  // ───── Insertar relación usuario-empresa ─────
  try {
    await userEnterpriseRepo.insert({
      User_id: user.User_id,
      Enterprise_id: insertedEnterprise.Enterprise_id,
      Role_id: adminRole.Role_id,
      Status: 1,
      Fecha_activacion: new Date().toISOString(),
      Fecha_inactivacion: null,
    });
  } catch (err) {
    await enterpriseRepo
      .remove(insertedEnterprise.Enterprise_id)
      .catch(() => {});
    if (insertedUserId) await userRepo.remove(insertedUserId).catch(() => {});
    throw err;
  }

  return {
    enterpriseId: insertedEnterprise.Enterprise_id,
    userId: user.User_id,
    isNewUser,
    updatedExistingUser, // true cuando reactivamos un usuario existente
    generatedPassword,
  };
};

// ────────────── CRUD de empresas (issue 2.2) ──────────────

function toDTO(row, activeUsersCount = undefined) {
  const dto = {
    enterpriseId: row.Enterprise_id,
    fiscalId: row.Fiscal_id,
    enterpriseDsc: row.Enterprise_dsc,
    country: row.Country,
    state: row.State,
    county: row.County,
    city: row.City,
    telephone: row.Telephone,
    address: row.Address,
    invoiceMail: row.Invoice_mail,
    contact: row.Contact,
    contactMail: row.Contact_mail,
    contactPhone: row.Contact_phone,
    type: row.Type,
    status: row.status ? 1 : 0,
  };
  if (activeUsersCount !== undefined) dto.activeUsersCount = activeUsersCount;
  return dto;
}

const listAll = async () => {
  const enterprises = await enterpriseRepo.listAll();
  return Promise.all(
    enterprises.map(async (e) => {
      const relations = await userEnterpriseRepo.findByEnterprise(
        e.Enterprise_id,
      );
      const activeUsersCount = relations.filter((r) => !!r.Status).length;
      return toDTO(e, activeUsersCount);
    }),
  );
};

const findById = async (enterpriseId) => {
  const e = await enterpriseRepo.findById(enterpriseId);
  if (!e) throw serviceError("Empresa no encontrada", 404);
  const relations = await userEnterpriseRepo.findByEnterprise(e.Enterprise_id);
  const activeUsersCount = relations.filter((r) => !!r.Status).length;
  return toDTO(e, activeUsersCount);
};

const createEnterprise = async (payload) => {
  const {
    fiscalId,
    enterpriseDsc,
    country,
    state,
    county,
    city,
    telephone,
    address,
    invoiceMail,
    contact,
    contactMail,
    contactPhone,
    type,
  } = payload;

  const required = {
    fiscalId,
    enterpriseDsc,
    country,
    state,
    county,
    city,
    telephone,
    address,
    invoiceMail,
    contact,
    contactMail,
    contactPhone,
    type,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0)
    throw serviceError(
      `Campos requeridos faltantes: ${missing.join(", ")}`,
      400,
    );

  if (!VALID_TYPES.includes(type)) {
    throw serviceError(
      `El campo type debe ser uno de: ${VALID_TYPES.join(", ")}`,
      400,
    );
  }

  if (!isValidEmail(invoiceMail)) throw serviceError('Formato de invoiceMail inválido', 400);
  if (!isValidEmail(contactMail)) throw serviceError('Formato de contactMail inválido', 400);
  if (!isValidCedulaJuridica(fiscalId)) {
    throw serviceError('La cédula jurídica debe tener 10 dígitos (formato Costa Rica).', 400);
  }

  const normalizedFiscalId = normalizeCedula(fiscalId);
  if (await enterpriseRepo.findByFiscalId(normalizedFiscalId)) {
    throw serviceError(
      "Ya existe una empresa registrada con ese fiscalId",
      409,
      { field: 'fiscalId', errorCode: 'ERR_DUP_FISCAL_ID' },
    );
  }

  const inserted = await enterpriseRepo.insert({
    Fiscal_id: normalizedFiscalId,
    Enterprise_dsc: enterpriseDsc,
    Country: country,
    State: state,
    County: county,
    City: city,
    Telephone: telephone,
    Address: address,
    Invoice_mail: invoiceMail,
    Contact: contact,
    Contact_mail: contactMail,
    Contact_phone: contactPhone,
    Type: type,
  });

  return toDTO(inserted, 0);
};

const updateEnterprise = async (enterpriseId, payload) => {
  const existing = await enterpriseRepo.findById(enterpriseId);
  if (!existing) throw serviceError("Empresa no encontrada", 404);

  if (payload.fiscalId !== undefined) {
    throw serviceError("El fiscalId no puede modificarse", 400);
  }

  if (payload.type !== undefined && !VALID_TYPES.includes(payload.type)) {
    throw serviceError(
      `El campo type debe ser uno de: ${VALID_TYPES.join(", ")}`,
      400,
    );
  }

  if (payload.invoiceMail !== undefined && !isValidEmail(payload.invoiceMail))
    throw serviceError('Formato de invoiceMail inválido', 400);
  if (payload.contactMail !== undefined && !isValidEmail(payload.contactMail))
    throw serviceError('Formato de contactMail inválido', 400);

  const partial = {};
  if (payload.enterpriseDsc !== undefined)
    partial.Enterprise_dsc = payload.enterpriseDsc;
  if (payload.country !== undefined) partial.Country = payload.country;
  if (payload.state !== undefined) partial.State = payload.state;
  if (payload.county !== undefined) partial.County = payload.county;
  if (payload.city !== undefined) partial.City = payload.city;
  if (payload.telephone !== undefined) partial.Telephone = payload.telephone;
  if (payload.address !== undefined) partial.Address = payload.address;
  if (payload.invoiceMail !== undefined)
    partial.Invoice_mail = payload.invoiceMail;
  if (payload.contact !== undefined) partial.Contact = payload.contact;
  if (payload.contactMail !== undefined)
    partial.Contact_mail = payload.contactMail;
  if (payload.contactPhone !== undefined)
    partial.Contact_phone = payload.contactPhone;
  if (payload.type !== undefined) partial.Type = payload.type;
  if (payload.status !== undefined) partial.Status = payload.status ? 1 : 0;

  if (Object.keys(partial).length === 0) return toDTO(existing);

  const updated = await enterpriseRepo.update(enterpriseId, partial);
  return toDTO(updated ?? existing);
};

module.exports = {
  registerEnterprise,
  listAll,
  findById,
  createEnterprise,
  updateEnterprise,
};
