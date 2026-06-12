-- Agrega columna prefix dedicada a RETSC_INF_GLOBAL_BLOB_CONTAINERS.
-- Antes el prefix se guardaba dentro de description como 'prefix=dtc-X'.
--
-- Correr desde SSMS (o cliente SQL) como operación manual — NO ejecutar desde Node.

USE [sqldb-rscope-prod];
GO

-- Paso 1: agregar la columna
ALTER TABLE dbo.RETSC_INF_GLOBAL_BLOB_CONTAINERS
  ADD prefix VARCHAR(100) NULL;
GO

-- Paso 2: migrar los valores que estaban en description con formato 'prefix=...'
UPDATE dbo.RETSC_INF_GLOBAL_BLOB_CONTAINERS
SET    prefix      = SUBSTRING(description, 8, 100),  -- 'prefix=' tiene 7 chars
       description = NULL
WHERE  description LIKE 'prefix=%';
GO

-- Paso 3: verificar
SELECT global_container_id, container_name, prefix, description
FROM dbo.RETSC_INF_GLOBAL_BLOB_CONTAINERS;
