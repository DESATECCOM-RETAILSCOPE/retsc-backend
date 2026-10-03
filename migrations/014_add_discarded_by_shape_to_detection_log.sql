-- Agrega discarded_by_shape a RETSC_LOG_DETECTION_PIPELINE (migración 012) — cuenta cuántas
-- cajitas se descartaron por el filtro de forma de detectionFilter.js (hallazgo de María
-- Royo, 2026-09-25: Custom Vision genera cajitas espurias sobre franjas parciales de un
-- producto, ej. la tapa/banda superior de algunos Nivea Men marcada como si fuera un
-- producto aparte — siempre con ocr_text vacío/Sku_id NULL).
--
-- Se guarda por separado de detections_saved (que ya refleja el conteo DESPUÉS del filtro
-- de forma) para poder auditar con el tiempo cuánto está descartando el filtro por foto —
-- si ese número empieza a crecer mucho o a incluir cajitas que en verdad eran productos
-- legítimos, es la señal de que los umbrales de detectionFilter.js (calibrados para envases
-- de desodorante) necesitan recalibrarse o no aplican a otra categoría.
--
-- Correr desde SSMS (o cliente SQL) como operación manual — NO ejecutar desde Node (mismo
-- criterio que las migraciones 003-013 de este repo).
--
-- Validar con:
--   SELECT TOP 20 photo_id, detections_saved, discarded_by_shape, created_at
--   FROM RETSC_LOG_DETECTION_PIPELINE ORDER BY created_at DESC;

USE [sqldb-rscope-prod];
GO

ALTER TABLE dbo.RETSC_LOG_DETECTION_PIPELINE
  ADD discarded_by_shape INT NULL;
GO
