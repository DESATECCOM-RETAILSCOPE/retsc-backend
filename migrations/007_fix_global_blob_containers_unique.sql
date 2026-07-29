-- Corrige el UNIQUE constraint de RETSC_INF_GLOBAL_BLOB_CONTAINERS.
--
-- Problema: UQ_RETSC_GLOBAL_BLOB_CONTAINER_NAME es UNIQUE sobre container_name solo.
-- container_name guarda el nombre del container COMPARTIDO (ej. 'global-sku-training'),
-- no algo único por categoría — eso lo distingue prefix (ej. 'dtc-shampoo' vs
-- 'dtc-desodorantes-corporales'). Con el constraint actual, la fila de la primera
-- categoría que provisiona bloquea el registro de auditoría de TODAS las demás
-- categorías que comparten el mismo container (aiInfrastructureService.js atrapa ese
-- error y lo ignora a propósito para no romper el provisioning real, pero el efecto es
-- que RETSC_INF_GLOBAL_BLOB_CONTAINERS nunca refleja más de 1 fila por container).
--
-- Fix: constraint único sobre (container_name, prefix) — cada categoría reales su propia
-- combinación, así cada una sí queda registrada.
--
-- Correr desde SSMS (o cliente SQL) como operación manual — NO ejecutar desde Node.

USE [sqldb-rscope-prod];
GO

-- Paso 1: quitar el constraint viejo (solo container_name)
ALTER TABLE dbo.RETSC_INF_GLOBAL_BLOB_CONTAINERS
  DROP CONSTRAINT UQ_RETSC_GLOBAL_BLOB_CONTAINER_NAME;
GO

-- Paso 2: crear el nuevo constraint compuesto (container_name, prefix)
ALTER TABLE dbo.RETSC_INF_GLOBAL_BLOB_CONTAINERS
  ADD CONSTRAINT UQ_RETSC_GLOBAL_BLOB_CONTAINER_NAME_PREFIX UNIQUE (container_name, prefix);
GO

-- Paso 3 (dato existente): la única fila de hoy (SHAMPOO) quedó con
-- container_type='GLOBAL_TRAINING' para el container 'global-sku-training', pero según
-- la convención acordada (ver src/services/aiInfrastructureService.js) ese valor debería
-- ser 'GLOBAL_SKU_PHOTOS' — 'GLOBAL_TRAINING' queda reservado para el container de fotos
-- de góndola ('global-shelf-training'). Revisar y correr manualmente si aplica; comentado
-- por defecto para no asumir sin confirmar.
-- UPDATE dbo.RETSC_INF_GLOBAL_BLOB_CONTAINERS
-- SET container_type = 'GLOBAL_SKU_PHOTOS'
-- WHERE container_name = 'global-sku-training' AND container_type = 'GLOBAL_TRAINING';
-- GO

-- Paso 4: verificar
SELECT global_container_id, category_id, container_name, container_type, prefix, status
FROM dbo.RETSC_INF_GLOBAL_BLOB_CONTAINERS
ORDER BY category_id;
