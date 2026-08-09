# DB Schema — sqldb-rscope-qa (sql-rscope-prod.database.windows.net)

Generado automáticamente por `scripts/dump-schema.js` contra la BD real (solo lectura). No editar a mano — volver a correr el script si la BD cambia.

Total de tablas: 31

## Índice

- [RETSC_AI_DETECTION_MODELS](#retscaidetectionmodels)
- [RETSC_AI_METADATA_DEFINITIONS](#retscaimetadatadefinitions)
- [RETSC_AI_SKU_FEATURES](#retscaiskufeatures)
- [RETSC_AI_SKU_IMAGE_METADATA](#retscaiskuimagemetadata)
- [RETSC_AI_TRAINING_ANNOTATIONS](#retscaitrainingannotations)
- [RETSC_EX_KPI](#retscexkpi)
- [RETSC_EX_SHELFPHOTO](#retscexshelfphoto)
- [RETSC_EX_SHELFPHOTO_DETECTION](#retscexshelfphotodetection)
- [RETSC_EX_VISIT](#retscexvisit)
- [RETSC_INF_ACTIVATION_TOKENS](#retscinfactivationtokens)
- [RETSC_INF_BLOB_CONTAINERS](#retscinfblobcontainers)
- [RETSC_INF_GLOBAL_BLOB_CONTAINERS](#retscinfglobalblobcontainers)
- [RETSC_LOG_IMAGE_UPLOAD](#retsclogimageupload)
- [RETSC_LOG_JOBS](#retsclogjobs)
- [RETSC_LOG_SKU_UPLOAD](#retsclogskuupload)
- [RETSC_OP_ASSORTMENT](#retscopassortment)
- [RETSC_OP_CATEGORIES](#retscopcategories)
- [RETSC_OP_ENTERPRISE](#retscopenterprise)
- [RETSC_OP_ENTERPRISE_CATEGORIES](#retscopenterprisecategories)
- [RETSC_OP_ENTERPRISE_PRODUCT_SEG](#retscopenterpriseproductseg)
- [RETSC_OP_PLANOGRAM](#retscopplanogram)
- [RETSC_OP_PLANOGRAMDET](#retscopplanogramdet)
- [RETSC_OP_RETAILER](#retscopretailer)
- [RETSC_OP_ROLES](#retscoproles)
- [RETSC_OP_SKU_COUNTRY](#retscopskucountry)
- [RETSC_OP_SKUS](#retscopskus)
- [RETSC_OP_SMKTCHAINS](#retscopsmktchains)
- [RETSC_OP_SMKTFORMATS](#retscopsmktformats)
- [RETSC_OP_USERS](#retscopusers)
- [RETSC_OP_USRSXENTERP](#retscopusrsxenterp)
- [sysdiagrams](#sysdiagrams)

## RETSC_AI_DETECTION_MODELS

Filas: ~0

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| detection_model_id | int | NO |  | PK | IDENTITY |
| category_id | int | NO |  |  |  |
| model_name | varchar(100) | YES |  |  |  |
| customvision_project_id | varchar(100) | YES |  |  |  |
| prediction_resource_id | varchar(100) | YES |  |  |  |
| status | varchar(20) | YES |  |  |  |
| trained_at | datetime | YES |  |  |  |
| created_at | datetime | YES | (getdate()) |  |  |
| model_version | int | YES | ((1)) |  |  |
| last_publish_name | varchar(100) | YES |  |  |  |
| confidence_threshold | decimal | NO |  |  |  |
| is_active | bit | YES | ((1)) |  |  |

FKs:
- `category_id` → `RETSC_OP_CATEGORIES.Category_id` (FK_DETECTIONMODEL_CATEGORY)

Índices:
- `IX_DETMODEL_CATEGORY` (category_id)
- `IX_DETMODEL_STATUS` (status)

## RETSC_AI_METADATA_DEFINITIONS

Filas: ~9

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| metadata_definition_id | int | NO |  | PK | IDENTITY |
| metadata_key | varchar(100) | NO |  |  |  |
| data_type | varchar(30) | NO |  |  |  |
| description | varchar(500) | YES |  |  |  |
| allowed_values | varchar(500) | YES |  |  |  |
| module_origin | varchar(50) | YES |  |  |  |
| is_active | bit | NO | ((1)) |  |  |
| created_at | datetime | NO | (getdate()) |  |  |

Índices:
- UNIQUE `UQ__RETSC_AI__5611F6FE84AE8D7D` (metadata_key)

## RETSC_AI_SKU_FEATURES

Filas: ~0

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| feature_id | int | NO |  | PK | IDENTITY |
| sku_id | int | NO |  |  |  |
| image_url | varchar(500) | YES |  |  |  |
| image_hash | varchar(100) | YES |  |  |  |
| ocr_text | nvarchar(MAX) | YES |  |  |  |
| embedding_status | varchar(20) | YES |  |  |  |
| validation_status | varchar(20) | YES |  |  |  |
| confidence | float | YES |  |  |  |
| processed_at | datetime | YES | (getdate()) |  |  |
| feature_vector_id | varchar(200) | YES |  |  |  |
| ocr_language | varchar(20) | YES |  |  |  |
| created_at | datetime | YES |  |  |  |
| is_primary | bit | NO | ((0)) |  |  |

FKs:
- `sku_id` → `RETSC_OP_SKUS.SKU_ID` (FK_SKUFEATURES_SKU)

Índices:
- `IX_SKUFEATURES_SKU` (sku_id)
- `IX_SKUFEATURES_VALIDATION` (validation_status)

## RETSC_AI_SKU_IMAGE_METADATA

Filas: ~0

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| image_metadata_id | bigint | NO |  | PK | IDENTITY |
| feature_id | int | NO |  |  |  |
| metadata_key | nvarchar(100) | NO |  |  |  |
| metadata_value | nvarchar(1000) | YES |  |  |  |
| created_at | datetime | NO | (getdate()) |  |  |
| metadata_definition_id | int | YES |  |  |  |

FKs:
- `metadata_definition_id` → `RETSC_AI_METADATA_DEFINITIONS.metadata_definition_id` (FK_AI_SKU_METADATA_DEFINITION)
- `feature_id` → `RETSC_AI_SKU_FEATURES.feature_id` (FK_RETSC_METADATA_FEATURE)

Índices:
- `IX_RETSC_METADATA_FEATURE` (feature_id)
- `IX_RETSC_METADATA_KEY` (metadata_key)

## RETSC_AI_TRAINING_ANNOTATIONS

Filas: ~0

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| annotation_id | int | NO |  | PK | IDENTITY |
| photo_id | int | YES |  |  |  |
| dtc_category_id | int | YES |  |  |  |
| bbox_left | float | YES |  |  |  |
| bbox_top | float | YES |  |  |  |
| bbox_width | float | YES |  |  |  |
| bbox_height | float | YES |  |  |  |
| source | varchar(20) | YES |  |  |  |
| is_validated | bit | YES |  |  |  |
| created_at | datetime | YES | (getdate()) |  |  |
| photo_approved | bit | YES |  |  |  |
| photo_notes | varchar(250) | YES |  |  |  |
| photo_reviewed_at | datetime | YES |  |  |  |
| photo_reviewer_id | int | YES |  |  |  |
| cv_region_id | varchar(100) | YES |  |  |  |
| canal | varchar(20) | NO | ('SIN-CANAL') |  |  |
| blob_path | varchar(500) | YES |  |  |  |
| cv_sync_status | varchar(20) | NO | ('SYNCED') |  |  |
| cv_sync_error | varchar(500) | YES |  |  |  |
| cv_sync_attempts | int | NO | ((0)) |  |  |

Índices:
- `IX_RETSC_AI_TRAINING_ANNOTATIONS_blob_path` (blob_path)

## RETSC_EX_KPI

Filas: ~0

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| kpi_id | bigint | NO |  | PK | IDENTITY |
| photo_id | int | NO |  |  |  |
| visit_id | int | YES |  |  |  |
| enterprise_id | int | YES |  |  |  |
| planogram_sku_id | int | YES |  |  |  |
| status_compliance | varchar(20) | YES |  |  |  |
| facings_eval | float | YES |  |  |  |
| position_eval | float | YES |  |  |  |
| compliance_score | float | YES |  |  |  |
| observations | varchar(250) | YES |  |  |  |
| created_at | datetime | NO | (getdate()) |  |  |
| Product_seq | int | YES |  |  |  |

FKs:
- `photo_id` → `RETSC_EX_SHELFPHOTO.Photo_id` (FK_RETSC_EX_KPI_PHOTO)
- `visit_id` → `RETSC_EX_VISIT.Visit_id` (FK_RETSC_EX_KPI_VISIT)
- `Product_seq` → `RETSC_OP_PLANOGRAMDET.Product_seq` (FK_RETSC_EX_KPI_PLANOGRAMDET)
- `enterprise_id` → `RETSC_OP_ENTERPRISE.Enterprise_id` (FK_RETSC_EX_KPI_ENTERPRISE)

## RETSC_EX_SHELFPHOTO

Filas: ~0

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| Retailer_id | int | YES |  |  |  |
| Photo_id | int | NO |  | PK | IDENTITY |
| Shelfunit_id | int | YES |  |  |  |
| photo_date | date | YES |  |  |  |
| URL_blob | nvarchar(250) | YES |  |  |  |
| ENTERPRISE_ID | int | YES |  |  |  |
| CATEGORY_ID | int | YES |  |  |  |
| visit_id | int | YES |  |  |  |
| image_hash | varchar(64) | YES |  |  |  |
| quality_status | varchar(20) | YES |  |  |  |
| quality_error_code | varchar(30) | YES |  |  |  |
| width | int | YES |  |  |  |
| height | int | YES |  |  |  |
| blur_score | float | YES |  |  |  |
| brightness | float | YES |  |  |  |

FKs:
- `ENTERPRISE_ID` → `RETSC_OP_ENTERPRISE.Enterprise_id` (FK_SHELFPHOTO_ENTERPRISE)
- `CATEGORY_ID` → `RETSC_OP_CATEGORIES.Category_id` (FK_SHELFPHOTO_CATEGORY)
- `visit_id` → `RETSC_EX_VISIT.Visit_id` (FK_SHELFPHOTO_VISIT)
- `Retailer_id` → `RETSC_OP_RETAILER.Retailer_id` (FK_SHELFPHOTO_RETAILER)

Índices:
- `IX_RETSC_EX_SHELFPHOTO_quality_status` (quality_status)
- `IX_SHELFPHOTO_CATEGORY` (CATEGORY_ID)
- UNIQUE `UX_RETSC_EX_SHELFPHOTO_enterprise_hash` (ENTERPRISE_ID, image_hash) WHERE ([image_hash] IS NOT NULL)

## RETSC_EX_SHELFPHOTO_DETECTION

Filas: ~0

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| Detection_id | int | NO |  | PK | IDENTITY |
| Photo_id | int | NO |  |  |  |
| EAN | varchar(18) | YES |  |  |  |
| Sku_id | int | YES |  |  |  |
| Confidence | float | YES |  |  |  |
| Bbox_left | float | YES |  |  |  |
| Bbox_top | float | YES |  |  |  |
| Bbox_width | float | YES |  |  |  |
| Bbox_height | float | YES |  |  |  |
| created_at | datetime | YES | (getdate()) |  |  |
| detection_model_id | int | YES |  |  |  |

FKs:
- `detection_model_id` → `RETSC_AI_DETECTION_MODELS.detection_model_id` (FK_EX_DETECTION_MODEL)
- `Sku_id` → `RETSC_OP_SKUS.SKU_ID` (FK_detection_sku)
- `Photo_id` → `RETSC_EX_SHELFPHOTO.Photo_id` (FK_detection_shelfphoto)

## RETSC_EX_VISIT

Filas: ~0

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| Visit_id | int | NO |  | PK | IDENTITY |
| User_id | int | NO |  |  |  |
| Enterprise_id | int | NO |  |  |  |
| Retailer_id | int | NO |  |  |  |
| Visit_start | datetime | NO |  |  |  |
| Visit_end | datetime | YES |  |  |  |
| Latitude | float | YES |  |  |  |
| Longitude | float | YES |  |  |  |
| Status | varchar(20) | YES |  |  |  |
| Notes | nvarchar(250) | YES |  |  |  |

## RETSC_INF_ACTIVATION_TOKENS

Filas: ~0

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| token_id | int | NO |  | PK | IDENTITY |
| token | varchar(128) | NO |  |  |  |
| enterprise_id | int | NO |  |  |  |
| admin_email | varchar(255) | NO |  |  |  |
| created_at | datetime2 | NO | (getutcdate()) |  |  |
| expires_at | datetime2 | NO |  |  |  |
| used | bit | NO | ((0)) |  |  |
| used_at | datetime2 | YES |  |  |  |

FKs:
- `enterprise_id` → `RETSC_OP_ENTERPRISE.Enterprise_id` (FK_ACTIVATION_ENTERPRISE)

Índices:
- `IX_ACTIVATION_ENTERPRISE` (enterprise_id)
- `IX_ACTIVATION_TOKEN` (token)
- UNIQUE `UQ__RETSC_IN__CA90DA7AF00BD968` (token)

## RETSC_INF_BLOB_CONTAINERS

Filas: ~0

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| container_id | int | NO |  | PK | IDENTITY |
| container_name | nvarchar(150) | NO |  |  |  |
| container_type | varchar(30) | NO |  |  |  |
| enterprise_id | int | YES |  |  |  |
| description | nvarchar(300) | YES |  |  |  |
| storage_account | nvarchar(150) | YES |  |  |  |
| status | tinyint | NO | ((1)) |  |  |
| created_at | datetime | NO | (getdate()) |  |  |
| category_id | int | YES |  |  |  |

FKs:
- `enterprise_id` → `RETSC_OP_ENTERPRISE.Enterprise_id` (FK_RETSC_BLOB_ENTERPRISE)
- `category_id` → `RETSC_OP_CATEGORIES.Category_id` (FK_RETSC_BLOB_CATEGORY)

Índices:
- `IX_RETSC_BLOB_ENTERPRISE` (enterprise_id)
- `IX_RETSC_BLOB_TYPE` (container_type)
- UNIQUE `UQ_RETSC_BLOB_CONTAINER` (container_name)

## RETSC_INF_GLOBAL_BLOB_CONTAINERS

Filas: ~0

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| global_container_id | int | NO |  | PK | IDENTITY |
| category_id | int | NO |  |  |  |
| container_name | nvarchar(150) | NO |  |  |  |
| container_type | varchar(30) | NO |  |  |  |
| storage_account | nvarchar(150) | YES |  |  |  |
| description | nvarchar(300) | YES |  |  |  |
| status | tinyint | NO | ((1)) |  |  |
| created_at | datetime | NO | (getdate()) |  |  |
| prefix | varchar(100) | YES |  |  |  |

FKs:
- `category_id` → `RETSC_OP_CATEGORIES.Category_id` (FK_GLOBAL_BLOB_CATEGORY)

Índices:
- UNIQUE `UQ_RETSC_GLOBAL_BLOB_CONTAINER_NAME_PREFIX` (container_name, prefix)

## RETSC_LOG_IMAGE_UPLOAD

Filas: ~0

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| image_log_id | int | NO |  | PK | IDENTITY |
| enterprise_id | int | NO |  |  |  |
| upload_batch_id | uniqueidentifier | NO |  |  |  |
| sku_id | int | YES |  |  |  |
| ean | varchar(20) | YES |  |  |  |
| image_name | varchar(500) | YES |  |  |  |
| image_url | varchar(1000) | YES |  |  |  |
| image_hash | varchar(200) | YES |  |  |  |
| image_status | varchar(50) | YES |  |  |  |
| process_status | varchar(50) | NO |  |  |  |
| ocr_status | varchar(50) | YES |  |  |  |
| embeddings_status | varchar(50) | YES |  |  |  |
| error_code | varchar(100) | YES |  |  |  |
| error_message | varchar(1000) | YES |  |  |  |
| created_at | datetime | YES | (getdate()) |  |  |

FKs:
- `enterprise_id` → `RETSC_OP_ENTERPRISE.Enterprise_id` (FK_LOGIMG_ENTERPRISE)

Índices:
- `IX_LOGIMG_BATCH` (upload_batch_id)
- `IX_LOGIMG_SKU` (sku_id)
- `IX_LOGIMG_STATUS` (process_status)

## RETSC_LOG_JOBS

Filas: ~0

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| job_id | int | NO |  | PK | IDENTITY |
| user_id | int | NO |  |  |  |
| enterprise_id | int | YES |  |  |  |
| job_type | varchar(50) | NO |  |  |  |
| status | varchar(20) | NO | ('QUEUED') |  |  |
| total_files | int | NO | ((0)) |  |  |
| processed_count | int | NO | ((0)) |  |  |
| orphan_count | int | NO | ((0)) |  |  |
| duplicate_count | int | NO | ((0)) |  |  |
| error_count | int | NO | ((0)) |  |  |
| warning_count | int | NO | ((0)) |  |  |
| error_summary | nvarchar(MAX) | YES |  |  |  |
| created_at | datetime2 | NO | (getdate()) |  |  |
| started_at | datetime2 | YES |  |  |  |
| finished_at | datetime2 | YES |  |  |  |

Índices:
- `IX_RETSC_LOG_JOBS_created_at` (created_at)
- `IX_RETSC_LOG_JOBS_status` (status)
- `IX_RETSC_LOG_JOBS_user_id` (user_id)

## RETSC_LOG_SKU_UPLOAD

Filas: ~0

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| log_id | int | NO |  | PK | IDENTITY |
| enterprise_id | int | NO |  |  |  |
| upload_batch_id | uniqueidentifier | NO |  |  |  |
| row_number | int | YES |  |  |  |
| ean | varchar(20) | YES |  |  |  |
| sku_description | varchar(500) | YES |  |  |  |
| selected_category_id | int | YES |  |  |  |
| detection_category_id | int | YES |  |  |  |
| process_status | varchar(50) | NO |  |  |  |
| error_code | varchar(100) | YES |  |  |  |
| error_message | varchar(1000) | YES |  |  |  |
| created_at | datetime | YES | (getdate()) |  |  |

FKs:
- `enterprise_id` → `RETSC_OP_ENTERPRISE.Enterprise_id` (FK_LOGSKU_ENTERPRISE)
- `detection_category_id` → `RETSC_OP_CATEGORIES.Category_id` (FK_LOGSKU_DETECTIONCAT)
- `selected_category_id` → `RETSC_OP_CATEGORIES.Category_id` (FK_LOGSKU_SELECTEDCAT)

## RETSC_OP_ASSORTMENT

Filas: ~0

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| assortment_id | int | NO |  | PK | IDENTITY |
| enterprise_id | int | YES |  |  |  |
| category_id | int | YES |  |  |  |
| level_type | varchar(20) | YES |  |  |  |
| level_id | int | YES |  |  |  |
| is_mandatory | bit | YES | ((1)) |  |  |
| priority | int | YES | ((1)) |  |  |
| created_at | datetime | YES | (getdate()) |  |  |
| sku_id | int | NO |  |  |  |

FKs:
- `enterprise_id` → `RETSC_OP_ENTERPRISE.Enterprise_id` (FK_ASSORTMENT_ENTERPRISE)
- `sku_id` → `RETSC_OP_SKUS.SKU_ID` (FK_ASSORTMENT_SKU)

## RETSC_OP_CATEGORIES

Filas: ~0

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| Category_id | int | NO |  | PK | IDENTITY |
| Category_dsc | varchar(50) | YES |  |  |  |
| level_no | int | YES |  |  |  |
| parent_category_id | int | YES |  |  |  |
| is_smart_dtc | bit | NO | ((0)) |  |  |
| status | varchar(20) | NO | ('ACTIVE') |  |  |

FKs:
- `parent_category_id` → `RETSC_OP_CATEGORIES.Category_id` (FK_CATEGORY_PARENT)

Índices:
- `IX_CATEGORY_PARENT` (parent_category_id)
- UNIQUE `UX_CATEGORY_NAME` (Category_dsc)

## RETSC_OP_ENTERPRISE

Filas: ~7

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| Enterprise_id | int | NO |  | PK | IDENTITY |
| Fiscal_id | varchar(30) | YES |  |  |  |
| Enterprise_dsc | varchar(100) | YES |  |  |  |
| Country | varchar(30) | YES |  |  |  |
| Telephone | varchar(25) | YES |  |  |  |
| Address | varchar(200) | YES |  |  |  |
| State | varchar(50) | YES |  |  |  |
| County | varchar(50) | YES |  |  |  |
| City | varchar(50) | YES |  |  |  |
| Invoice_mail | varchar(50) | YES |  |  |  |
| Contact | varchar(60) | YES |  |  |  |
| Contact_mail | varchar(30) | YES |  |  |  |
| Contact_phone | varchar(25) | YES |  |  |  |
| Type | varchar(25) | YES |  |  |  |
| status | bit | YES | ((1)) |  |  |

## RETSC_OP_ENTERPRISE_CATEGORIES

Filas: ~0

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| enterprise_category_id | int | NO |  | PK | IDENTITY |
| enterprise_id | int | NO |  |  |  |
| selected_category_id | int | NO |  |  |  |
| created_at | datetime | YES | (getdate()) |  |  |
| resolved_category_id | int | YES |  |  |  |
| resolution_type | varchar(20) | YES |  |  |  |
| status | varchar(20) | NO | ('ACTIVE') |  |  |

FKs:
- `resolved_category_id` → `RETSC_OP_CATEGORIES.Category_id` (FK_ENTERPRISECAT_RESOLVED)
- `selected_category_id` → `RETSC_OP_CATEGORIES.Category_id` (FK_ENTERPRISECAT_SELECTED)
- `enterprise_id` → `RETSC_OP_ENTERPRISE.Enterprise_id` (FK_ENTCAT_ENTERPRISE)

Índices:
- `IX_ENTERPRISE_CATEGORY` (enterprise_id, selected_category_id)

## RETSC_OP_ENTERPRISE_PRODUCT_SEG

Filas: ~0

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| seg_id | int | NO |  | PK | IDENTITY |
| enterprise_id | int | NO |  |  |  |
| client_category | varchar(100) | YES |  |  |  |
| client_subcategory | varchar(100) | YES |  |  |  |
| status | varchar(20) | NO | ('ACTIVE') |  |  |
| created_at | datetime | NO | (getdate()) |  |  |
| updated_at | datetime | YES |  |  |  |
| Brand | varchar(50) | YES |  |  |  |
| Supplier | varchar(50) | YES |  |  |  |
| normalized_name | varchar(100) | YES |  |  |  |
| Relevant_feature | varchar(100) | YES |  |  |  |
| sku_id | int | NO |  |  |  |
| volume | decimal | YES |  |  |  |

FKs:
- `enterprise_id` → `RETSC_OP_ENTERPRISE.Enterprise_id` (FK_ENTPRODSEG_ENTERPRISE)
- `sku_id` → `RETSC_OP_SKUS.SKU_ID` (FK_ENTPRODSEG_SKU)

Índices:
- UNIQUE `UQ_RETSC_ENTERPRISE_SKU_SEG` (enterprise_id, sku_id)

## RETSC_OP_PLANOGRAM

Filas: ~0

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| Enterprise_id | int | NO |  |  |  |
| Category_id | int | NO |  |  |  |
| Supermarketchain_id | int | YES |  |  |  |
| Formato | varchar(30) | YES |  |  |  |
| Retailer_id | int | YES |  |  |  |
| Planogram_seq | int | NO |  | PK | IDENTITY |
| Up_date | date | YES |  |  |  |
| Down_date | date | YES |  |  |  |
| Status | varchar(10) | YES |  |  |  |
| Notes | nvarchar(255) | YES |  |  |  |
| Loaded_userid | int | YES |  |  |  |
| URL_picture | varchar(255) | YES |  |  |  |

FKs:
- `Enterprise_id` → `RETSC_OP_ENTERPRISE.Enterprise_id` (FK_PLANOGRAM_ENTERPRISE)
- `Category_id` → `RETSC_OP_CATEGORIES.Category_id` (FK_PLANOGRAM_CATEGORY)

## RETSC_OP_PLANOGRAMDET

Filas: ~0

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| Planogram_seq | int | NO |  |  |  |
| Product_seq | int | NO |  | PK | IDENTITY |
| Shelfunit_id | int | YES |  |  |  |
| Shelflevel_id | int | YES |  |  |  |
| Shelfcolumn_id | int | YES |  |  |  |
| Facings | int | YES |  |  |  |
| Height | float | YES |  |  |  |
| Width | float | YES |  |  |  |
| Depth | float | YES |  |  |  |
| sku_id | int | NO |  |  |  |

FKs:
- `sku_id` → `RETSC_OP_SKUS.SKU_ID` (FK_planogramdet_sku)
- `Planogram_seq` → `RETSC_OP_PLANOGRAM.Planogram_seq` (FK_PLANOGRAMDET_PLANOGRAM)

## RETSC_OP_RETAILER

Filas: ~0

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| Supermarketchain_id | int | NO |  |  |  |
| Formato | varchar(50) | NO |  |  |  |
| Retailer_id | int | NO |  | PK |  |
| Retailer_dsc | varchar(70) | YES |  |  |  |
| latitud | float | YES |  |  |  |
| longitud | float | YES |  |  |  |
| Ejecutivo_asignado | varchar(50) | YES |  |  |  |
| Zona | varchar(50) | YES |  |  |  |
| Prioridad | smallint | YES |  |  |  |
| Canal | varchar(12) | YES |  |  |  |
| pais_dsc | varchar(30) | YES |  |  |  |

FKs:
- `Supermarketchain_id` → `RETSC_OP_SMKTCHAINS.Supermarketchain_id` (FK_RETAILER_CHAIN)
- `Supermarketchain_id` → `RETSC_OP_SMKTFORMATS.Supermarketchain_id` (FK_RETAILER_FORMAT)
- `Formato` → `RETSC_OP_SMKTFORMATS.Format` (FK_RETAILER_FORMAT)

## RETSC_OP_ROLES

Filas: ~5

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| Role_id | int | NO |  | PK | IDENTITY |
| Role_name | varchar(30) | NO |  |  |  |
| Description | varchar(100) | YES |  |  |  |
| Status | bit | NO | ((1)) |  |  |

## RETSC_OP_SKU_COUNTRY

Filas: ~0

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| sku_id | int | NO |  | PK |  |
| country | varchar(30) | NO |  | PK |  |

FKs:
- `sku_id` → `RETSC_OP_SKUS.SKU_ID` (FK__RETSC_OP___sku_i__7B264821)

## RETSC_OP_SKUS

Filas: ~0

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| SKU_ID | int | NO |  | PK | IDENTITY |
| EAN | varchar(18) | NO |  |  |  |
| image_url | varchar(250) | YES |  |  |  |
| creation_date | datetime | YES | (getdate()) |  |  |
| image_status | varchar(30) | YES |  |  |  |
| Product_dsc | varchar(100) | YES |  |  |  |
| status | varchar(20) | NO | ('ACTIVE') |  |  |
| selected_category_id | int | YES |  |  |  |
| detection_category_id | int | YES |  |  |  |

FKs:
- `detection_category_id` → `RETSC_OP_CATEGORIES.Category_id` (FK_SKUS_DETECTION_CAT)
- `selected_category_id` → `RETSC_OP_CATEGORIES.Category_id` (FK_SKUS_SELECTED_CAT)

Índices:
- UNIQUE `UQ__RETSC_OP__C1975A16BFA2DABF` (EAN)
- UNIQUE `UX_SKU_EAN` (EAN)

## RETSC_OP_SMKTCHAINS

Filas: ~0

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| Supermarketchain_id | int | NO |  | PK | IDENTITY |
| Supermarketchain | varchar(80) | YES |  |  |  |
| parentchain_id | int | YES |  |  |  |

FKs:
- `parentchain_id` → `RETSC_OP_SMKTCHAINS.Supermarketchain_id` (FK_SMKTCHAINS_PARENT)

## RETSC_OP_SMKTFORMATS

Filas: ~0

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| Supermarketchain_id | int | NO |  | PK |  |
| Format | varchar(50) | NO |  | PK |  |

FKs:
- `Supermarketchain_id` → `RETSC_OP_SMKTCHAINS.Supermarketchain_id` (FK_FORMAT_CHAIN)

## RETSC_OP_USERS

Filas: ~9

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| User_id | int | NO |  | PK | IDENTITY |
| User_name | varchar(80) | YES |  |  |  |
| Email | varchar(120) | YES |  |  |  |
| PasswordHash | varchar(200) | YES |  |  |  |
| Status | bit | YES |  |  |  |
| Created_date | datetime | YES |  |  |  |
| ced_identidad | varchar(50) | YES |  |  |  |

## RETSC_OP_USRSXENTERP

Filas: ~8

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| User_id | int | NO |  | PK |  |
| Enterprise_id | int | NO |  | PK |  |
| Role_id | int | NO |  |  |  |
| Status | bit | NO | ((1)) |  |  |
| Fecha_activacion | date | YES |  |  |  |
| Fecha_inactivacion | date | YES |  |  |  |
| Phone | varchar(25) | YES |  |  |  |

FKs:
- `User_id` → `RETSC_OP_USERS.User_id` (FK_USER_ENTERPRISE_USER)
- `Role_id` → `RETSC_OP_ROLES.Role_id` (FK_USER_ENTERPRISE_ROLE)
- `Enterprise_id` → `RETSC_OP_ENTERPRISE.Enterprise_id` (FK_USER_ENTERPRISE_ENTERPRISE)

## sysdiagrams

Filas: ~1

| Columna | Tipo | Nullable | Default | PK | Identity |
|---|---|---|---|---|---|
| name | nvarchar(128) | NO |  |  |  |
| principal_id | int | NO |  |  |  |
| diagram_id | int | NO |  | PK | IDENTITY |
| version | int | YES |  |  |  |
| definition | varbinary(MAX) | YES |  |  |  |

Índices:
- UNIQUE `UK_principal_name` (principal_id, name)

