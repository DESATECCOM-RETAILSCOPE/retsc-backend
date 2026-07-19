# TODO: Reordenamiento del menú y visibilidad por rol

**Estado**: pendiente — la dueña tiene el diseño en imágenes que todavía no envió. No implementar hasta recibirlas.

## Contexto

Feedback de la dueña del proyecto (1 Jul): el menú del frontend necesita reordenarse y algunas secciones deben mostrarse u ocultarse según el `Role_name` del usuario logueado (ver Issue B1 del mismo feedback — catálogo de roles: `ADMIN`, `ADMIN_DTC`, `EJECUTIVO CAMPO`, `GERENCIA`, `AUDITOR CAMPO`).

## Qué ya está listo para cuando lleguen las imágenes

- `src/config/roles.js` — constantes canónicas `ROLES` + `normalizeRole()`. El frontend puede usar los mismos nombres de rol que ya devuelve `GET /api/auth/login` en `user.roleName` (y el JWT) sin mapeos adicionales.
- `requireRole`/`requireAdmin` ya normalizan mayúsculas/minúsculas — cualquier ruta nueva que necesite restricción por rol sigue el mismo patrón (`requireRole(ROLES.X, ROLES.Y)`).
- Precedente ya aplicado en este mismo feedback:
  - `enterpriseController.js` (Issue B3) — ejemplo de branching por rol dentro de un controller (`isAdminDtc(req)`).
  - `categoryRoutes.js` (Issue B4) — ejemplo de restringir un grupo de rutas de gestión a un solo rol, dejando las de lectura abiertas.

## Qué falta (bloqueado)

- El diseño específico de qué ve cada rol en el menú — pendiente de la dueña.
- Decidir si la visibilidad del menú se resuelve 100% en el frontend (leyendo `user.roleName`) o si además hace falta ocultar/exponer endpoints nuevos en el backend — depende de qué secciones cambien.

## Cómo continuar cuando lleguen las imágenes

1. Confirmar con la dueña, por cada item del menú, qué rol(es) lo ven.
2. Si es solo un cambio de visibilidad de UI (mostrar/ocultar links), probablemente no requiere cambios de backend — el frontend ya recibe `roleName` en el login.
3. Si además hay endpoints nuevos o existentes que deban restringirse a roles específicos, seguir el patrón de `requireRole` + `src/config/roles.js` ya establecido.
