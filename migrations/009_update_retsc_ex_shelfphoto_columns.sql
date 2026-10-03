-- Sincroniza RETSC_EX_SHELFPHOTO con el esquema esperado por el código actual.
-- Agrega las columnas de calidad/dedup que usa shelfPhotoRepo, shelfPhotoUploadService
-- y visitPhotoService, si es que todavía faltan en la base de datos.
--
-- Esta migración está diseñada para ser segura en una base donde algunas columnas
-- ya existen y otras no. Se recomienda correrla desde SSMS o un cliente SQL.

USE [sqldb-rscope-prod];
GO

IF OBJECT_ID('dbo.RETSC_EX_SHELFPHOTO', 'U') IS NOT NULL
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM sys.columns
        WHERE object_id = OBJECT_ID('dbo.RETSC_EX_SHELFPHOTO')
          AND name = 'image_hash'
    )
    BEGIN
        ALTER TABLE dbo.RETSC_EX_SHELFPHOTO
        ADD image_hash VARCHAR(64) NULL;
    END

    IF NOT EXISTS (
        SELECT 1
        FROM sys.columns
        WHERE object_id = OBJECT_ID('dbo.RETSC_EX_SHELFPHOTO')
          AND name = 'quality_status'
    )
    BEGIN
        ALTER TABLE dbo.RETSC_EX_SHELFPHOTO
        ADD quality_status VARCHAR(20) NULL;
    END

    IF NOT EXISTS (
        SELECT 1
        FROM sys.columns
        WHERE object_id = OBJECT_ID('dbo.RETSC_EX_SHELFPHOTO')
          AND name = 'quality_error_code'
    )
    BEGIN
        ALTER TABLE dbo.RETSC_EX_SHELFPHOTO
        ADD quality_error_code VARCHAR(30) NULL;
    END

    IF NOT EXISTS (
        SELECT 1
        FROM sys.columns
        WHERE object_id = OBJECT_ID('dbo.RETSC_EX_SHELFPHOTO')
          AND name = 'width'
    )
    BEGIN
        ALTER TABLE dbo.RETSC_EX_SHELFPHOTO
        ADD width INT NULL;
    END

    IF NOT EXISTS (
        SELECT 1
        FROM sys.columns
        WHERE object_id = OBJECT_ID('dbo.RETSC_EX_SHELFPHOTO')
          AND name = 'height'
    )
    BEGIN
        ALTER TABLE dbo.RETSC_EX_SHELFPHOTO
        ADD height INT NULL;
    END

    IF NOT EXISTS (
        SELECT 1
        FROM sys.columns
        WHERE object_id = OBJECT_ID('dbo.RETSC_EX_SHELFPHOTO')
          AND name = 'blur_score'
    )
    BEGIN
        ALTER TABLE dbo.RETSC_EX_SHELFPHOTO
        ADD blur_score FLOAT NULL;
    END

    IF NOT EXISTS (
        SELECT 1
        FROM sys.columns
        WHERE object_id = OBJECT_ID('dbo.RETSC_EX_SHELFPHOTO')
          AND name = 'brightness'
    )
    BEGIN
        ALTER TABLE dbo.RETSC_EX_SHELFPHOTO
        ADD brightness FLOAT NULL;
    END

    IF NOT EXISTS (
        SELECT 1
        FROM sys.indexes
        WHERE object_id = OBJECT_ID('dbo.RETSC_EX_SHELFPHOTO')
          AND name = 'UX_RETSC_EX_SHELFPHOTO_enterprise_hash'
    )
    BEGIN
        CREATE UNIQUE INDEX UX_RETSC_EX_SHELFPHOTO_enterprise_hash
            ON dbo.RETSC_EX_SHELFPHOTO (ENTERPRISE_ID, image_hash)
            WHERE image_hash IS NOT NULL;
    END

    IF NOT EXISTS (
        SELECT 1
        FROM sys.indexes
        WHERE object_id = OBJECT_ID('dbo.RETSC_EX_SHELFPHOTO')
          AND name = 'IX_RETSC_EX_SHELFPHOTO_quality_status'
    )
    BEGIN
        CREATE INDEX IX_RETSC_EX_SHELFPHOTO_quality_status
            ON dbo.RETSC_EX_SHELFPHOTO (quality_status);
    END
END
ELSE
BEGIN
    PRINT 'ERROR: La tabla dbo.RETSC_EX_SHELFPHOTO no existe en esta base de datos.';
END
GO

-- Verificación rápida
SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'RETSC_EX_SHELFPHOTO'
ORDER BY ORDINAL_POSITION;
GO

SELECT name, type_desc, is_unique
FROM sys.indexes
WHERE object_id = OBJECT_ID('dbo.RETSC_EX_SHELFPHOTO')
  AND name IN ('UX_RETSC_EX_SHELFPHOTO_enterprise_hash', 'IX_RETSC_EX_SHELFPHOTO_quality_status');
GO
