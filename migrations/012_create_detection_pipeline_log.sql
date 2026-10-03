-- Crea RETSC_LOG_DETECTION_PIPELINE — registro persistente de cada corrida del pipeline de
-- detección de fotos de visita (detectionPipelineService.processPhotoDetection).
--
-- Motivo (bug real, 2026-09-24): el pipeline corre fire-and-forget después de responder el
-- 201 al mobile (ver comentario en visitPhotoService.uploadVisitPhoto) — cualquier falla
-- (timeout de Custom Vision, hipo de red, modelo no publicado) solo quedaba en un
-- console.log/warn/error de Railway, que rota y no es consultable después del hecho. Un
-- caso real (Photo_id=33, visita 37) quedó con 0 detecciones en RETSC_EX_SHELFPHOTO_DETECTION
-- sin ningún rastro de por qué — al reintentar manualmente los mismos bytes minutos después,
-- Custom Vision sí encontró productos, confirmando que fue una falla transitoria, no del
-- modelo. Esta tabla + el reintento agregado en customVisionPredictService.js (ver ese
-- archivo) son la respuesta a ese caso.
--
-- Correr desde SSMS (o cliente SQL) como operación manual — NO ejecutar desde Node (mismo
-- criterio que las migraciones 003-011 de este repo).
--
-- Validar con:
--   SELECT TOP 20 * FROM RETSC_LOG_DETECTION_PIPELINE ORDER BY created_at DESC;

USE [sqldb-rscope-prod];
GO

CREATE TABLE dbo.RETSC_LOG_DETECTION_PIPELINE (
  log_id            INT IDENTITY(1,1) NOT NULL,
  photo_id          INT               NOT NULL,
  category_id       INT               NOT NULL,
  status            VARCHAR(20)       NOT NULL,  -- SUCCESS | PENDING | ERROR
  reason_code       VARCHAR(30)       NULL,       -- NO_MODEL, MODEL_NOT_PUBLISHED, PREDICT_TIMEOUT, etc. (NULL si SUCCESS)
  raw_predictions   INT               NULL,       -- predicciones devueltas por Custom Vision antes del umbral
  detections_saved  INT               NOT NULL  CONSTRAINT DF_RETSC_LOG_DETECTION_PIPELINE_saved DEFAULT 0,
  threshold_applied DECIMAL(5,2)      NULL,
  attempts          INT               NOT NULL  CONSTRAINT DF_RETSC_LOG_DETECTION_PIPELINE_attempts DEFAULT 1,
  error_message     NVARCHAR(MAX)     NULL,
  duration_ms       INT               NULL,
  created_at        DATETIME2         NOT NULL  CONSTRAINT DF_RETSC_LOG_DETECTION_PIPELINE_created DEFAULT GETDATE(),
  CONSTRAINT PK_RETSC_LOG_DETECTION_PIPELINE PRIMARY KEY (log_id)
);
GO

CREATE INDEX IX_RETSC_LOG_DETECTION_PIPELINE_photo_id   ON dbo.RETSC_LOG_DETECTION_PIPELINE (photo_id);
CREATE INDEX IX_RETSC_LOG_DETECTION_PIPELINE_status     ON dbo.RETSC_LOG_DETECTION_PIPELINE (status);
CREATE INDEX IX_RETSC_LOG_DETECTION_PIPELINE_created_at ON dbo.RETSC_LOG_DETECTION_PIPELINE (created_at DESC);
GO
