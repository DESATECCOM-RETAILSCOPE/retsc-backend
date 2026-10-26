-- Ciclo 5 · A4 — Garantizar UN solo modelo activo (is_active = 1) por categoría.
--
-- Contexto: docs/BUG-is_active-no-unico.md. Nada en la BD impedía dos filas activas para la
-- misma categoría, y findByCategoryId() se quedaba con la primera que devolviera SQL. El código
-- del ciclo 5 ya activa con UN solo UPDATE atómico (aiModelRepo.setActiveVersion); este índice
-- lo impone también a nivel de BD.
--
-- ⚠ CAMBIA ESTRUCTURA DE LA BD — correr solo con el OK de María. Desde SSMS, paso a paso.

-- 1) Auditoría: categorías con MÁS de un modelo activo (debe dar 0 filas para crear el índice)
SELECT category_id, COUNT(*) AS activos,
       STRING_AGG(CAST(detection_model_id AS VARCHAR(20)) + ':' + ISNULL(status, 'NULL'), ', ') AS modelos
FROM dbo.RETSC_AI_DETECTION_MODELS
WHERE is_active = 1
GROUP BY category_id
HAVING COUNT(*) > 1;
GO

-- 2) SOLO si el paso 1 devolvió filas: decidir con María cuál queda activa en cada categoría
--    (normalmente la de mayor model_version con status PUBLISHED) y desactivar las demás:
--    UPDATE dbo.RETSC_AI_DETECTION_MODELS SET is_active = 0 WHERE detection_model_id IN (<ids>);

-- 3) Crear el índice único filtrado (falla si el paso 1 todavía devuelve filas)
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'UX_RETSC_AI_DETECTION_MODELS_active_category'
                 AND object_id = OBJECT_ID('dbo.RETSC_AI_DETECTION_MODELS'))
  CREATE UNIQUE NONCLUSTERED INDEX UX_RETSC_AI_DETECTION_MODELS_active_category
    ON dbo.RETSC_AI_DETECTION_MODELS (category_id)
    WHERE is_active = 1;
GO

-- 4) Validar
SELECT name, is_unique, has_filter, filter_definition
FROM sys.indexes
WHERE object_id = OBJECT_ID('dbo.RETSC_AI_DETECTION_MODELS')
  AND name = 'UX_RETSC_AI_DETECTION_MODELS_active_category';
GO
