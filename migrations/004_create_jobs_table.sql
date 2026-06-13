-- Crea tabla RETSC_LOG_JOBS para tracking de jobs asíncronos.
-- Usar para upload de imágenes SKU (job_type='SKU_IMAGE_UPLOAD') y futuros jobs batch.
--
-- Correr desde SSMS como operación manual — NO ejecutar desde Node.
-- Validar con:
--   SELECT * FROM RETSC_LOG_JOBS ORDER BY created_at DESC;

USE [sqldb-rscope-prod];
GO

CREATE TABLE dbo.RETSC_LOG_JOBS (
  job_id          INT IDENTITY(1,1)  NOT NULL,
  user_id         INT                NOT NULL,
  enterprise_id   INT                NULL,
  job_type        VARCHAR(50)        NOT NULL,
  status          VARCHAR(20)        NOT NULL  CONSTRAINT DF_RETSC_LOG_JOBS_status    DEFAULT 'QUEUED',
  total_files     INT                NOT NULL  CONSTRAINT DF_RETSC_LOG_JOBS_total     DEFAULT 0,
  processed_count INT                NOT NULL  CONSTRAINT DF_RETSC_LOG_JOBS_processed DEFAULT 0,
  orphan_count    INT                NOT NULL  CONSTRAINT DF_RETSC_LOG_JOBS_orphan    DEFAULT 0,
  duplicate_count INT                NOT NULL  CONSTRAINT DF_RETSC_LOG_JOBS_duplicate DEFAULT 0,
  error_count     INT                NOT NULL  CONSTRAINT DF_RETSC_LOG_JOBS_error     DEFAULT 0,
  warning_count   INT                NOT NULL  CONSTRAINT DF_RETSC_LOG_JOBS_warning   DEFAULT 0,
  error_summary   NVARCHAR(MAX)      NULL,
  created_at      DATETIME2          NOT NULL  CONSTRAINT DF_RETSC_LOG_JOBS_created   DEFAULT GETDATE(),
  started_at      DATETIME2          NULL,
  finished_at     DATETIME2          NULL,
  CONSTRAINT PK_RETSC_LOG_JOBS PRIMARY KEY (job_id)
);
GO

CREATE INDEX IX_RETSC_LOG_JOBS_user_id    ON dbo.RETSC_LOG_JOBS (user_id);
CREATE INDEX IX_RETSC_LOG_JOBS_status     ON dbo.RETSC_LOG_JOBS (status);
CREATE INDEX IX_RETSC_LOG_JOBS_created_at ON dbo.RETSC_LOG_JOBS (created_at DESC);
GO
