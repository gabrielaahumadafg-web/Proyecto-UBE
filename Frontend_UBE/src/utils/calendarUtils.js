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
 * Combina los sub-slots "teóricos" de una hora (alineados a la hora, con paso =
 * duración del servicio: p. ej. 09:00, 09:20, 09:40) con los bloques REALES de esa
 * celda. Soporta bloques que empiezan en CUALQUIER minuto (p. ej. 12:10, 12:45), no
 * solo en los múltiplos de la duración — necesario desde que el coordinador puede
 * publicar horarios a la hora exacta (estilo Google Calendar).
 *
 * Devuelve una lista ordenada por hora de inicio. Cada entrada es
 * `{ inicio, fin, bloques }`:
 *   - sub-slot teórico sin cupos → `bloques` vacío (se pinta como celda gris).
 *   - bloque(s) real(es) a esa hora → `bloques` con los bloques de ese minuto (uno
 *     por campus si `getBlocksForCell` ya dedup­licó), y `fin` tomado del propio
 *     bloque (`fecha_hora_fin`) para reflejar su duración real.
 * Un minuto teórico que coincide con un bloque real NO se duplica: gana el real.
 *
 * @param {Array}  subSlots     - sub-slots teóricos [{inicio, fin}] de la hora
 * @param {Array}  bloquesCelda - bloques reales de la celda (día+hora)
 * @param {number} duracionMin  - duración del servicio (fallback para calcular `fin`)
 * @returns {Array<{inicio:string, fin:string, bloques:Array}>}
 */
export function mergeSlotsConBloques(subSlots, bloquesCelda, duracionMin = 60) {
  const grupos = new Map(); // "HH:MM" -> { inicio, fin, bloques: [] }
  (Array.isArray(bloquesCelda) ? bloquesCelda : []).forEach(b => {
    if (!b?.fecha_hora_inicio) return;
    const inicio = b.fecha_hora_inicio.replace(' ', 'T').split('T')[1].substring(0, 5);
    if (!grupos.has(inicio)) {
      let fin = b.fecha_hora_fin
        ? b.fecha_hora_fin.replace(' ', 'T').split('T')[1].substring(0, 5)
        : null;
      if (!fin) {
        const [h, m] = inicio.split(':').map(Number);
        const finMin = h * 60 + m + duracionMin;
        fin = `${String(Math.floor(finMin / 60)).padStart(2, '0')}:${String(finMin % 60).padStart(2, '0')}`;
      }
      grupos.set(inicio, { inicio, fin, bloques: [] });
    }
    grupos.get(inicio).bloques.push(b);
  });

  const entradas = [];
  (Array.isArray(subSlots) ? subSlots : []).forEach(s => {
    if (!grupos.has(s.inicio)) entradas.push({ inicio: s.inicio, fin: s.fin, bloques: [] });
  });
  grupos.forEach(g => entradas.push(g));
  entradas.sort((a, b) => a.inicio.localeCompare(b.inicio));
  return entradas;
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
