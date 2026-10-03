-- Agrega discarded_as_duplicate a RETSC_LOG_DETECTION_PIPELINE (migración 012) — reemplaza
-- discarded_by_shape (migración 014) como métrica de auditoría del pipeline de detección.
--
-- El filtro de forma (detectionFilter.js, hallazgo de María 2026-09-25) se desactivó
-- 2026-09-28: se calibró solo contra latas de aerosol Nivea Men (producto legítimo alto y
-- angosto, ratio 4.2-5.2), pero descartaba desodorantes en formato stick (Speed Stick, Old
-- Spice, Gillette) como si fueran cajitas espurias, porque su proporción real (~1.1-2.7) cae
-- dentro del rango que el filtro asumía espurio — confirmado en Photo_id=89/visita 67: de 25
-- "descartadas por forma", 22 eran productos stick legítimos.
--
-- El nuevo criterio (duplicateDetectionFilter.js) descarta DESPUÉS de la identificación
-- (Paso 5), no por proporción width/height: una cajita SIN Sku_id identificado cuyo bbox
-- está mayormente contenido (>=60% de su área) dentro de otra cajita de la MISMA foto que SÍ
-- se identificó. No depende de la forma del producto — validado contra Photo_id=89 (30
-- detecciones): solo 3 pares superan el umbral de contención, los 3 confirmados
-- visualmente como recortes de tapa/label parcial sobre una lata AXE ya identificada.
--
-- discarded_by_shape queda en la tabla (histórico, no se borra) pero desde este commit
-- siempre se guarda NULL.
--
-- Correr desde SSMS (o cliente SQL) como operación manual — NO ejecutar desde Node (mismo
-- criterio que las migraciones 003-014 de este repo).
--
-- Validar con:
--   SELECT TOP 20 photo_id, detections_saved, discarded_as_duplicate, created_at
--   FROM RETSC_LOG_DETECTION_PIPELINE ORDER BY created_at DESC;

USE [sqldb-rscope-prod];
GO

ALTER TABLE dbo.RETSC_LOG_DETECTION_PIPELINE
  ADD discarded_as_duplicate INT NULL;
GO
