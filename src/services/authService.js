const bcrypt = require('bcryptjs');

// --- SQL (inactivo: descomentar cuando SQL Server esté disponible) ---
// const { getPool, sql } = require('../config/db');

// --- JSON (activo: persistencia temporal en archivos JSON) ---
const userRepo = require('../repositories/userRepo');

// ─────────────────────────────────────────────────────────────────────────────

const findUserByEmail = async (email) => {
  // SQL:
  // const pool = await getPool();
  // const result = await pool
  //   .request()
  //   .input('email', sql.VarChar(120), email)
  //   .query('SELECT * FROM RETSC_OP_USERS WHERE Email = @email AND Status = 1');
  // return result.recordset[0] || null;

  return userRepo.findByEmail(email);
};

const findUserByUsername = async (username) => {
  // SQL:
  // const pool = await getPool();
  // const result = await pool
  //   .request()
  //   .input('username', sql.VarChar(80), username)
  //   .query('SELECT * FROM RETSC_OP_USERS WHERE User_name = @username');
  // return result.recordset[0] || null;

  const users = await userRepo.listAll();
  return users.find(u => u.User_name === username) ?? null;
};

const findUserById = async (userId) => {
  // SQL:
  // const pool = await getPool();
  // const result = await pool
  //   .request()
  //   .input('userId', sql.Int, userId)
  //   .query(
  //     'SELECT User_id, User_name, Email, Status, Created_date, ced_identidad FROM RETSC_OP_USERS WHERE User_id = @userId'
  //   );
  // return result.recordset[0] || null;

  const user = await userRepo.findById(userId);
  if (!user) return null;
  const { PasswordHash, ...safe } = user;
  return safe;
};

const getAllUsers = async () => {
  // SQL:
  // const pool = await getPool();
  // const result = await pool
  //   .request()
  //   .query(
  //     'SELECT User_id, User_name, Email, Status, Created_date, ced_identidad FROM RETSC_OP_USERS ORDER BY Created_date DESC'
  //   );
  // return result.recordset;

  const users = await userRepo.listAll();
  return users.map(({ PasswordHash, ...safe }) => safe);
};

const createUser = async ({ username, email, password, cedIdentidad }) => {
  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash(password, salt);

  // SQL:
  // const pool = await getPool();
  // const result = await pool
  //   .request()
  //   .input('username',     sql.VarChar(80),  username)
  //   .input('email',        sql.VarChar(120), email)
  //   .input('passwordHash', sql.VarChar(200), passwordHash)
  //   .input('cedIdentidad', sql.VarChar(50),  cedIdentidad)
  //   .query(`
  //     INSERT INTO RETSC_OP_USERS
  //       (User_name, Email, PasswordHash, Status, Created_date, ced_identidad)
  //     VALUES
  //       (@username, @email, @passwordHash, 1, GETDATE(), @cedIdentidad);
  //     SELECT SCOPE_IDENTITY() AS User_id;
  //   `);
  // return result.recordset[0].User_id;

  const inserted = await userRepo.insert({
    User_name:     username,
    Email:         email,
    PasswordHash:  passwordHash,
    ced_identidad: cedIdentidad,
    Status:        1,
    Created_date:  new Date().toISOString(),
  });
  return inserted.User_id;
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
