const authService = require('../services/authService');

// ────────────── Login ──────────────

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email y contraseña son requeridos' });
    }

    const { user, relation, role, enterprise } = await authService.resolveLoginData(
      email.trim().toLowerCase(),
      password
    );

    const { accessToken, refreshToken } = authService.issueTokens(user, relation, role);

    return res.json({
      // Compatibilidad: el frontend actual usa 'token'. Se mantiene hasta que migre a 'accessToken'.
      // TODO (feedback de versión): coordinar con frontend la migración a accessToken/refreshToken.
      token:        accessToken,
      accessToken,
      refreshToken,
      user: {
        id:            user.User_id,
        username:      user.User_name,
        email:         user.Email,
        cedIdentidad:  user.ced_identidad,
        enterpriseId:  relation.Enterprise_id,
        enterpriseDsc: enterprise?.Enterprise_dsc ?? null,
        roleId:        role.Role_id,
        roleName:      role.Role_name,
      },
    });
  } catch (err) {
    const status = err.statusCode || 500;
    // DEBUG TEMPORAL — borrar después de resolver el problema
    console.error('[LOGIN DEBUG] statusCode:', err.statusCode);
    console.error('[LOGIN DEBUG] message:', err.message);
    console.error('[LOGIN DEBUG] error completo:', err);
    return res.status(status).json({ message: err.message });
  }
};

// ────────────── Refresh ──────────────

const refresh = async (req, res) => {
  try {
    const { refreshToken } = req.body;

    const { accessToken } = await authService.refreshAccessToken(refreshToken);

    return res.json({ accessToken });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status === 500) console.error('Refresh error:', err);
    return res.status(status).json({ message: err.message });
  }
};

// ────────────── Logout (stateless) ──────────────

const logout = async (req, res) => {
  // Logout stateless: el server solo confirma. El cliente debe borrar sus tokens.
  // Si en el futuro se requiere "kill session" real, agregar tabla de refresh
  // tokens revocados y marcar el refreshToken del request como revocado aquí.
  return res.json({ message: 'Sesión cerrada exitosamente' });
};

// ────────────── Resto (sin cambios) ──────────────

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

const forgotPassword = async (req, res) => {
  try {
    const { identifier } = req.body;
    if (!identifier?.trim()) {
      return res.status(400).json({ success: false, message: 'Email o usuario requerido' });
    }
    const result = await authService.forgotPassword(identifier.trim());
    return res.json({ success: true, message: result.message });
  } catch (err) {
    console.error('ForgotPassword error:', err);
    return res.status(500).json({ success: false, message: 'Error interno del servidor' });
  }
};

module.exports = { login, refresh, logout, register, getMe, getUsers, forgotPassword };