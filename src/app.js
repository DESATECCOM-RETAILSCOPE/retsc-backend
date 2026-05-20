const express = require('express');
const cors = require('cors');
const authRoutes               = require('./routes/authRoutes');
const enterpriseRoutes         = require('./routes/enterpriseRoutes');
const userRoutes               = require('./routes/userRoutes');
const categoryRoutes           = require('./routes/categoryRoutes');
const enterpriseCategoryRoutes = require('./routes/enterpriseCategoryRoutes');
const productRoutes            = require('./routes/productRoutes');
const authMiddleware           = require('./middlewares/authMiddleware');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rutas
app.use('/api/auth',                       authRoutes);
app.use('/api/enterprises',               enterpriseRoutes);
app.use('/api/users',                     authMiddleware, userRoutes);
app.use('/api/categories',                authMiddleware, categoryRoutes);
app.use('/api/enterprises/me/categories', authMiddleware, enterpriseCategoryRoutes);
app.use('/api/products',                  productRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: 'Ruta no encontrada' });
});

// Error handler global
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ message: 'Error interno del servidor' });
});

module.exports = app;
