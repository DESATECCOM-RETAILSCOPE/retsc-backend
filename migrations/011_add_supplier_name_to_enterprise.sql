-- Agrega supplier_name a RETSC_OP_ENTERPRISE — necesario para el reporte "Cumplimiento de
-- Surtido" (María, guía de assortment compliance, 2026-09).
--
-- Problema que resuelve: las queries de cumplimiento necesitan saber cuáles SKUs de
-- RETSC_OP_ENTERPRISE_PRODUCT_SEG son "propios" del enterprise (fabricante_propio, para
-- separar en_exceso_fuera_surtido de en_exceso_no_autorizado) — eso se resuelve comparando
-- contra la columna Supplier de esa tabla. Pero NO existe ninguna columna que conecte
-- formalmente un Enterprise_id con su valor de Supplier: Enterprise_dsc trae el nombre
-- "bonito" (ej. "Unilever C.A."), mientras que Supplier usa otro formato (ej. "UNILEVER",
-- sin sufijo legal, en mayúsculas) — confirmado contra datos reales de Enterprise_id=35,
-- no coinciden como string. Sin esta columna, el match tendría que ser una heurística de
-- texto (mayúsculas + primera palabra), frágil para cualquier otro enterprise cuyo nombre
-- no siga ese mismo patrón.
--
-- supplier_name se carga UNA vez por enterprise (a mano, por ahora — no hay UI de admin
-- para esto todavía) con el valor EXACTO que usa ese enterprise como Supplier en
-- RETSC_OP_ENTERPRISE_PRODUCT_SEG.
--
-- NULL para no romper enterprises existentes — assortmentComplianceService.js debe manejar
-- el caso NULL (no puede calcular en_exceso_fuera_surtido/en_exceso_no_autorizado sin esto;
-- ver ese archivo para cómo degrada).
--
-- Correr desde SSMS (o cliente SQL) como operación manual — NO ejecutar desde Node, mismo
-- criterio que las migraciones 003-010 de este repo.
--
-- Validar con:
--   SELECT Enterprise_id, Enterprise_dsc, supplier_name FROM RETSC_OP_ENTERPRISE;

USE [sqldb-rscope-prod];
GO

ALTER TABLE dbo.RETSC_OP_ENTERPRISE
  ADD supplier_name VARCHAR(100) NULL;
GO

-- Backfill conocido (confirmado contra datos reales 2026-09-13): Enterprise_id=35 es
-- Unilever C.A., y el valor real que usa en RETSC_OP_ENTERPRISE_PRODUCT_SEG.Supplier es
-- 'UNILEVER' (mayúsculas, sin "C.A."). Ajustar/agregar más filas a mano según se necesiten
-- otros enterprises.
UPDATE dbo.RETSC_OP_ENTERPRISE
SET supplier_name = 'UNILEVER'
WHERE Enterprise_id = 35;
GO
