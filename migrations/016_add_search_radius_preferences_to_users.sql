-- Agrega preferencias de radio de búsqueda de puntos de venta a RETSC_OP_USERS — pantalla
-- "Configuración" del mobile (2026-10-21): el radio de 5km de MapScreen.js (RADIO_KM) estaba
-- hardcodeado. Ahora es ajustable por el propio usuario, pero detrás de un toggle que
-- también se guarda (custom_radius_enabled) — si está en 0, el mobile debe usar el default
-- de 5km sin importar qué haya en search_radius_km (se preserva el último valor elegido
-- para cuando el usuario vuelva a activar el ajuste, no se borra al desactivar).
--
-- DEFAULT 5 en search_radius_km (no NULL) a propósito — evita tener que resolver un
-- fallback NULL->5 en cada lugar que lo lee (backend y mobile).
--
-- Correr desde SSMS (o cliente SQL) como operación manual — NO ejecutar desde Node (mismo
-- criterio que las migraciones 003-015 de este repo).
--
-- Validar con:
--   SELECT TOP 20 User_id, custom_radius_enabled, search_radius_km FROM RETSC_OP_USERS;

USE [sqldb-rscope-prod];
GO

ALTER TABLE dbo.RETSC_OP_USERS
  ADD custom_radius_enabled BIT NOT NULL CONSTRAINT DF_RETSC_OP_USERS_custom_radius_enabled DEFAULT 0,
      search_radius_km INT NOT NULL CONSTRAINT DF_RETSC_OP_USERS_search_radius_km DEFAULT 5;
GO
