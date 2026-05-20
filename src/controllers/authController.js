const jwt = require('jsonwebtoken');
const authService = require('../services/authService');

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email y contraseña son requeridos' });
    }

    const { user, relation, role } = await authService.resolveLoginData(
      email.trim().toLowerCase(),
      password
    );

    const token = jwt.sign(
      {
        userId:       user.User_id,
        email:        user.Email,
        username:     user.User_name,
        enterpriseId: relation.Enterprise_id,
        roleId:       role.Role_id,
        roleName:     role.Role_name,
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    return res.json({
      token,
      user: {
        id:           user.User_id,
        username:     user.User_name,
        email:        user.Email,
        cedIdentidad: user.ced_identidad,
        enterpriseId: relation.Enterprise_id,
        roleId:       role.Role_id,
        roleName:     role.Role_name,
      },
    });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status === 500) console.error('Login error:', err);
    return res.status(status).json({ message: err.message });
  }
};

const register = async (req, res) => {
  try {
    const { username, email, password, cedIdentidad } = req.body;

    if (!username || !email || !password || !cedIdentidad) {
      return res.status(400).json({ message: 'Todos los campos son requeridos' });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres' });
    }

    const existingEmail = await authService.findUserByEmail(email.trim().toLowerCase());
    if (existingEmail) {
      return res.status(409).json({ message: 'El email ya está registrado' });
    }

    const existingUsername = await authService.findUserByUsername(username.trim());
    if (existingUsername) {
      return res.status(409).json({ message: 'El nombre de usuario ya existe' });
    }

    const newUserId = await authService.createUser({
      username:    username.trim(),
      email:       email.trim().toLowerCase(),
      password,
      cedIdentidad: cedIdentidad.trim(),
    });

    return res.status(201).json({
      message: 'Usuario creado exitosamente',
      userId:  newUserId,
    });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

const getMe = async (req, res) => {
  try {
    const user = await authService.findUserById(req.user.userId);
    if (!user) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }
    return res.json({ user });
  } catch (err) {
    console.error('GetMe error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

const getUsers = async (req, res) => {
  try {
    const users = await authService.getAllUsers();
    return res.json({ users });
  } catch (err) {
    console.error('GetUsers error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

module.exports = { login, register, getMe, getUsers };
