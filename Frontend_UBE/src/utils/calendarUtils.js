/**
 * Retorna la fecha del lunes de la semana laboral "vigente" para `d`.
 * Lunes a viernes → el lunes de esa misma semana. Sábado y domingo → el lunes
 * SIGUIENTE (la grilla es lun-vie; mostrar la semana que ya terminó no sirve).
 * Antes sábado y domingo se comportaban distinto entre sí (sábado retrocedía a la
 * semana que estaba terminando y domingo saltaba a la siguiente).
 */
export function getLunes(d) {
  const dt = new Date(d);
  const day = dt.getDay(); // 0=domingo … 6=sábado
  const diff = day === 0 ? 1 : (day === 6 ? 2 : 1 - day);
  dt.setDate(dt.getDate() + diff);
  return dt;
}

/**
 * Filtra los bloques que caen en la celda (diaIndex, hora) de una grilla semanal,
 * deduplicando por `fecha_hora_inicio` + campus para evitar repetidos. Se conserva
 * un representante por (hora, campus): así un mismo horario con disponibilidad en
 * varios campus mantiene un bloque por cada uno (necesario para que el selector de
 * campus en AgendarHora ofrezca todas las sedes). Varios profesionales en el mismo
 * horario y campus sí se colapsan a uno (el balanceo de carga elige luego).
 *
 * @param {Array}  blocks    - Array de bloques ya pre-filtrados (ej: bloquesAdminFiltrados)
 * @param {Date}   fechaBase - Lunes de la semana mostrada
 * @param {number} diaIndex  - 0=lunes … 4=viernes
 * @param {string} hora      - "09:00", "10:00", …
 */
export function getBlocksForCell(blocks, fechaBase, diaIndex, hora) {
  const fechaDia = new Date(fechaBase);
  fechaDia.setDate(fechaBase.getDate() + diaIndex);
  const anio = fechaDia.getFullYear();
  const mes  = String(fechaDia.getMonth() + 1).padStart(2, '0');
  const dia  = String(fechaDia.getDate()).padStart(2, '0');
  const fechaStr   = `${anio}-${mes}-${dia}`;
  const prefijoHora = hora.split(':')[0];

  const bloquesDeLaHora = blocks.filter(b => {
    if (!b.fecha_hora_inicio) return false;
    const [bFechaStr, bHoraStr] = b.fecha_hora_inicio.replace(' ', 'T').split('T');
    return bFechaStr === fechaStr && bHoraStr.split(':')[0] === prefijoHora;
  });

  const unicos = [];
  const vistos = new Set();
  for (const b of bloquesDeLaHora) {
    const campus = b.ubicacion?.id_ubicacion || '__none__';
    const clave = `${b.fecha_hora_inicio}__${campus}`;
    if (!vistos.has(clave)) {
      vistos.add(clave);
      unicos.push(b);
    }
  }
  return unicos;
}

/**
 * Construye un Set de claves "dia|HH:MM" (día en minúsculas sin tilde:
 * lunes, martes, miercoles, jueves, viernes) a partir de los bloques con
 * disponibilidad. Sirve para deshabilitar esos slots en las grillas de
 * lista de espera: si ya hay una hora disponible (p. ej. martes 09:00),
 * no tiene sentido anotarse en espera para ese mismo día+hora, hay que
 * reservarla directo. El backend empareja la espera por día-de-semana +
 * hora exacta (strftime "%H:%M"), así que la clave usa ese mismo formato.
 *
 * @param {Array} bloques - Bloques disponibles (respuesta de /disponibilidad,
 *                          idealmente ya filtrados por los campus elegidos).
 * @returns {Set<string>} claves "dia|HH:MM"
 */
export function getSlotsConDisponibilidad(bloques) {
  const dias = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
  const set = new Set();
  (Array.isArray(bloques) ? bloques : []).forEach(b => {
    if (!b?.fecha_hora_inicio) return;
    const [fechaStr, horaStr] = b.fecha_hora_inicio.replace(' ', 'T').split('T');
    if (!fechaStr || !horaStr) return;
    const [anio, mes, dia] = fechaStr.split('-').map(Number);
    const nombreDia = dias[new Date(anio, mes - 1, dia).getDay()];
    set.add(`${nombreDia}|${horaStr.substring(0, 5)}`);
  });
  return set;
}

/**
 * Para servicios cíclicos, colapsa la serie de bloques al primer bloque
 * de cada combinación (día-semana, hora, profesional).
 * Para servicios no cíclicos, devuelve el array sin cambios.
 *
 * @param {Array}   blocks   - Array de bloques disponibles
 * @param {boolean} isCyclic - true si el servicio es cíclico
 */
export function deduplicateCyclicBlocks(blocks, isCyclic) {
  if (!isCyclic) return blocks;
  const unicos = {};
  blocks.forEach(b => {
    const fechaObj   = new Date(b.fecha_hora_inicio);
    const diaSemana  = fechaObj.getDay();
    const hora       = fechaObj.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const profesional = `${b.profesional.nombres} ${b.profesional.apellidos}`;
    const key = `${diaSemana}-${hora}-${profesional}`;
    if (!unicos[key] || new Date(b.fecha_hora_inicio) < new Date(unicos[key].fecha_hora_inicio)) {
      unicos[key] = b;
    }
  });
  return Object.values(unicos).sort((a, b) =>
    new Date(a.fecha_hora_inicio) - new Date(b.fecha_hora_inicio)
  );
}

/**
 * Genera los sub-slots de una fila-hora del calendario, ENCADENADOS de forma
 * continua desde el inicio del día (08:00). Todos los servicios arrancan a las
 * 08:00 y cada slot dura `duracionMin`. Para servicios cuya duración NO divide 60
 * (ej. 45 min) los slots no se reinician cada hora: 08:00-08:45, 08:45-09:30,
 * 09:30-10:15… Cada slot aparece en la fila-hora donde arranca; una fila puede
 * quedar con 0, 1 o 2 slots. Se topea en 18:00 (ningún slot termina después).
 *
 * Para duraciones que sí dividen 60 (60/30/20/15) el resultado es idéntico al
 * alineado de siempre (cada fila = HH:00 en adelante), así que las grillas de esos
 * servicios se ven exactamente igual que antes.
 *
 * @param {string} hora        - fila-hora del grid, "08:00" … "17:00"
 * @param {number} duracionMin - duración del servicio en minutos (fallback 60)
 * @returns {Array<{inicio: string, fin: string}>}
 */
export function getSubSlots(hora, duracionMin) {
  const dur = duracionMin || 60;
  const DIA_INICIO = 8 * 60;   // 08:00 — primera hora de TODOS los servicios
  const DIA_FIN = 18 * 60;     // 18:00 — tope: ningún slot puede terminar después
  const filaInicio = parseInt(hora.split(':')[0], 10) * 60;
  const filaFin = filaInicio + 60;
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const slots = [];
  // Primer eslabón de la cadena continua (desde las 08:00) cuyo inicio cae en esta fila.
  const offset = filaInicio - DIA_INICIO;
  let k = offset > 0 ? Math.ceil(offset / dur) : 0;
  for (;;) {
    const ini = DIA_INICIO + k * dur;
    if (ini >= filaFin) break;
    const fin = ini + dur;
    if (ini >= filaInicio && fin <= DIA_FIN) slots.push({ inicio: fmt(ini), fin: fmt(fin) });
    k++;
  }
  return slots;
}
