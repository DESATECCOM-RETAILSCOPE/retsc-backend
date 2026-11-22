#!/usr/bin/env bash
# =============================================================================
# pruebas_adm_paso5.sh — Pruebas del paso 5 (facturas y pagos) contra el backend en QA.
#
# QUÉ HACE: lanza peticiones con curl y compara el código HTTP (y algunos valores de la
# respuesta, como el vencimiento o el saldo) con lo esperado. Imprime PASA / FALLA por cada una.
#
# ADVERTENCIA: estas pruebas ESCRIBEN datos reales en las tablas RETSC_ADM_* de QA
# (facturas, pagos y filas de bitácora). No hacen rollback. Úsalas SOLO contra QA y con
# una empresa de prueba. Los números de factura empiezan con PRUEBA- (regla de la spec).
#
# REQUISITOS: curl y node (node se usa para leer el JSON de las respuestas y calcular fechas;
# no se necesita jq). El backend debe estar corriendo apuntando a la base de QA.
#
# USO (variables de entorno, sin guardarlas en ningún archivo):
#   BASE=http://localhost:3000 \
#   DTC_TOKEN='<token de un usuario ADMIN_DTC>' \
#   CLIENT_TOKEN='<token de un ADMIN o GERENCIA de la empresa de prueba>' \
#   ENT_ID=<Enterprise_id de la empresa de prueba> \
#   OTHER_ENT_ID=<Enterprise_id de OTRA empresa> \
#   CONTRACT_ID=<Contract_id del contrato de prueba> \
#   ./pruebas_adm_paso5.sh
#
# IMPORTANTE:
#   - CLIENT_TOKEN debe pertenecer a un usuario de la empresa ENT_ID.
#   - CONTRACT_ID debe ser un contrato ACTIVO de ENT_ID, en USD, con método OC_FACTURA,
#     30 días de crédito y SIN exigir OC (Requires_po = 0). Si el plazo no es 30, las
#     comprobaciones de vencimiento fallan.
#   - Los tokens se obtienen haciendo login (POST /api/auth/login) en QA.
#   - Se puede repetir: cada ejecución usa números de factura nuevos (PRUEBA-<fecha y hora>-A/B).
# =============================================================================

# Falla si falta alguna variable obligatoria (la sintaxis ${VAR:?msg} aborta con el mensaje)
: "${BASE:?Falta BASE (ej. http://localhost:3000)}"
: "${DTC_TOKEN:?Falta DTC_TOKEN}"
: "${CLIENT_TOKEN:?Falta CLIENT_TOKEN}"
: "${ENT_ID:?Falta ENT_ID}"
: "${OTHER_ENT_ID:?Falta OTHER_ENT_ID}"
: "${CONTRACT_ID:?Falta CONTRACT_ID}"

PASAN=0
FALLAN=0
TMP="$(mktemp)"          # archivo temporal donde se guarda el cuerpo de cada respuesta
trap 'rm -f "$TMP"' EXIT # lo borra al terminar, pase lo que pase

# probar <nombre> <código(s) esperado(s), ej. 200 o 200|201> <método> <ruta> <token o "-"> [cuerpo JSON]
# (misma función que pruebas_adm_paso2.sh)
probar() {
  local nombre="$1" esperado="$2" metodo="$3" ruta="$4" token="$5" cuerpo="${6:-}"
  # Argumentos de curl: -s silencioso, -o guarda el cuerpo, -w imprime el código HTTP
  local args=(-s -o "$TMP" -w '%{http_code}' -X "$metodo" "$BASE$ruta")
  # Solo se manda el header de autorización si hay token ("-" significa "sin token")
  if [ "$token" != "-" ]; then args+=(-H "Authorization: Bearer $token"); fi
  # Solo se manda cuerpo si se indicó uno
  if [ -n "$cuerpo" ]; then args+=(-H 'Content-Type: application/json' -d "$cuerpo"); fi

  local codigo
  codigo="$(curl "${args[@]}")"

  # "esperado" puede traer varios códigos separados por | (ej. 200|201). Se rodea con | a ambos
  # lados para comparar códigos completos y no pedazos (así 20 no coincide con 200).
  if [[ "|$esperado|" == *"|$codigo|"* ]]; then
    echo "PASA   [$codigo] $nombre"; PASAN=$((PASAN + 1))
  else
    echo "FALLA  [$codigo, esperaba $esperado] $nombre"; FALLAN=$((FALLAN + 1))
  fi
  echo "       $(head -c 300 "$TMP")"   # primeros 300 caracteres de la respuesta
  echo
}

# campo <expresión> — lee un valor del JSON de la ÚLTIMA respuesta (guardada en $TMP).
# La expresión se aplica sobre el objeto "r", por ejemplo: campo 'r.invoice.dueDate'.
# Si la respuesta no es JSON o el campo no existe, imprime vacío (y la comprobación falla).
campo() {
  node -pe "try { const r = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); String(($1) ?? '') } catch { '' }" -- "$TMP"
}

# verificar <nombre> <esperado> <obtenido> — compara dos textos y cuenta PASA / FALLA.
verificar() {
  if [ "$2" == "$3" ]; then
    echo "PASA   $1 (= $3)"; PASAN=$((PASAN + 1))
  else
    echo "FALLA  $1 (esperaba '$2', se obtuvo '$3')"; FALLAN=$((FALLAN + 1))
  fi
  echo
}

# fecha <días> — "hoy" en hora de Costa Rica (UTC-6, sin horario de verano) más N días,
# como AAAA-MM-DD. Se resta 6 horas a la hora UTC actual y se toma la parte de la fecha.
fecha() {
  node -pe "new Date(Date.now() - 6 * 3600e3 + Number(process.argv[1]) * 864e5).toISOString().slice(0, 10)" -- "$1"
}

HOY_MENOS_100="$(fecha -100)"
HOY_MENOS_70="$(fecha -70)"
HOY_MENOS_10="$(fecha -10)"
HOY_MAS_20="$(fecha 20)"
HOY="$(fecha 0)"

# Números únicos por ejecución: PRUEBA- + fecha y hora (así el script se puede repetir).
SELLO="$(date +%Y%m%d%H%M%S)"
NUM_A="PRUEBA-$SELLO-A"
NUM_B="PRUEBA-$SELLO-B"

# Cuerpo de factura: factura <número> <emisión> [recibido] [moneda] [total]
# Subtotal 1000 + impuesto 130 = total 1130 (salvo que se pase otro total para probar el error).
factura() {
  local numero="$1" emision="$2" recibido="${3:-}" moneda="${4:-USD}" total="${5:-1130}"
  local extra=""
  if [ -n "$recibido" ]; then extra=",\"receivedDate\":\"$recibido\""; fi
  printf '{"contractId":%s,"invoiceNumber":"%s","issueDate":"%s"%s,"subtotal":1000,"taxAmount":130,"totalAmount":%s,"currency":"%s"}' \
    "$CONTRACT_ID" "$numero" "$emision" "$extra" "$total" "$moneda"
}

# Cuerpo de pago: pago <monto>
pago() {
  printf '{"paymentDate":"%s","amount":%s,"currency":"USD","method":"TRANSFERENCIA","reference":"PRUEBA-%s"}' \
    "$HOY" "$1" "$SELLO"
}

echo "=== Seguridad básica ==="
probar "Sin token -> 401"                                  401 GET  "/api/adm/invoices" "-"
probar "Cliente intenta registrar factura -> 403"          403 POST "/api/adm/invoices" "$CLIENT_TOKEN" "$(factura "$NUM_A-CLIENTE" "$HOY_MENOS_100")"

echo "=== Registro de facturas y vencimiento ==="
probar "DTC registra factura A (emitida hoy-100, sin recibido) -> 201" 201 POST "/api/adm/invoices" "$DTC_TOKEN" "$(factura "$NUM_A" "$HOY_MENOS_100")"
INVOICE_A="$(campo 'r.invoice.invoiceId')"
verificar "Factura A vence hoy-70 (emisión + 30)" "$HOY_MENOS_70" "$(campo 'r.invoice.dueDate')"
verificar "Factura A copia 30 días de crédito del contrato" "30" "$(campo 'r.invoice.creditDays')"
verificar "Factura A nace REGISTRADA" "REGISTRADA" "$(campo 'r.invoice.status')"

probar "DTC registra factura B (emitida hoy-100, recibida hoy-10) -> 201" 201 POST "/api/adm/invoices" "$DTC_TOKEN" "$(factura "$NUM_B" "$HOY_MENOS_100" "$HOY_MENOS_10")"
verificar "Factura B vence hoy+20 (recibido + 30)" "$HOY_MAS_20" "$(campo 'r.invoice.dueDate')"

echo "=== Validaciones de factura (422) ==="
probar "Número duplicado en el contrato -> 422"            422 POST "/api/adm/invoices" "$DTC_TOKEN" "$(factura "$NUM_A" "$HOY_MENOS_100")"
verificar "El 422 del duplicado marca invoiceNumber" "invoiceNumber" "$(campo 'r.field')"
probar "Total que no cuadra (1000 + 130 != 1131) -> 422"   422 POST "/api/adm/invoices" "$DTC_TOKEN" "$(factura "$NUM_A-T" "$HOY_MENOS_100" "" "USD" 1131)"
verificar "El 422 del total marca totalAmount" "totalAmount" "$(campo 'r.field')"
probar "Moneda distinta a la del contrato (CRC) -> 422"    422 POST "/api/adm/invoices" "$DTC_TOKEN" "$(factura "$NUM_A-M" "$HOY_MENOS_100" "" "CRC")"
verificar "El 422 de la moneda marca currency" "currency" "$(campo 'r.field')"

echo "=== Pagos de la factura A (total 1130) ==="
probar "Pago parcial de 500 -> 201"                        201 POST "/api/adm/invoices/$INVOICE_A/payments" "$DTC_TOKEN" "$(pago 500)"
verificar "Saldo después del pago parcial" "630" "$(campo 'r.invoiceBalance.balance')"
verificar "Estado de pago después del pago parcial" "PARCIAL" "$(campo 'r.invoiceBalance.paymentStatus')"

probar "Pago de 700 (supera el saldo de 630) -> 422"       422 POST "/api/adm/invoices/$INVOICE_A/payments" "$DTC_TOKEN" "$(pago 700)"
verificar "El 422 del pago marca amount" "amount" "$(campo 'r.field')"

probar "Pago de 630 (salda la factura) -> 201"             201 POST "/api/adm/invoices/$INVOICE_A/payments" "$DTC_TOKEN" "$(pago 630)"
PAYMENT_630="$(campo 'r.payment.paymentId')"
verificar "Estado de pago después de saldar" "PAGADA" "$(campo 'r.invoiceBalance.paymentStatus')"

probar "Anular el pago de 630 -> 200"                      200 POST "/api/adm/payments/$PAYMENT_630/void" "$DTC_TOKEN" '{"reason":"PRUEBA: anulación de prueba"}'
verificar "Saldo después de anular el pago" "630" "$(campo 'r.invoiceBalance.balance')"

echo "=== Lo que ve el cliente ==="
probar "Cliente lista SUS facturas -> 200"                 200 GET  "/api/adm/invoices" "$CLIENT_TOKEN"
verificar "Todas las facturas que recibe son de su empresa" "true" "$(campo "r.invoices.length > 0 && r.invoices.every((i) => i.enterpriseId === $ENT_ID)")"
verificar "La factura A está en su lista" "true" "$(campo "r.invoices.some((i) => i.invoiceId === $INVOICE_A)")"
probar "Cliente pide OTRA empresa -> 404 (no 403)"         404 GET  "/api/adm/invoices?enterpriseId=$OTHER_ENT_ID" "$CLIENT_TOKEN"

echo "=== Filtro de vencidas ==="
probar "DTC lista vencidas (?overdue=1) -> 200"            200 GET  "/api/adm/invoices?enterpriseId=$ENT_ID&overdue=1" "$DTC_TOKEN"
verificar "La factura A (vencida hace 70 días, con saldo) aparece en ?overdue=1" "true" "$(campo "r.invoices.some((i) => i.invoiceId === $INVOICE_A)")"

echo "============================================================"
echo "Resumen: $PASAN pasan, $FALLAN fallan"
echo "============================================================"
[ "$FALLAN" -eq 0 ]   # el script termina con éxito solo si no hubo fallos
