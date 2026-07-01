/**
 * Retorna la fecha del lunes de la semana que contiene `d`.
 */
export function getLunes(d) {
  const dt = new Date(d);
  const day = dt.getDay();
  // day===0 = domingo: retroceder 6 días llevaría al lunes pasado;
  // en cambio, sumar 1 apunta al próximo lunes (mañana), que es lo esperado.
  const diff = dt.getDate() - day + 1;
  return new Date(dt.setDate(diff));
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
