const { getPool, sql } = require('../config/db');

const TABLE = 'RETSC_OP_ENTERPRISE';

const findById = async (id) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('id', sql.Int, id)
    .query(`SELECT * FROM ${TABLE} WHERE Enterprise_id = @id`);
  return r.recordset[0] ?? null;
};

const findByFiscalId = async (fiscalId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('fiscalId', sql.VarChar(50), fiscalId)
    .query(`SELECT * FROM ${TABLE} WHERE Fiscal_id = @fiscalId`);
  return r.recordset[0] ?? null;
};

const listAll = async () => {
  const pool = await getPool();
  const r = await pool.request().query(`SELECT * FROM ${TABLE}`);
  return r.recordset;
};

// Enterprises the given user is actively linked to, via the bridge table.
const listByUser = async (userId) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .query(`
      SELECT e.* FROM ${TABLE} e
      INNER JOIN RETSC_OP_USRSXENTERP ux ON ux.Enterprise_id = e.Enterprise_id
      WHERE ux.User_id = @userId AND ux.Status = 1
    `);
  return r.recordset;
};

const insert = async (enterprise) => {
  const pool = await getPool();
  const r = await pool.request()
    .input('fiscalId',      sql.VarChar(50),  enterprise.Fiscal_id)
    .input('dsc',           sql.NVarChar(200), enterprise.Enterprise_dsc)
    .input('country',       sql.NVarChar(100), enterprise.Country)
    .input('state',         sql.NVarChar(100), enterprise.State)
    .input('county',        sql.NVarChar(100), enterprise.County)
    .input('city',          sql.NVarChar(100), enterprise.City)
    .input('telephone',     sql.VarChar(30),   enterprise.Telephone)
    .input('address',       sql.NVarChar(300), enterprise.Address)
    .input('invoiceMail',   sql.VarChar(120),  enterprise.Invoice_mail)
    .input('contact',       sql.NVarChar(200), enterprise.Contact)
    .input('contactMail',   sql.VarChar(120),  enterprise.Contact_mail)
    .input('contactPhone',  sql.VarChar(30),   enterprise.Contact_phone)
    .input('type',          sql.VarChar(50),   enterprise.Type)
    .query(`
      INSERT INTO ${TABLE}
        (Fiscal_id, Enterprise_dsc, Country, State, County, City, Telephone, Address,
         Invoice_mail, Contact, Contact_mail, Contact_phone, Type)
      OUTPUT INSERTED.*
      VALUES
        (@fiscalId, @dsc, @country, @state, @county, @city, @telephone, @address,
         @invoiceMail, @contact, @contactMail, @contactPhone, @type)
    `);
  return r.recordset[0];
};

const update = async (id, partial) => {
  const pool = await getPool();
  const req = pool.request().input('id', sql.Int, id);
  const set = [];

  if (partial.Enterprise_dsc !== undefined) { req.input('dsc',          sql.NVarChar(200), partial.Enterprise_dsc); set.push('Enterprise_dsc = @dsc'); }
  if (partial.Country !== undefined)        { req.input('country',       sql.NVarChar(100), partial.Country);        set.push('Country = @country'); }
  if (partial.State !== undefined)          { req.input('state',         sql.NVarChar(100), partial.State);          set.push('State = @state'); }
  if (partial.County !== undefined)         { req.input('county',        sql.NVarChar(100), partial.County);         set.push('County = @county'); }
  if (partial.City !== undefined)           { req.input('city',          sql.NVarChar(100), partial.City);           set.push('City = @city'); }
  if (partial.Telephone !== undefined)      { req.input('telephone',     sql.VarChar(30),   partial.Telephone);      set.push('Telephone = @telephone'); }
  if (partial.Address !== undefined)        { req.input('address',       sql.NVarChar(300), partial.Address);        set.push('Address = @address'); }
  if (partial.Invoice_mail !== undefined)   { req.input('invoiceMail',   sql.VarChar(120),  partial.Invoice_mail);   set.push('Invoice_mail = @invoiceMail'); }
  if (partial.Contact !== undefined)        { req.input('contact',       sql.NVarChar(200), partial.Contact);        set.push('Contact = @contact'); }
  if (partial.Contact_mail !== undefined)   { req.input('contactMail',   sql.VarChar(120),  partial.Contact_mail);   set.push('Contact_mail = @contactMail'); }
  if (partial.Contact_phone !== undefined)  { req.input('contactPhone',  sql.VarChar(30),   partial.Contact_phone);  set.push('Contact_phone = @contactPhone'); }
  if (partial.Type !== undefined)           { req.input('type',          sql.VarChar(50),   partial.Type);           set.push('Type = @type'); }
  if (partial.Status !== undefined)         { req.input('status',        sql.Bit,            partial.Status);         set.push('status = @status'); }

  if (set.length === 0) return null;

  const r = await req.query(`
    UPDATE ${TABLE} SET ${set.join(', ')}
    OUTPUT INSERTED.*
    WHERE Enterprise_id = @id
  `);
  return r.recordset[0] ?? null;
};

const remove = async (id) => {
  const pool = await getPool();
  await pool.request()
    .input('id', sql.Int, id)
    .query(`DELETE FROM ${TABLE} WHERE Enterprise_id = @id`);
  return true;
};

module.exports = { findById, findByFiscalId, listAll, listByUser, insert, update, remove };
