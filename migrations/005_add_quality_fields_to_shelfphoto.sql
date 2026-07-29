-- Agrega campos de control de calidad y dedup a RETSC_EX_SHELFPHOTO.
-- Soporta el Issue 7.1: solo fotos de góndola de calidad suficiente entran al
-- dataset de entrenamiento. Una foto mala degrada el modelo para TODOS los
-- enterprises, por eso se filtra en la ingesta.
--
-- Columnas nuevas:
--   image_hash         — SHA-256 (hex, 64 chars) del archivo; base del dedup
--   quality_status     — PASSED | REJECTED
--   quality_error_code — LOW_RESOLUTION | BLURRY_IMAGE | POOR_LIGHTING | DUPLICATE_IMAGE
--   width, height      — resolución medida (px), para auditar el criterio 1280x720
--   blur_score         — score de nitidez normalizado [0,1]; permite calibrar el umbral
--   brightness         — brillo medio [0,255]; permite calibrar el rango 30-220
--
-- Todas NULL para no romper las filas existentes.
--
-- NOTA: el índice único es FILTRADO (WHERE image_hash IS NOT NULL). En SQL Server
-- un UNIQUE index normal trata varios NULL como duplicados entre sí, lo que
-- rechazaría más de una foto sin hash. El filtro permite múltiples NULL pero
-- garantiza unicidad de (ENTERPRISE_ID, image_hash) cuando el hash existe —
-- ese es el dedup por enterprise a nivel BD.
--
-- Correr desde SSMS (o cliente SQL) como operación manual — NO ejecutar desde Node.
-- Validar con:
--   SELECT TOP 20 Photo_id, ENTERPRISE_ID, image_hash, quality_status,
--                 quality_error_code, width, height, blur_score, brightness
--   FROM RETSC_EX_SHELFPHOTO ORDER BY Photo_id DESC;

USE [sqldb-rscope-prod];
GO

-- Paso 1: agregar las columnas
ALTER TABLE dbo.RETSC_EX_SHELFPHOTO
  ADD image_hash         VARCHAR(64)  NULL,
      quality_status     VARCHAR(20)  NULL,
      quality_error_code VARCHAR(30)  NULL,
      width              INT          NULL,
      height             INT          NULL,
      blur_score         FLOAT        NULL,
      brightness         FLOAT        NULL;
GO

-- Paso 2: índice único filtrado para el dedup por enterprise
CREATE UNIQUE INDEX UX_RETSC_EX_SHELFPHOTO_enterprise_hash
  ON dbo.RETSC_EX_SHELFPHOTO (ENTERPRISE_ID, image_hash)
  WHERE image_hash IS NOT NULL;
GO

-- Paso 3: índice de apoyo para consultas de auditoría por estado de calidad
CREATE INDEX IX_RETSC_EX_SHELFPHOTO_quality_status
  ON dbo.RETSC_EX_SHELFPHOTO (quality_status);
GO
