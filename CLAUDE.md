# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev     # Start development server with nodemon (auto-reload)
npm start       # Start production server
```

No lint or test commands are configured.

## Environment Setup

Copy `.env.example` to `.env` and fill in values. Required variables:

- `PORT` — server port
- `DB_SERVER`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` — MSSQL credentials (DB runs on port 1435, not the default 1433)
- `JWT_SECRET`, `JWT_EXPIRES_IN` — token signing and expiry (default 24h)

## Architecture

Classic Express layered architecture: `Routes → Controllers → Services → DB`

```
server.js         Entry point — loads dotenv, starts server
src/app.js        Express setup — CORS, JSON body parsing, route mounting, global error handler
src/routes/       HTTP route definitions; all auth routes mount at /api/auth
src/controllers/  Input validation, calls service methods, formats HTTP responses
src/services/     All SQL queries and business logic live here
src/middlewares/  JWT verification middleware; attaches decoded payload to req.user
src/config/db.js  MSSQL connection pool singleton (mssql package, raw parameterized SQL)
```

**Database:** Microsoft SQL Server, table `RETSC_OP_USERS`. No ORM — all queries are raw SQL with `@param` parameterized inputs via the `mssql` package.

**Auth flow:**
- `POST /api/auth/register` — validates input, bcrypt-hashes password (salt=10), inserts user
- `POST /api/auth/login` — finds user by email, compares bcrypt hash, returns JWT with `{userId, email, username}`
- `GET /api/auth/me` and `GET /api/auth/users` — protected; require `Authorization: Bearer <token>` header

**Adding new features** follows the same layered pattern: add route → add controller method → add service method with SQL query. Keep DB queries out of controllers.
