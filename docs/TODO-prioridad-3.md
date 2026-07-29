# TODO Prioridad 3 (QA) — pendientes para la próxima semana

Documentado por pedido explícito del prompt de correcciones QA (Issue B7). **No implementado
todavía** — solo diagnóstico del estado actual y propuesta breve de diseño para cada punto,
para discutir con el equipo antes de tocar código.

---

## 1. Validación de formato de cédula (Costa Rica)

**Estado actual:** `ced_identidad`/`cedIdentidad` se usa en tres lugares sin ninguna
validación de formato, solo chequeo de "no vacío":
- `userService.createAndAssign` (alta de usuario, `src/services/userService.js`)
- `enterpriseService` — cédula del admin al registrar una empresa (`src/services/enterpriseService.js:151`)
- `userRepo.findByCedula` — solo busca por igualdad exacta, no valida formato

No existe ningún validador de cédula en `src/utils/` (a diferencia de `gtinValidator.js`,
que sí tiene su propio validador con checksum).

**Propuesta de diseño:**
- Crear `src/utils/cedulaValidator.js` siguiendo el mismo patrón que `gtinValidator.js`
  (funciones puras, exports nombrados, self-test inline con `node src/utils/cedulaValidator.js`).
- Reglas CR:
  - **Física**: 9 dígitos (formato típico `X-XXXX-XXXX`, se recibe sin guiones). Primer
    dígito indica provincia (1-9, o 0 para naturalizados en algunos formatos — **confirmar
    con el equipo si se acepta 0 antes de implementar**, el prompt solo dice "9 dígitos").
  - **Jurídica**: 10 dígitos, empieza con `3` (cédula jurídica siempre arranca en 3-XXX-XXXXXX).
  - Sin dígito verificador oficial documentado públicamente (a diferencia de GTIN) — la
    validación es de formato/longitud, no de checksum.
- Exportar `validateCedula(value, { tipo: 'fisica'|'juridica'|'auto' })` → `{ valid, reason, tipo }`.
  `tipo: 'auto'` infiere física vs. jurídica por longitud.
- Integrar en:
  - `userService.createAndAssign` y `userService.updateUser` (alta/edición de usuario).
  - `enterpriseService` — cédula del admin en `POST /api/enterprises`.
  - Si el prompt agrega cédula jurídica de la empresa misma en el futuro, mismo validador.
- Mismo patrón de error que el resto del código: `svcError('Formato de cédula inválido: <razón>', 400)`.

**Abierto:** confirmar si el número de cédula ya cargado en producción cumple estas reglas —
si hay datos legacy con formato distinto, la validación debe aplicarse solo a altas nuevas,
no rechazar lecturas de datos existentes.

---

## 2. Autorización por rol (menú/endpoints según `Role_id`)

**Estado actual:** ya existen dos mecanismos de autorización por rol:
- `requireAdmin.js` — chequeo hardcodeado `roleName === 'Admin'`.
- `requireRole.js` — parametrizable, `requireRole(...roles)`, usado hoy solo en los módulos
  de IA de Joel (`annotations`, `models`, `shelf-photos`, `training`) vía roles leídos de
  variables de entorno CSV (`ANNOTATION_VALIDATOR_ROLES`, `MODEL_MANAGER_ROLES`, etc).

Los endpoints de negocio "core" (`/api/users`, `/api/enterprises`, `/api/categories`,
`/api/products`, `/api/skus`) usan `authMiddleware` solo para autenticar, **no** para
autorizar por rol — cualquier usuario autenticado de la empresa puede pegarle a cualquiera
de esos endpoints sin importar su `roleName`. Ninguno de esos endpoints define hoy qué
`Role_id` puede hacer qué acción.

**Propuesta de diseño:**
- No inventar una matriz de permisos por endpoint sin el equipo — eso es una decisión de
  producto, no técnica. Antes de tocar código, se necesita una tabla (roleName → acciones
  permitidas) acordada con el equipo, probablemente por pantalla del frontend.
- Una vez acordada la matriz, el patrón ya existe (`requireRole(...roles)`) — solo hay que
  aplicarlo con roles hardcodeados o leídos de env, igual que en los módulos de IA. No hace
  falta middleware nuevo.
- Alternativa más flexible a futuro (no para esta iteración): tabla `RETSC_OP_ROLE_PERMISSIONS`
  (`role_id`, `resource`, `action`) y un middleware `requirePermission(resource, action)` que
  consulte esa tabla en vez de una lista hardcodeada de roles por ruta. Mencionarlo pero no
  construirlo hasta que haya más de 2-3 reglas — con pocas reglas, `requireRole` alcanza.

**Abierto:** ¿la restricción es solo de backend (403 en el endpoint) o también hay que exponer
al frontend qué puede ver cada rol (para ocultar menús)? Si es lo segundo, `GET /api/auth/me`
ya devuelve `roleName` — el frontend puede derivar visibilidad de menú del lado cliente sin
cambios de backend, pero la aplicación real de permisos debe ser siempre server-side.

---

## 3. Email de bienvenida con enlace para fijar contraseña (usuario creado por admin)

**Estado actual:** `userService.createAndAssign` (alta de usuario por un admin) asigna la
contraseña que manda el admin en el body — **no hay flujo de "usuario recibe email y fija su
propia contraseña"**. El único flujo de email existente es `forgotPassword` (genera password
aleatoria y la manda por correo, ver `authService.js`).

**Hallazgo relevante:** existe una tabla `RETSC_INF_ACTIVATION_TOKENS` en la base de datos
(`token_id`, `token`, `enterprise_id`, `admin_email`, `created_at`, `expires_at`, `used`,
`used_at`) que **no tiene ninguna referencia en el código** (solo aparece en
`scripts/cleanup-for-testing.js`, que la vacía junto con el resto de tablas de prueba). Está
vacía en producción. Por su forma (`enterprise_id` + `admin_email`, no `user_id`) parece
pensada para activar al **admin de una empresa nueva** (flujo de `POST /api/enterprises`),
no para un usuario cualquiera creado después por ese admin — **no asumir que sirve para este
caso sin confirmar con el equipo qué la creó y para qué la pensaron originalmente.**

**Propuesta de diseño (para el caso de "usuario nuevo creado por admin", no el de arriba):**
- Nueva tabla (o extender `RETSC_INF_ACTIVATION_TOKENS` si el equipo confirma que es
  reutilizable y se le agrega `user_id nullable`): `token`, `user_id`, `created_at`,
  `expires_at`, `used` (bit).
- `userService.createAndAssign` deja de recibir `password` en el body como obligatorio →
  genera una contraseña aleatoria interna (ya existe `generatePassword()` en `authService.js`,
  se puede extraer a un helper compartido) **o** no genera password en absoluto (usuario queda
  sin password hash hasta que la fija), según lo que decida el equipo.
- Genera un token de un solo uso (`crypto.randomUUID()` o similar, ya se usa en varios lados
  del código — `crypto.randomUUID()` para `batchId`/`jobId`), guarda hash del token (no el
  token en claro) con expiración corta (ej. 24-48h).
- Nuevo endpoint público (sin `authMiddleware`, como `forgot-password`):
  `POST /api/auth/set-password` con `{ token, newPassword }` → valida token no usado y no
  expirado, hashea la password nueva, marca token `used=1`.
- Email vía `mailer.js` (ya soporta modo mock sin `SMTP_HOST`) con link
  `{FRONTEND_URL}/set-password?token=...` — **requiere agregar `FRONTEND_URL` a `.env`**, no
  existe hoy.

**Abierto:**
1. ¿Reutilizar `RETSC_INF_ACTIVATION_TOKENS` o crear tabla nueva? (depende de qué era el plan original).
2. ¿El usuario queda inactivo/sin acceso hasta fijar su password, o puede loguearse con una
   temporal mientras tanto? Afecta si `Status` arranca en 0 o 1.
3. ¿`FRONTEND_URL` ya existe en algún lado del frontend/infra que no vi, o hay que definirlo
   de cero?
