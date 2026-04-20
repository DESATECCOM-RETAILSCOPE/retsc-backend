const bcrypt = require('bcryptjs');
const { getPool, sql } = require('../config/db');

const findUserByEmail = async (email) => {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('email', sql.VarChar(120), email)
    .query(
      'SELECT * FROM RETSC_OP_USERS WHERE Email = @email AND Status = 1'
    );
  return result.recordset[0] || null;
};

const findUserByUsername = async (username) => {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('username', sql.VarChar(80), username)
    .query(
      'SELECT * FROM RETSC_OP_USERS WHERE User_name = @username'
    );
  return result.recordset[0] || null;
};

const findUserById = async (userId) => {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('userId', sql.Int, userId)
    .query(
      'SELECT User_id, User_name, Email, Status, Created_date, ced_identidad FROM RETSC_OP_USERS WHERE User_id = @userId'
    );
  return result.recordset[0] || null;
};

const getAllUsers = async () => {
  const pool = await getPool();
  const result = await pool
    .request()
    .query(
      'SELECT User_id, User_name, Email, Status, Created_date, ced_identidad FROM RETSC_OP_USERS ORDER BY Created_date DESC'
    );
  return result.recordset;
};

const createUser = async ({ username, email, password, cedIdentidad }) => {
  const pool = await getPool();
  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash(password, salt);

  const result = await pool
    .request()
    .input('username',     sql.VarChar(80),  username)
    .input('email',        sql.VarChar(120), email)
    .input('passwordHash', sql.VarChar(200), passwordHash)
    .input('cedIdentidad', sql.VarChar(50),  cedIdentidad)
    .query(`
      INSERT INTO RETSC_OP_USERS 
        (User_name, Email, PasswordHash, Status, Created_date, ced_identidad)
      VALUES 
        (@username, @email, @passwordHash, 1, GETDATE(), @cedIdentidad);
      SELECT SCOPE_IDENTITY() AS User_id;
    `);

  return result.recordset[0].User_id;
};

const validatePassword = async (plain, hash) => {
  return bcrypt.compare(plain, hash);
};

module.exports = {
  findUserByEmail,
  findUserByUsername,
  findUserById,
  getAllUsers,
  createUser,
  validatePassword,
};
