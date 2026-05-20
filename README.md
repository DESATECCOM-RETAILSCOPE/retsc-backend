# retsc-backend

API REST para RetailScope — Node.js + Express.

## Persistencia temporal (JSON)

El backend usa persistencia temporal en archivos JSON bajo `/data` mientras se define el acceso a SQL Server.

La migración a SQL es transparente para los clientes del API: solo se reemplaza la implementación interna de cada módulo en `src/repositories/`. Las firmas de los repositorios no deben cambiarse en esa migración.

## Cómo arrancar

```bash
npm install
cp .env.example .env        # completar variables (ver sección de entorno)
npm run seed                 # genera usuario y empresa demo
npm run dev                  # servidor con auto-reload
```

## Credenciales del seed

| Campo    | Valor                      |
|----------|----------------------------|
| Email    | admin@retailscope.com      |
| Password | demo1234                   |

## Variables de entorno

| Variable       | Descripción                          |
|----------------|--------------------------------------|
| PORT           | Puerto del servidor (default 3000)   |
| JWT_SECRET     | Clave de firma de tokens             |
| JWT_EXPIRES_IN | Tiempo de expiración (default `24h`) |
| DB_SERVER      | SQL Server host (inactivo por ahora) |
| DB_NAME        | Nombre de base de datos              |
| DB_USER        | Usuario SQL                          |
| DB_PASSWORD    | Contraseña SQL                       |

## Endpoints disponibles

| Método | Ruta                   | Auth      | Descripción              |
|--------|------------------------|-----------|--------------------------|
| POST   | /api/auth/register     | No        | Crear nuevo usuario      |
| POST   | /api/auth/login        | No        | Iniciar sesión (JWT)     |
| GET    | /api/auth/me           | Bearer    | Datos del usuario actual |
| GET    | /api/auth/users        | Bearer    | Lista de todos los usuarios |

### Ejemplo de login

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@retailscope.com","password":"demo1234"}'
```

Respuesta:
```json
{
  "token": "<jwt>",
  "user": { "userId": 1, "email": "admin@retailscope.com", "username": "Admin Demo" }
}
```

## Cómo migrar a SQL más adelante

Cuando SQL Server esté disponible, solo hay que reemplazar el contenido de `src/repositories/*.js`. Cada repositorio deberá:

1. Importar `../config/db` en lugar de `./jsonRepo`.
2. Implementar los mismos métodos con las mismas firmas (mismo nombre, mismos parámetros, mismo tipo de retorno).
3. Las capas superiores (services, controllers, routes) no necesitan ningún cambio.

`src/config/db.js` ya existe y configura el pool de MSSQL — solo hay que activarlo.

## Estructura de directorios

```
data/               Archivos JSON de persistencia temporal
scripts/seed.js     Genera datos iniciales
src/
  repositories/     Capa de acceso a datos (JSON hoy, SQL mañana)
  services/         Lógica de negocio
  controllers/      Validación de entrada y formato de respuesta HTTP
  routes/           Definición de rutas Express
  middlewares/      Verificación JWT
  config/db.js      Pool MSSQL (inactivo, listo para reactivar)
```
