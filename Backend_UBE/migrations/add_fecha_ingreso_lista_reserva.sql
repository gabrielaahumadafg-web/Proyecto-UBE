-- Métrica "Espera Promedio por Estudiante" (Profesional de Apoyo → pestaña Ocupación/Espera).
--
-- Preserva la fecha en que el estudiante entró a la lista de espera DENTRO de la reserva, para
-- poder medir después el tramo de espera "por lista de espera" de las atenciones ya recibidas.
-- Hasta ahora esa duración se perdía: al asignar el cupo, la fila de lista_espera se BORRA.
--
-- La columna es NULLABLE: null = reserva directa (el estudiante no pasó por la lista de espera,
-- así que su tramo de lista de espera es 0).
--
-- Correr UNA vez en el SQL Editor de Supabase. El backend ya escribe y lee esta columna, y
-- tolera su ausencia (try/except + reintento), así que puede desplegarse antes o después de
-- correr esto. IMPORTANTE: solo se llena desde ahora en adelante; las atenciones anteriores a la
-- migración no tienen el dato y mostrarán el tramo de lista de espera en 0.

ALTER TABLE reserva
  ADD COLUMN IF NOT EXISTS fecha_ingreso_lista timestamptz;

COMMENT ON COLUMN reserva.fecha_ingreso_lista IS
  'Fecha de ingreso a lista_espera preservada al asignar el cupo (null si la reserva fue directa). La usa /reportes/espera_comparativa para el desglose de espera por lista de espera vs reserva.';
