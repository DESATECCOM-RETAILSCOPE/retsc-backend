-- Crea el esquema para el flujo de "Fotos de Visita" (guía v1.9, María Royo — julio 2026).
-- Este es el flujo de PRODUCCIÓN de la app móvil (auditor/gerente en tienda), distinto del
-- flujo de carga de fotos de entrenamiento globales que ya existía (Issues 7.1/7.2,
-- shelfPhotoUploadService.js / migración 005). Antes de esta migración, RETSC_EX_VISIT y
-- RETSC_EX_SHELFPHOTO_DETECTION no existían en absoluto (confirmado por grep sobre todo el
-- repo) — RETSC_EX_SHELFPHOTO.visit_id ya existía como columna, pero sin ninguna tabla del
-- lado "visita" que lo alimentara ni ninguna tabla de detecciones que lo consumiera.
--
-- ⚠ NOTA IMPORTANTE (a confirmar con María/equipo antes de aplicar en producción):
-- La guía asume que ya existe RETSC_OP_RETAILER con una columna Canal (sección 2.2 y 3.2:
-- "el canal... se resuelve por Retailer_id → RETSC_OP_RETAILER.Canal"). CLAUDE.md de este
-- repo (sección "Menú por rol", auditoría 2026-07-25) documenta explícitamente que ESA TABLA
-- NO EXISTE — "no hay tabla de retailers — RETSC_EX_SHELFPHOTO.Retailer_id es solo una
-- columna suelta sin catálogo detrás" — y pide no inventar ese catálogo sin pedido explícito
-- del equipo. Esta migración A PROPÓSITO NO crea RETSC_OP_RETAILER: si en verdad ya existe
-- en la base real (posible — el CLAUDE.md pudo quedar desactualizado), no hace falta tocar
-- nada; si no existe, el código de la capa de servicio (ver src/repositories/retailerRepo.js)
-- degrada de forma segura (devuelve canal=null) en vez de romper el flujo. Confirmar con el
-- equipo antes de decidir si esta tabla se crea en una migración aparte.
--
-- Tablas nuevas:
--   RETSC_EX_VISIT              — Paso 0 de la guía: abre/cierra la visita del auditor en el PDV.
--   RETSC_EX_SHELFPHOTO_DETECTION — Pasos 4/5 de la guía: una fila por "cajita" detectada por
--                                    Custom Vision, con Sku_id/EAN/ocr_text llenados después.
--   RETSC_OP_ASSORTMENT         — soporta la sección 8.2 (faltantes de surtido propio):
--                                  surtido autorizado/obligatorio de un enterprise por categoría.
--                                  No existía ninguna tabla equivalente en el repo.
--
-- Correr desde SSMS (o cliente SQL) como operación manual — NO ejecutar desde Node
-- (mismo criterio que las migraciones 003-007 de este repo).

USE [sqldb-rscope-prod];
GO

-- ─────────────────────────────────────────────────────────────────────────────
-- RETSC_EX_VISIT (Paso 0 de la guía — "abrir la visita")
-- ─────────────────────────────────────────────────────────────────────────────
-- A propósito NO tiene columna de categoría ni de canal (ver callout de la guía, sección 2):
-- una visita puede cubrir varias categorías bajo el mismo Visit_id; el canal se resuelve por
-- Retailer_id, nunca se duplica aquí.
CREATE TABLE dbo.RETSC_EX_VISIT (
  Visit_id       INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  User_id        INT           NOT NULL,
  Enterprise_id  INT           NOT NULL,
  Retailer_id    INT           NOT NULL,
  Visit_start    DATETIME      NOT NULL CONSTRAINT DF_RETSC_EX_VISIT_start DEFAULT (GETDATE()),
  Visit_end      DATETIME      NULL,
  Latitude       DECIMAL(9,6)  NULL,
  Longitude      DECIMAL(9,6)  NULL,
  Status         VARCHAR(10)   NOT NULL CONSTRAINT DF_RETSC_EX_VISIT_status DEFAULT ('OPEN'),
  CONSTRAINT CHK_RETSC_EX_VISIT_status CHECK (Status IN ('OPEN', 'CLOSED')),
  CONSTRAINT FK_RETSC_EX_VISIT_user       FOREIGN KEY (User_id)       REFERENCES dbo.RETSC_OP_USERS (User_id),
  CONSTRAINT FK_RETSC_EX_VISIT_enterprise FOREIGN KEY (Enterprise_id) REFERENCES dbo.RETSC_OP_ENTERPRISE (Enterprise_id)
);
GO

-- Apoya "abrir visita" (una por user+PDV OPEN a la vez, revisado en la capa de servicio, no
-- forzado con un unique filtrado — el issue no lo pide explícitamente) y el results endpoint.
CREATE INDEX IX_RETSC_EX_VISIT_enterprise_status
  ON dbo.RETSC_EX_VISIT (Enterprise_id, Status);
GO

CREATE INDEX IX_RETSC_EX_VISIT_user_status
  ON dbo.RETSC_EX_VISIT (User_id, Status);
GO

-- ─────────────────────────────────────────────────────────────────────────────
-- RETSC_EX_SHELFPHOTO_DETECTION (Pasos 4/5 de la guía)
-- ─────────────────────────────────────────────────────────────────────────────
-- Sku_id/EAN/ocr_text quedan NULL al insertar (Paso 4) — se llenan en el UPDATE del Paso 5
-- una vez que buscarSkuPorTexto (función de Joel, sección 7.2, aún no entregada) identifica
-- el producto o determina que no hay match por encima del umbral.
CREATE TABLE dbo.RETSC_EX_SHELFPHOTO_DETECTION (
  Detection_id        INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  Photo_id            INT           NOT NULL,
  detection_model_id  INT           NULL,
  Confidence          FLOAT         NULL,
  Bbox_left           FLOAT         NOT NULL,
  Bbox_top            FLOAT         NOT NULL,
  Bbox_width          FLOAT         NOT NULL,
  Bbox_height         FLOAT         NOT NULL,
  Sku_id              INT           NULL,
  EAN                 VARCHAR(20)   NULL,
  ocr_text            NVARCHAR(MAX) NULL,
  created_at          DATETIME      NOT NULL CONSTRAINT DF_RETSC_EX_SHELFPHOTO_DETECTION_created DEFAULT (GETDATE()),
  CONSTRAINT FK_RETSC_EX_SHELFPHOTO_DETECTION_photo
    FOREIGN KEY (Photo_id) REFERENCES dbo.RETSC_EX_SHELFPHOTO (Photo_id),
  CONSTRAINT FK_RETSC_EX_SHELFPHOTO_DETECTION_model
    FOREIGN KEY (detection_model_id) REFERENCES dbo.RETSC_AI_DETECTION_MODELS (detection_model_id),
  CONSTRAINT FK_RETSC_EX_SHELFPHOTO_DETECTION_sku
    FOREIGN KEY (Sku_id) REFERENCES dbo.RETSC_OP_SKUS (SKU_ID)
);
GO

CREATE INDEX IX_RETSC_EX_SHELFPHOTO_DETECTION_photo
  ON dbo.RETSC_EX_SHELFPHOTO_DETECTION (Photo_id);
GO

-- Índice filtrado: acelera tanto el share-de-góndola (Sku_id IS NOT NULL, sección 8.1) como
-- el listado de "no identificados" del dashboard web (Sku_id IS NULL, sección 8.4) sin que
-- ambos casos compitan por el mismo índice no filtrado.
CREATE INDEX IX_RETSC_EX_SHELFPHOTO_DETECTION_sku
  ON dbo.RETSC_EX_SHELFPHOTO_DETECTION (Sku_id)
  WHERE Sku_id IS NOT NULL;
GO

-- ─────────────────────────────────────────────────────────────────────────────
-- RETSC_OP_ASSORTMENT (sección 8.2 de la guía — "faltantes del surtido propio")
-- ─────────────────────────────────────────────────────────────────────────────
-- No existía ninguna tabla de surtido autorizado en el repo. category_id referencia el
-- árbol oficial RETSC_OP_CATEGORIES (igual que RETSC_EX_SHELFPHOTO.CATEGORY_ID), no el
-- client_category de texto libre de RETSC_OP_ENTERPRISE_PRODUCT_SEG.
CREATE TABLE dbo.RETSC_OP_ASSORTMENT (
  Assortment_id  INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  enterprise_id  INT          NOT NULL,
  sku_id         INT          NOT NULL,
  category_id    INT          NOT NULL,
  is_mandatory   BIT          NOT NULL CONSTRAINT DF_RETSC_OP_ASSORTMENT_mandatory DEFAULT (1),
  created_at     DATETIME     NOT NULL CONSTRAINT DF_RETSC_OP_ASSORTMENT_created DEFAULT (GETDATE()),
  CONSTRAINT UQ_RETSC_OP_ASSORTMENT_enterprise_sku_category UNIQUE (enterprise_id, sku_id, category_id),
  CONSTRAINT FK_RETSC_OP_ASSORTMENT_enterprise FOREIGN KEY (enterprise_id) REFERENCES dbo.RETSC_OP_ENTERPRISE (Enterprise_id),
  CONSTRAINT FK_RETSC_OP_ASSORTMENT_sku        FOREIGN KEY (sku_id)        REFERENCES dbo.RETSC_OP_SKUS (SKU_ID),
  CONSTRAINT FK_RETSC_OP_ASSORTMENT_category   FOREIGN KEY (category_id)   REFERENCES dbo.RETSC_OP_CATEGORIES (Category_id)
);
GO

CREATE INDEX IX_RETSC_OP_ASSORTMENT_enterprise_category
  ON dbo.RETSC_OP_ASSORTMENT (enterprise_id, category_id);
GO

-- Verificación
SELECT 'RETSC_EX_VISIT' AS tbl, COUNT(*) AS filas FROM dbo.RETSC_EX_VISIT
UNION ALL
SELECT 'RETSC_EX_SHELFPHOTO_DETECTION', COUNT(*) FROM dbo.RETSC_EX_SHELFPHOTO_DETECTION
UNION ALL
SELECT 'RETSC_OP_ASSORTMENT', COUNT(*) FROM dbo.RETSC_OP_ASSORTMENT;
