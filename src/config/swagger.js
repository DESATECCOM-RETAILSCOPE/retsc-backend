// Config de swagger-jsdoc: genera la spec OpenAPI 3.0 leyendo comentarios JSDoc puestos
// arriba de cada ruta (ver src/routes/*.js) — NO hay un openapi.yaml separado a mano,
// para que la doc no se desincronice del código real.
//
// PATRÓN para documentar una ruta nueva (copiar y adaptar):
//
//   /**
//    * @swagger
//    * /api/algo:
//    *   get:
//    *     summary: Una línea de qué hace
//    *     tags: [NombreDeGrupo]
//    *     security:
//    *       - bearerAuth: []          # <- omitir esta clave entera si la ruta es pública
//    *     parameters:
//    *       - in: query
//    *         name: paramName
//    *         schema: { type: string }
//    *         description: Explicar cualquier comportamiento no obvio acá (ver el caso
//    *                      de categoryId en productRoutes.js como ejemplo de footgun documentado).
//    *     responses:
//    *       200:
//    *         description: Qué devuelve
//    *         content:
//    *           application/json:
//    *             schema: { $ref: '#/components/schemas/AlgunSchema' }
//    *       401:
//    *         description: Token faltante o expirado
//    */
//   router.get('/algo', ...);
//
// Antes de copiar este patrón para una ruta nueva, revisar CÓMO se monta esa ruta en
// app.js — hay 3 patrones distintos en este repo (ver nota en CLAUDE.md, sección Swagger):
//   1. Auth global      (app.use('/api/x', authMiddleware, xRoutes))      → casi todas las rutas del router llevan `security: bearerAuth`
//   2. Auth inline       (ej. authRoutes.js: algunas rutas SIN authMiddleware, otras con él a mano) → revisar ruta por ruta
//   3. Auth por-ruta+multer (ej. productRoutes.js)                        → mismo criterio que el 2, más los uploads con multer no llevan swagger de body (no se documentó acá)
//
// Cobertura (actualizado 2026-08-21): los 17 archivos de src/routes/*.js ya tienen
// bloques @swagger — 46 rutas / 54 operaciones documentadas. Si agregás una ruta nueva,
// copiar el mismo patrón de arriba en vez de dejarla sin documentar.

const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'RetailScope API',
      version: '1.0.0',
      description: 'Documentación interactiva de la API de RetailScope (backend retsc-backend). Solo disponible fuera de producción — ver gate en app.js.',
    },
    // Solo cambia contra qué "server" apunta el botón "Try it out" del Swagger UI — esta
    // UI en sí NUNCA se sirve en producción (ver gate en app.js), pero corriéndola local
    // podés elegir invocar el backend deployado en Railway en vez de tu localhost.
    servers: [
      { url: `http://localhost:${process.env.PORT || 3000}`, description: 'Desarrollo local' },
      { url: 'https://retsc-backend-production-4845.up.railway.app', description: 'Railway (producción)' },
    ],
    components: {
      securitySchemes: {
        // "Authorize" en Swagger UI pide el JWT (sin el prefijo "Bearer ", swagger-ui-express
        // ya lo agrega) y lo manda como header Authorization: Bearer <token> en cada "Try it out".
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
  },
  // swagger-jsdoc escanea estos archivos buscando bloques @swagger en comentarios JSDoc.
  apis: ['./src/routes/*.js'],
};

module.exports = swaggerJsdoc(options);
