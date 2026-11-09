-- Ciclo 5 · B1 — Esquema del módulo de planogramas (diseño aprobado el 11-ago).
--
--   Flow_direction  — dirección del flujo del pasillo: 'IZQ_DER' | 'DER_IZQ'. Define el orden
--                     de los muebles (Shelfunit_id) y las columnas (Shelfcolumn_id) en la Fase 8.
--   Status          — valores válidos: 'BORRADOR' (recién cargado, sin aprobar) | 'ACTIVO' |
--                     'INACTIVO'. VARCHAR(10) ya existe; se agrega el CHECK.
--
-- Idempotente. Correr desde SSMS sobre la base del ambiente. NO ejecutar desde Node.
-- Sin esta migración, POST /api/planograms falla con "Invalid column name 'Flow_direction'".

-- 0) Estado actual
SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'RETSC_OP_PLANOGRAM'
ORDER BY ORDINAL_POSITION;
-- Si ya hay filas, revisar que sus Status sean válidos antes del paso 2:
SELECT Status, COUNT(*) AS n FROM dbo.RETSC_OP_PLANOGRAM GROUP BY Status;
GO

-- 1) Flow_direction
IF COL_LENGTH('dbo.RETSC_OP_PLANOGRAM', 'Flow_direction') IS NULL
  ALTER TABLE dbo.RETSC_OP_PLANOGRAM ADD Flow_direction VARCHAR(20) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_PLANOGRAM_FLOW_DIRECTION')
  ALTER TABLE dbo.RETSC_OP_PLANOGRAM WITH CHECK
    ADD CONSTRAINT CK_PLANOGRAM_FLOW_DIRECTION
    CHECK (Flow_direction IS NULL OR Flow_direction IN ('IZQ_DER', 'DER_IZQ'));
GO

-- 2) Valores de Status (falla si hay filas con otro valor — ver paso 0)
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_PLANOGRAM_STATUS')
  ALTER TABLE dbo.RETSC_OP_PLANOGRAM WITH CHECK
    ADD CONSTRAINT CK_PLANOGRAM_STATUS
    CHECK (Status IS NULL OR Status IN ('BORRADOR', 'ACTIVO', 'INACTIVO'));
GO

-- 3) OPCIONAL — solo con OK de María: Formato mide 30 en RETSC_OP_PLANOGRAM y 50 en
--    RETSC_OP_RETAILER (de donde se copia). Si alguna tienda tiene un formato de más de 30
--    caracteres, la carga responde 400 ERR_FORMATO_DEMASIADO_LARGO. Para ampliarlo:
-- SELECT MAX(LEN(Formato)) AS max_formato_tiendas FROM dbo.RETSC_OP_RETAILER;
-- ALTER TABLE dbo.RETSC_OP_PLANOGRAM ALTER COLUMN Formato VARCHAR(50) NULL;
GO

-- 4) Validar
SELECT name, definition FROM sys.check_constraints
WHERE parent_object_id = OBJECT_ID('dbo.RETSC_OP_PLANOGRAM');
GO
