-- Crea RETSC_LOG_SKU_IDENTIFICATION — registro persistente del paso 5 (OCR + búsqueda de
-- SKU) del pipeline de detección, hermano de RETSC_LOG_DETECTION_PIPELINE (migración 012)
-- que solo cubre el paso de Custom Vision.
--
-- Motivo (caso real, 2026-09-25): Photo_id=37/38 detectaron bien (8 y 13 cajitas
-- respectivamente, log de RETSC_LOG_DETECTION_PIPELINE en SUCCESS) pero terminaron con 0
-- SKUs identificados. embeddingService.embedText()/skuSearchService.js degradan a
-- matched:false ante cualquier error (credenciales de Azure OpenAI/Search faltantes o mal
-- configuradas en Railway, timeout, etc.) — a propósito, para no tumbar el resto de la foto
-- — pero eso significa que el motivo real del fallo solo quedaba en un console.error del
-- proceso de Railway, que el usuario no pudo ubicar en el dashboard. Esta tabla persiste ese
-- motivo para poder diagnosticarlo por SQL en vez de por logs efímeros.
--
-- Correr desde SSMS (o cliente SQL) como operación manual — NO ejecutar desde Node (mismo
-- criterio que las migraciones 003-012 de este repo).
--
-- Validar con:
--   SELECT TOP 20 * FROM RETSC_LOG_SKU_IDENTIFICATION ORDER BY created_at DESC;

USE [sqldb-rscope-prod];
GO

CREATE TABLE dbo.RETSC_LOG_SKU_IDENTIFICATION (
  log_id         INT IDENTITY(1,1) NOT NULL,
  photo_id       INT               NOT NULL,
  total_boxes    INT               NOT NULL,
  matched_count  INT               NOT NULL  CONSTRAINT DF_RETSC_LOG_SKU_IDENTIFICATION_matched DEFAULT 0,
  error_message  NVARCHAR(MAX)     NULL,       -- primer error de embedding/búsqueda encontrado, si hubo alguno
  duration_ms    INT               NULL,
  created_at     DATETIME2         NOT NULL  CONSTRAINT DF_RETSC_LOG_SKU_IDENTIFICATION_created DEFAULT GETDATE(),
  CONSTRAINT PK_RETSC_LOG_SKU_IDENTIFICATION PRIMARY KEY (log_id)
);
GO

CREATE INDEX IX_RETSC_LOG_SKU_IDENTIFICATION_photo_id   ON dbo.RETSC_LOG_SKU_IDENTIFICATION (photo_id);
CREATE INDEX IX_RETSC_LOG_SKU_IDENTIFICATION_created_at ON dbo.RETSC_LOG_SKU_IDENTIFICATION (created_at DESC);
GO
