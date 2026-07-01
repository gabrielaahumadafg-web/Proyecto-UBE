import { useState, useEffect } from 'react'
import { API_URL } from './config';
import { supabase } from './supabaseClient'
import AgendarHora from './AgendarHora'

function Dashboard({ session }) {
  const [servicios, setServicios] = useState([])
  const [vista, setVista] = useState('reservas')
  const [misReservas, setMisReservas] = useState([]);
  const [misSuspensiones, setMisSuspensiones] = useState([]);
  const [misEsperas, setMisEsperas] = useState([]);
  const [cargandoReservas, setCargandoReservas] = useState(false);
  const [serviciosAbiertos, setServiciosAbiertos] = useState({});
  const [ciclosAbiertos, setCiclosAbiertos] = useState({});

  // Inasistencias / justificaciones
  const [misInasistencias, setMisInasistencias] = useState([]);
  const [cargandoInasistencias, setCargandoInasistencias] = useState(false);
  const [justificandoId, setJustificandoId] = useState(null);
  const [motivoJustif, setMotivoJustif] = useState('');

  // Estados para el editor del calendario de lista de espera
  const [esperaEditando, setEsperaEditando] = useState(null);
  const [disponibilidadTemp, setDisponibilidadTemp] = useState({});
  const [campusPorDia, setCampusPorDia] = useState({});   // { "lunes": ["uuid1"], ... }
  const [campusPorSlot, setCampusPorSlot] = useState({}); // { "lunes|09:00": ["uuid1"], ... }
  const [slotModal, setSlotModal] = useState(null);       // { dia, inicio, fin } | null
  const [campusSlotTemp, setCampusSlotTemp] = useState([]); // campus en el modal abierto
  const [ubicaciones, setUbicaciones] = useState([]);
  const [bloquesDisponiblesServicio, setBloquesDisponiblesServicio] = useState([]); // bloques disponibles del servicio en edición
  const [bookingModal, setBookingModal] = useState(null); // { dia, inicio, fin, campusOpciones } | null
  const [campusBookingIdx, setCampusBookingIdx] = useState(-1); // índice en campusOpciones; -1 = sin selección
  const [agendandoDesdeEspera, setAgendandoDesdeEspera] = useState(false);
  const diasSemana = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'];
  const horasOpciones = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];

  // Etiqueta y color de estado para una reserva.
  // Para citas activas usa el estado del BLOQUE (confirmado/reservado), igual que la
  // agenda del profesional: en servicios cíclicos sólo la próxima sesión está "Confirmada"
  // y las siguientes quedan "Reservadas" hasta que el profesional confirma la continuidad.
  const etiquetaEstado = (r) => {
    const estado = r.estado || '';
    if (estado === 'presente') return { texto: 'Asistida', clase: 'bg-green-100 text-green-800' };
    if (estado.startsWith('cancelado')) return { texto: 'Cancelada', clase: 'bg-red-100 text-red-700' };
    if (r.estado_bloque === 'confirmado') return { texto: 'Confirmada', clase: 'bg-blue-100 text-blue-800' };
    if (r.estado_bloque === 'reservado') return { texto: 'Reservada', clase: 'bg-yellow-100 text-yellow-800' };
    return { texto: 'Pendiente', clase: 'bg-gray-100 text-gray-700' };
  };

  const puedeCancelarReserva = (r) =>
    !(r.estado || '').startsWith('cancelado') &&
    r.estado !== 'presente' &&
    r.fecha && new Date(r.fecha) > new Date();

  // Separa las reservas de un servicio cíclico en ciclos (re-tomas).
  // Un ciclo es una serie semanal con UNA sesión por fecha; al re-tomar el
  // servicio (tras cancelar/suspensión) se genera otra serie sobre las mismas
  // fechas. No dependemos de fecha_creacion (puede venir nula): asignamos cada
  // reserva al primer ciclo que aún no tenga esa fecha. Ordenamos las canceladas
  // primero para que una serie completa cancelada quede agrupada como un ciclo
  // anterior, mientras que una cancelación individual dentro del ciclo vigente
  // no fuerza un ciclo aparte.
  const separarEnCiclos = (items) => {
    const ordenados = [...items].sort((a, b) => {
      const aC = (a.estado || '').startsWith('cancelado');
      const bC = (b.estado || '').startsWith('cancelado');
      if (aC !== bC) return aC ? -1 : 1; // canceladas primero
      return new Date(a.fecha) - new Date(b.fecha);
    });
    const ciclos = [];
    ordenados.forEach((r) => {
      const claveFecha = r.fecha ? new Date(r.fecha).toISOString() : `s-${r.id_reserva}`;
      let destino = ciclos.find((c) => !c._fechas.has(claveFecha));
      if (!destino) {
        destino = { _fechas: new Set(), items: [] };
        ciclos.push(destino);
      }
      destino._fechas.add(claveFecha);
      destino.items.push(r);
    });
    return ciclos.map((c, idx) => {
      const itemsOrden = [...c.items].sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
      const fechas = itemsOrden.map((i) => new Date(i.fecha));
      return {
        ck: `ciclo-${idx}`,
        items: itemsOrden,
        tieneActivas: itemsOrden.some((i) => !(i.estado || '').startsWith('cancelado')),
        fechaMin: fechas[0],
        fechaMax: fechas[fechas.length - 1],
      };
    });
  };

  // Estado/etiqueta de un ciclo completo (encabezado plegable).
  const etiquetaCiclo = (ciclo) => {
    if (ciclo.tieneActivas) {
      const ahora = new Date();
      const enCurso = ciclo.items.some((i) => !(i.estado || '').startsWith('cancelado') && i.fecha && new Date(i.fecha) > ahora);
      return enCurso
        ? { texto: 'En curso', clase: 'bg-green-100 text-green-700' }
        : { texto: 'Activo', clase: 'bg-green-100 text-green-700' };
    }
    // Ciclo sin citas activas: deducir motivo del estado predominante.
    if (ciclo.items.some((i) => i.estado === 'presente')) {
      return { texto: 'Finalizado', clase: 'bg-gray-200 text-gray-600' };
    }
    const motivos = {
      cancelado_estudiante: 'Cancelado por el estudiante',
      cancelado_estudiante_tarde: 'Cancelado por el estudiante',
      cancelado_admin_suspension: 'Cancelado por suspensión',
      cancelado_protocolo_critico: 'Cancelado (protocolo crítico)',
      cancelado_profesional: 'Cancelado por el profesional',
      cancelado_alta_medica: 'Alta médica',
      cancelado_sistema_mejora: 'Reasignado a otro horario',
    };
    const conteo = {};
    ciclo.items.forEach((i) => { conteo[i.estado] = (conteo[i.estado] || 0) + 1; });
    const principal = Object.entries(conteo).sort((a, b) => b[1] - a[1])[0]?.[0];
    return { texto: motivos[principal] || 'Finalizado', clase: 'bg-gray-200 text-gray-600' };
  };

  const cerrarSesion = async () => {
    await supabase.auth.signOut()
  }

  const cargarServicios = async () => {
    try {
      const respuesta = await fetch(`${API_URL}/servicios`); // Sin token para evitar bloqueo CORS
      if (respuesta.ok) {
        const datos = await respuesta.json();
        setServicios(Array.isArray(datos) ? datos : (datos?.data || []));
      } else {
        setServicios([]);
      }
    } catch (error) {
      console.error("Error:", error);
    }
  }

  const cargarMisReservas = async () => {
    setCargandoReservas(true);
    try {
      const [resReservas, resEsperas, resSusp] = await Promise.all([
        fetch(`${API_URL}/mis_reservas`, { headers: { "Authorization": `Bearer ${session.access_token}` } }),
        fetch(`${API_URL}/mis_esperas`, { headers: { "Authorization": `Bearer ${session.access_token}` } }),
        fetch(`${API_URL}/mis_suspensiones`, { headers: { "Authorization": `Bearer ${session.access_token}` } }),
      ]);

      if (resReservas.ok) {
        setMisReservas(await resReservas.json());
      }
      if (resEsperas.ok) {
        setMisEsperas(await resEsperas.json());
      }
      if (resSusp.ok) {
        setMisSuspensiones(await resSusp.json());
      }
    } catch (error) {
      console.error("Error al cargar mis reservas:", error);
    } finally {
      setCargandoReservas(false);
    }
  };

  const cancelarReserva = async (id_reserva) => {
    if (!window.confirm("¿Estás seguro de que deseas cancelar esta hora? (Cancelar con menos de 48 horas de anticipación cuenta como inasistencia y puede causar suspensión)")) return;
    try {
      const respuesta = await fetch(`${API_URL}/cancelar`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ id_reserva })
      });
      if (respuesta.ok) {
        const data = await respuesta.json();
        if (data.requiere_justificacion) {
          alert("Hora cancelada. Como fue con menos de 48h de anticipación, quedó registrada como inasistencia. Puedes justificarla ahora en 'Mis Inasistencias'.");
          setVista('inasistencias');
          if (data.id_inasistencia) {
            setJustificandoId(data.id_inasistencia);
            setMotivoJustif('');
          }
        } else {
          alert("Hora cancelada exitosamente.");
        }
        cargarMisReservas(); // Recargar la lista
      } else {
        const data = await respuesta.json();
        alert("Error al cancelar: " + data.detail);
      }
    } catch (error) {
      console.error("Error al cancelar:", error);
    }
  };

  const cargarMisInasistencias = async () => {
    setCargandoInasistencias(true);
    try {
      const respuesta = await fetch(`${API_URL}/mis_inasistencias`, { headers: { "Authorization": `Bearer ${session.access_token}` } });
      if (respuesta.ok) {
        setMisInasistencias(await respuesta.json());
      }
    } catch (error) {
      console.error("Error al cargar inasistencias:", error);
    } finally {
      setCargandoInasistencias(false);
    }
  };

  const justificarInasistencia = async (id_inasistencia) => {
    if (!motivoJustif.trim()) { alert("Escribe el motivo de tu inasistencia."); return; }
    try {
      const respuesta = await fetch(`${API_URL}/justificar_inasistencia`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
        body: JSON.stringify({ id_inasistencia, motivo: motivoJustif.trim() })
      });
      if (respuesta.ok) {
        alert("Justificación enviada. Quedará a revisión de la administración.");
        setJustificandoId(null);
        setMotivoJustif('');
        cargarMisInasistencias();
      } else {
        const data = await respuesta.json();
        alert("Error al justificar: " + data.detail);
      }
    } catch (error) {
      console.error("Error al justificar:", error);
    }
  };

  const cargarUbicaciones = async () => {
    try {
      const res = await fetch(`${API_URL}/ubicaciones?activo=true`);
      if (res.ok) setUbicaciones(await res.json());
    } catch (e) { console.error(e); }
  };

  const abrirEditorEspera = async (espera) => {
    setEsperaEditando(espera.id_lista);
    setDisponibilidadTemp(espera.disponibilidad_indicada || {});
    setCampusPorSlot(espera.campus_por_slot || {});
    setCampusPorDia({});
    setSlotModal(null);
    setBloquesDisponiblesServicio([]);
    if (ubicaciones.length === 0) await cargarUbicaciones();
    try {
      const res = await fetch(`${API_URL}/disponibilidad?id_servicio=${espera.id_servicio}`);
      if (res.ok) setBloquesDisponiblesServicio(await res.json());
    } catch (e) { console.error(e); }
  };

  // Funciones del editor de Lista de Espera
  const handleSlotClickEditor = (dia, inicio, fin, hayCupo) => {
    const yaSeleccionado = (disponibilidadTemp[dia] || []).includes(inicio);
    if (yaSeleccionado) {
      setDisponibilidadTemp(prev => {
        const nueva = { ...prev };
        nueva[dia] = nueva[dia].filter(h => h !== inicio);
        if (nueva[dia].length === 0) delete nueva[dia];
        return nueva;
      });
      setCampusPorSlot(prev => { const n = { ...prev }; delete n[`${dia}|${inicio}`]; return n; });
    } else if (hayCupo) {
      // Celda verde: ofrecer agendar hora directamente
      const bloquesSlot = bloquesDisponiblesServicio.filter(b => {
        if (!b.fecha_hora_inicio) return false;
        const fecha = new Date(b.fecha_hora_inicio);
        const diaNombre = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'][fecha.getDay()];
        const hora = `${String(fecha.getHours()).padStart(2,'0')}:${String(fecha.getMinutes()).padStart(2,'0')}`;
        return diaNombre === dia && hora === inicio;
      });
      const campusMap = new Map();
      bloquesSlot.forEach(b => {
        const ub = b.ubicacion || {};
        const key = ub.id_ubicacion || 'sin_campus';
        if (!campusMap.has(key)) campusMap.set(key, { id_ubicacion: ub.id_ubicacion || null, nombre: ub.nombre || null, id_bloque: b.id_bloque });
      });
      const campusOpciones = [...campusMap.values()];
      const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
      const fechaBloque = bloquesSlot.length > 0 ? new Date(bloquesSlot[0].fecha_hora_inicio.replace(' ', 'T')) : null;
      const fechaLabel = fechaBloque
        ? `${dia} ${fechaBloque.getDate()} de ${meses[fechaBloque.getMonth()]}`
        : dia;
      setBookingModal({ dia, inicio, fin, campusOpciones, fechaLabel });
      setCampusBookingIdx(campusOpciones.length === 1 ? 0 : -1);
    } else {
      setSlotModal({ dia, inicio, fin });
      setCampusSlotTemp([...(campusPorDia[dia] || [])]);
    }
  };

  const confirmarAgendarDesdeEspera = async () => {
    if (!bookingModal) return;
    if (bookingModal.campusOpciones.length > 1 && campusBookingIdx === -1) return;
    const espera = misEsperas.find(e => e.id_lista === esperaEditando);
    if (!espera) return;
    const opcion = bookingModal.campusOpciones[campusBookingIdx === -1 ? 0 : campusBookingIdx];
    setAgendandoDesdeEspera(true);
    try {
      const resp = await fetch(`${API_URL}/reservar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
        body: JSON.stringify({ id_bloque: opcion.id_bloque, motivo_consulta: espera.motivo_consulta || '', puntaje_triage: espera.puntaje_triage || null })
      });
      if (resp.ok) {
        setBookingModal(null);
        setEsperaEditando(null);
        alert('¡Hora agendada! Ya no estás en lista de espera para este servicio. Revisa "Citas Confirmadas".');
        cargarMisReservas();
      } else {
        const data = await resp.json();
        alert('Error al agendar: ' + (data.detail || 'Error desconocido'));
      }
    } catch (e) {
      console.error(e);
      alert('Error al conectar con el servidor.');
    } finally {
      setAgendandoDesdeEspera(false);
    }
  };

  const confirmarSlotEditor = () => {
    if (!slotModal) return;
    const { dia, inicio } = slotModal;
    setDisponibilidadTemp(prev => {
      const nueva = { ...prev };
      if (!nueva[dia]) nueva[dia] = [];
      if (!nueva[dia].includes(inicio)) nueva[dia] = [...nueva[dia], inicio];
      return nueva;
    });
    setCampusPorSlot(prev => ({ ...prev, [`${dia}|${inicio}`]: campusSlotTemp }));
    setSlotModal(null);
  };

  const guardarDisponibilidad = async (id_lista) => {
    try {
      // campus_indicados = union de todos los campus en los slots guardados
      const todosLosCampus = new Set();
      Object.values(campusPorSlot).forEach(arr => (arr || []).forEach(id => todosLosCampus.add(id)));
      const campusIndicadosUnion = [...todosLosCampus];
      const respuesta = await fetch(`${API_URL}/lista_espera/${id_lista}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
        body: JSON.stringify({
          disponibilidad_indicada: disponibilidadTemp,
          campus_indicados: campusIndicadosUnion.length > 0 ? campusIndicadosUnion : null,
          campus_por_slot: Object.keys(campusPorSlot).length > 0 ? campusPorSlot : null
        })
      });
      if (respuesta.ok) {
        alert("Tus horarios han sido guardados. El sistema buscará horas que coincidan.");
        setEsperaEditando(null);
        cargarMisReservas();
      } else {
        alert("Error al actualizar la disponibilidad.");
      }
    } catch (error) {
      console.error(error);
    }
  };

  const salirDeListaEspera = async (id_lista) => {
    if (!window.confirm("¿Seguro que deseas darte de baja de esta lista de espera?")) return;
    try {
      const respuesta = await fetch(`${API_URL}/lista_espera/${id_lista}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (respuesta.ok) {
        alert("Has salido de la lista de espera.");
        setEsperaEditando(null);
        cargarMisReservas();
      } else {
        alert("Error al intentar salir de la lista.");
      }
    } catch (error) {
      console.error(error);
    }
  };

  useEffect(() => {
    if (vista === 'reservas') {
      cargarMisReservas();
      setEsperaEditando(null);
    }
    if (vista === 'inasistencias') {
      cargarMisInasistencias();
    }
  }, [vista]);

  const tabClass = (v) => `px-4 py-2 rounded-t-lg font-medium whitespace-nowrap flex-shrink-0 ${vista === v ? 'bg-blue-100 text-blue-800 border-b-4 border-blue-600' : 'text-gray-500 hover:text-blue-600 hover:bg-gray-100'}`;

  return (
    <div className="min-h-screen bg-gray-50 text-gray-800" style={{ fontFamily: 'sans-serif' }}>
      {/* Navbar Superior */}
      <header className="text-white p-4 shadow-md flex justify-between items-center gap-3" style={{ backgroundColor: '#003366' }}>
        <h1 className="text-lg md:text-xl font-bold whitespace-nowrap">Portal UBE</h1>
        <div className="flex items-center gap-2 md:gap-4 min-w-0">
          <span className="text-xs md:text-sm truncate hidden sm:inline">{session.user.email}</span>
          <button onClick={cerrarSesion} className="bg-red-600 hover:bg-red-700 px-3 py-1 rounded text-sm font-semibold transition flex-shrink-0">
            Cerrar Sesión
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-4 md:p-6">
        {/* Navegación por pestañas */}
        <div className="flex gap-2 border-b-2 border-gray-200 mb-6 pb-2 overflow-x-auto">
          <button onClick={() => setVista('reservas')} className={tabClass('reservas')}>Mis Reservas</button>
          <button onClick={() => setVista('inasistencias')} className={tabClass('inasistencias')}>Mis Inasistencias</button>
          <button onClick={() => setVista('agendar')} className={tabClass('agendar')}>Agendar Hora</button>
        </div>

        {vista === 'agendar' && <AgendarHora session={session} />}

        {vista === 'inasistencias' && (
          <div className="space-y-6 mt-6">
            <section className="bg-white p-6 rounded-lg shadow-md border-t-4 border-amber-500">
              <h2 className="text-2xl font-bold text-amber-800 mb-2">Mis Inasistencias</h2>
              <p className="text-gray-600 mb-6">
                Aquí aparecen tus ausencias (no presentarse o cancelar con menos de 48h). Puedes justificarlas dentro del plazo;
                la administración las revisará. Una inasistencia <strong>rechazada</strong> o <strong>vencida sin justificar</strong> cuenta como <strong>falta</strong>.
              </p>

              {cargandoInasistencias ? (
                <div className="text-center text-gray-500 py-10">Cargando...</div>
              ) : misInasistencias.length === 0 ? (
                <div className="border-dashed border-2 border-gray-300 p-10 text-center text-gray-500 rounded-lg bg-gray-50">
                  No registras inasistencias. ¡Sigue así!
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  {misInasistencias.map((ina) => {
                    const enRevision = ina.estado === 'pendiente_justificacion' && ina.motivo_estudiante;
                    const badge = (() => {
                      if (ina.estado === 'justificada') return { txt: 'Justificada', cls: 'bg-green-100 text-green-800' };
                      if (ina.estado === 'rechazada') return { txt: 'Rechazada (falta)', cls: 'bg-red-100 text-red-800' };
                      if (ina.estado === 'vencida_sin_justificar') return { txt: 'Vencida (falta)', cls: 'bg-red-100 text-red-800' };
                      if (enRevision) return { txt: 'En revisión', cls: 'bg-blue-100 text-blue-800' };
                      return { txt: 'Pendiente de justificar', cls: 'bg-amber-100 text-amber-800' };
                    })();
                    const tipoTxt = ina.tipo === 'cancelacion_tardia' ? 'Cancelación con menos de 48h'
                      : ina.tipo === 'atraso' ? 'Atraso' : 'No se presentó';
                    const editando = justificandoId === ina.id_inasistencia;
                    return (
                      <div key={ina.id_inasistencia} className="p-4 rounded-lg border border-gray-200">
                        <div className="flex justify-between items-start gap-3 flex-wrap">
                          <div>
                            <h3 className="font-bold text-lg text-gray-800">{ina.servicio_nombre}</h3>
                            <p className="text-sm text-gray-600">{tipoTxt}</p>
                            {ina.fecha_inasistencia && (
                              <p className="text-xs text-gray-500 mt-1">Fecha: {new Date(ina.fecha_inasistencia).toLocaleString()}</p>
                            )}
                            {ina.fecha_limite_justificacion && ina.estado === 'pendiente_justificacion' && (
                              <p className="text-xs text-gray-500">Plazo para justificar: {new Date(ina.fecha_limite_justificacion).toLocaleString()}</p>
                            )}
                            {ina.motivo_estudiante && (
                              <p className="text-sm text-gray-700 mt-2 italic">"{ina.motivo_estudiante}"</p>
                            )}
                          </div>
                          <span className={`px-3 py-1 text-xs font-bold rounded-full ${badge.cls}`}>{badge.txt}</span>
                        </div>

                        {ina.puede_justificar && !editando && (
                          <button
                            onClick={() => { setJustificandoId(ina.id_inasistencia); setMotivoJustif(''); }}
                            className="mt-4 bg-amber-500 hover:bg-amber-600 text-white font-bold py-2 px-4 rounded text-sm"
                          >
                            Justificar esta inasistencia
                          </button>
                        )}

                        {editando && (
                          <div className="mt-4 pt-4 border-t border-gray-100">
                            <label className="block text-sm font-bold text-gray-700 mb-2">¿Por qué faltaste?</label>
                            <textarea
                              value={motivoJustif}
                              onChange={(e) => setMotivoJustif(e.target.value)}
                              rows={3}
                              placeholder="Explica brevemente el motivo (ej: emergencia médica, problema grave que te impidió avisar a tiempo)..."
                              className="w-full p-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
                            />
                            <div className="flex gap-2 mt-3">
                              <button onClick={() => justificarInasistencia(ina.id_inasistencia)} className="bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded text-sm">Enviar justificación</button>
                              <button onClick={() => { setJustificandoId(null); setMotivoJustif(''); }} className="bg-gray-200 hover:bg-gray-300 text-gray-700 font-bold py-2 px-4 rounded text-sm">Cancelar</button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        )}

        {vista === 'reservas' && (
          <div className="space-y-8 mt-6">
            {/* SECCIÓN 1: RESERVAS CONFIRMADAS */}
            <section className="bg-white p-6 rounded-lg shadow-md border-t-4 border-blue-600">
              <h2 className="text-2xl font-bold text-blue-900 mb-4">Citas Confirmadas</h2>
              <p className="text-gray-600 mb-6">Revisa tus próximas atenciones o tu historial clínico.</p>

              {cargandoReservas ? (
                <div className="text-center text-gray-500 py-10">Cargando tu agenda...</div>
              ) : misReservas.length === 0 ? (
                <div className="border-dashed border-2 border-gray-300 p-10 text-center text-gray-500 rounded-lg bg-gray-50">
                  No tienes citas agendadas ni historial registrado.
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {(() => {
                    // Agrupar reservas por servicio
                    const grupos = {};
                    misReservas.forEach((r) => {
                      const clave = r.id_servicio || r.servicio_nombre;
                      if (!grupos[clave]) grupos[clave] = { nombre: r.servicio_nombre, items: [] };
                      grupos[clave].items.push(r);
                    });
                    const ahora = new Date();

                    return Object.entries(grupos).map(([clave, grupo]) => {
                      const abierto = !!serviciosAbiertos[clave];
                      const esCiclico = !!servicios.find((s) => s.id_servicio === clave)?.es_ciclico;

                      // Servicios cíclicos: separar en ciclos (re-tomas) con detección
                      // robusta por fechas. No cíclicos: una sola grilla (activas primero).
                      let ciclos;
                      if (esCiclico) {
                        ciclos = separarEnCiclos(grupo.items);
                        // Ciclo vigente primero, luego los más recientes.
                        ciclos.sort((a, b) => {
                          if (a.tieneActivas !== b.tieneActivas) return a.tieneActivas ? -1 : 1;
                          return b.fechaMin - a.fechaMin;
                        });
                      } else {
                        const ordenados = [...grupo.items].sort((a, b) => {
                          const aC = (a.estado || '').startsWith('cancelado');
                          const bC = (b.estado || '').startsWith('cancelado');
                          if (aC !== bC) return aC ? 1 : -1;
                          return new Date(a.fecha) - new Date(b.fecha);
                        });
                        ciclos = [{ ck: clave, items: ordenados, tieneActivas: true }];
                      }
                      const hayVariosCiclos = esCiclico && ciclos.length > 1;

                      const totalActivas = grupo.items.filter((i) =>
                        !(i.estado || '').startsWith('cancelado') &&
                        i.fecha && new Date(i.fecha) > ahora
                      );
                      const proxima = totalActivas
                        .filter((i) => i.fecha && new Date(i.fecha) > ahora)
                        .sort((a, b) => new Date(a.fecha) - new Date(b.fecha))[0];

                      const suspension = misSuspensiones.find(s => s.id_servicio === clave);

                      return (
                        <div key={clave} className="border border-gray-200 rounded-lg overflow-hidden">
                          <button
                            onClick={() => setServiciosAbiertos((s) => ({ ...s, [clave]: !s[clave] }))}
                            className="w-full flex items-center justify-between gap-3 p-4 bg-gray-50 hover:bg-gray-100 transition text-left"
                          >
                            <div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <h3 className="font-bold text-lg text-blue-900">{grupo.nombre}</h3>
                                {suspension && (
                                  <span className="px-2 py-0.5 text-xs font-bold rounded-full bg-red-100 text-red-700 border border-red-300">
                                    🚫 Suspendido hasta {new Date(suspension.fecha_fin).toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' })}
                                  </span>
                                )}
                              </div>
                              <p className="text-sm text-gray-600">
                                {totalActivas.length} {totalActivas.length === 1 ? 'cita activa' : 'citas activas'}
                                {hayVariosCiclos && <> · {ciclos.length} ciclos</>}
                                {proxima && <> · Próxima: {new Date(proxima.fecha).toLocaleString()}</>}
                              </p>
                            </div>
                            <span className={`text-gray-400 text-sm transform transition-transform ${abierto ? 'rotate-180' : ''}`}>▼</span>
                          </button>

                          {abierto && (
                            <div className="bg-white border-t border-gray-100 divide-y divide-gray-100">
                              {ciclos.map((ciclo, idx) => {
                                // Tarjetas de las citas de un ciclo.
                                const grilla = (
                                  <div className="grid gap-4 md:grid-cols-2">
                                    {ciclo.items.map((r) => {
                                      const est = etiquetaEstado(r);
                                      const cancelable = puedeCancelarReserva(r);
                                      const inactiva = (r.estado || '').startsWith('cancelado');
                                      return (
                                        <div key={r.id_reserva} className={`p-4 rounded-lg border shadow-sm flex flex-col justify-between ${inactiva ? 'bg-gray-50 border-gray-200 opacity-70' : 'bg-white border-blue-200 shadow-blue-100'}`}>
                                          <div>
                                            <p className="text-sm text-gray-600">Profesional: {r.profesional_nombres} {r.profesional_apellidos}</p>
                                            <p className="text-sm text-gray-800 mt-2">
                                              <strong>Fecha:</strong> {new Date(r.fecha).toLocaleString()}
                                            </p>
                                            {r.ubicacion_nombre && (
                                              <p className="text-sm text-gray-600 mt-1">
                                                📍 <strong>Campus:</strong> {r.ubicacion_nombre}
                                              </p>
                                            )}
                                            <span className={`inline-block mt-3 px-3 py-1 text-xs font-semibold rounded-full ${est.clase}`}>
                                              {est.texto}
                                            </span>
                                          </div>

                                          {cancelable && (
                                            <button
                                              onClick={() => cancelarReserva(r.id_reserva)}
                                              className="mt-4 bg-white border border-red-500 text-red-600 hover:bg-red-50 py-2 px-4 rounded transition text-sm font-bold w-full"
                                            >
                                              Cancelar Cita
                                            </button>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                );

                                // Un solo ciclo: mostrar la grilla directamente.
                                if (!hayVariosCiclos) {
                                  return <div key={ciclo.ck} className="p-4">{grilla}</div>;
                                }

                                // Varios ciclos: cada uno es un encabezado plegable propio.
                                const estCiclo = etiquetaCiclo(ciclo);
                                const claveCiclo = `${clave}::${ciclo.ck}`;
                                // Por defecto abrimos el ciclo vigente (el primero).
                                const cicloAbierto = claveCiclo in ciclosAbiertos ? ciclosAbiertos[claveCiclo] : idx === 0;
                                const inicioFmt = ciclo.fechaMin.toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' });
                                return (
                                  <div key={ciclo.ck} className="p-3">
                                    <button
                                      onClick={() => setCiclosAbiertos((s) => ({ ...s, [claveCiclo]: !cicloAbierto }))}
                                      className="w-full flex items-center justify-between gap-3 p-3 bg-gray-50 hover:bg-gray-100 rounded-lg transition text-left"
                                    >
                                      <div className="flex items-center flex-wrap gap-2">
                                        <span className="text-sm font-bold text-gray-800">Ciclo {idx + 1}</span>
                                        <span className="text-xs text-gray-500">· iniciado el {inicioFmt}</span>
                                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${estCiclo.clase}`}>
                                          {estCiclo.texto}
                                        </span>
                                      </div>
                                      <span className={`text-gray-400 text-xs transform transition-transform ${cicloAbierto ? 'rotate-180' : ''}`}>▼</span>
                                    </button>
                                    {cicloAbierto && <div className="pt-3">{grilla}</div>}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
            </section>

            {/* SECCIÓN 2: LISTA DE ESPERA */}
            <section className="bg-white p-6 rounded-lg shadow-md border-t-4 border-yellow-400">
              <h2 className="text-2xl font-bold text-yellow-800 mb-2">Mi Fila de Espera</h2>
              <p className="text-gray-600 mb-6">Presiona "Añadir/Editar Horarios" para indicarle al sistema cuándo tienes disponibilidad. Te asignaremos una hora automáticamente si coinciden tus horarios con los del profesional.</p>
              
              {cargandoReservas ? (
                <div className="text-center text-gray-500 py-6">Cargando...</div>
              ) : misEsperas.length === 0 ? (
                <div className="text-center text-gray-500 bg-yellow-50 p-6 rounded border border-yellow-100">
                  No te encuentras en ninguna lista de espera.
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  {misEsperas.map(e => {
                    const tieneHorarios = Object.keys(e.disponibilidad_indicada || {}).length > 0;
                    const estaEditando = esperaEditando === e.id_lista;
                    const duracionMin = e.servicio?.duracion_minutos || 60;
                    
                    // Nombres de campus actuales del estudiante en esta entrada
                    const campusActuales = (e.campus_indicados || [])
                      .map(id => ubicaciones.find(u => u.id_ubicacion === id)?.nombre)
                      .filter(Boolean);

                    // Set de slots con cupo disponible para este servicio: "dia|HH:MM"
                    const slotsConCupo = new Set();
                    bloquesDisponiblesServicio.forEach(b => {
                      if (!b.fecha_hora_inicio) return;
                      const fecha = new Date(b.fecha_hora_inicio);
                      const diaNombre = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'][fecha.getDay()];
                      const hora = `${String(fecha.getHours()).padStart(2,'0')}:${String(fecha.getMinutes()).padStart(2,'0')}`;
                      slotsConCupo.add(`${diaNombre}|${hora}`);
                    });

                    return (
                      <div key={e.id_lista} className={`p-4 rounded-lg border transition-all ${estaEditando ? 'border-blue-500 ring-2 ring-blue-100 shadow-md' : 'border-gray-200 hover:border-gray-300'}`}>
                        <div className="flex justify-between items-start mb-3">
                          <div>
                            <h3 className="font-bold text-lg text-gray-800">{e.servicio.nombre}</h3>
                            <p className="text-xs text-gray-500">Inscrito: {new Date(e.fecha_ingreso).toLocaleDateString()}</p>
                            {campusActuales.length > 0 && (
                              <p className="text-xs text-blue-700 mt-1">📍 Campus: {campusActuales.join(', ')}</p>
                            )}
                            {(!e.campus_indicados || e.campus_indicados.length === 0) && (
                              <p className="text-xs text-gray-500 mt-1">📍 Campus: cualquier sede</p>
                            )}
                          </div>
                          <span className={`px-2 py-1 text-xs font-bold rounded ${tieneHorarios ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                            {tieneHorarios ? 'Horarios indicados' : 'Faltan horarios (Incompleto)'}
                          </span>
                        </div>

                        {!estaEditando ? (
                          <div className="flex gap-2 mt-4">
                            <button
                              onClick={() => abrirEditorEspera(e)}
                              className="flex-1 bg-blue-50 hover:bg-blue-100 text-blue-700 font-bold py-2 px-4 border border-blue-200 rounded text-sm transition"
                            >
                              {tieneHorarios ? 'Modificar Horarios / Campus' : 'Añadir mis Horarios Libres'}
                            </button>
                            <button
                              onClick={() => salirDeListaEspera(e.id_lista)}
                              className="bg-white hover:bg-red-50 text-red-600 border border-gray-200 hover:border-red-300 py-2 px-4 rounded text-sm font-bold transition"
                            >
                              Retirarme
                            </button>
                          </div>
                        ) : (
                          <div className="mt-4 pt-4 border-t border-gray-100 animate-fade-in">
                            {/* Barra de campus por día */}
                            {ubicaciones.length > 0 && (
                              <div className="mb-4 bg-blue-50 border border-blue-200 rounded-lg p-3">
                                <p className="text-xs font-semibold text-blue-900 mb-2">📍 Campus por día (valor predeterminado al agregar un horario; puedes personalizar por slot)</p>
                                <div className="grid grid-cols-5 gap-2">
                                  {diasSemana.map(dia => (
                                    <div key={dia}>
                                      <p className="text-[10px] font-medium text-gray-600 mb-1 capitalize">{dia}</p>
                                      <div className="flex flex-wrap gap-1">
                                        {ubicaciones.map(u => {
                                          const activo = (campusPorDia[dia] || []).includes(u.id_ubicacion);
                                          return (
                                            <button key={u.id_ubicacion} type="button"
                                              onClick={() => setCampusPorDia(prev => {
                                                const act = prev[dia] || [];
                                                return { ...prev, [dia]: activo ? act.filter(id => id !== u.id_ubicacion) : [...act, u.id_ubicacion] };
                                              })}
                                              className={`px-1.5 py-0.5 text-[9px] rounded-full border transition ${activo ? 'bg-blue-600 text-white border-blue-700' : 'bg-white text-gray-500 border-gray-300 hover:border-blue-400'}`}
                                            >
                                              {u.abreviatura || u.nombre}
                                            </button>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            <p className="text-sm font-bold text-gray-700 mb-1">Haz clic en los bloques en los que podrías asistir:</p>
                            <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded p-2 mb-3">Las celdas en <strong>verde</strong> ya tienen cupo disponible. <strong>Presiónelas para agendar hora directamente</strong> y salir de la lista de espera.</p>
                            <div className="overflow-x-auto mb-4 border border-gray-200 rounded">
                              <table className="w-full text-xs text-center border-collapse bg-white table-fixed">
                                <thead>
                                  <tr className="bg-gray-50">
                                    <th className="p-2 border-b border-r text-gray-500 w-16">Hora</th>
                                    {diasSemana.map(dia => <th key={dia} className="p-2 border-b border-r capitalize text-gray-700">{dia}</th>)}
                                  </tr>
                                </thead>
                                <tbody>
                                  {horasOpciones.map(hora => {
                                    const startMin = parseInt(hora.split(':')[0], 10) * 60;
                                    const subSlots = [];
                                    for (let m = startMin; m + duracionMin <= startMin + 60; m += duracionMin) {
                                      const hh = String(Math.floor(m / 60)).padStart(2, '0');
                                      const mm = String(m % 60).padStart(2, '0');
                                      const endMin = m + duracionMin;
                                      subSlots.push({
                                        inicio: `${hh}:${mm}`,
                                        fin: `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`
                                      });
                                    }
                                    return (
                                      <tr key={hora}>
                                        <td className="p-2 border-b border-r bg-gray-50 text-gray-500 font-medium align-top">{hora}</td>
                                        {diasSemana.map(dia => (
                                          <td key={`${dia}-${hora}`} className="border-b border-r p-1 align-top">
                                            <div className="flex flex-col gap-1">
                                              {subSlots.map(({ inicio, fin }) => {
                                                const seleccionado = (disponibilidadTemp[dia] || []).includes(inicio);
                                                const hayCupo = slotsConCupo.has(`${dia}|${inicio}`);
                                                const campusSlot = campusPorSlot[`${dia}|${inicio}`] || [];
                                                const campusNombres = campusSlot.map(id => ubicaciones.find(u => u.id_ubicacion === id)?.abreviatura || ubicaciones.find(u => u.id_ubicacion === id)?.nombre?.substring(0, 4) || '').filter(Boolean);
                                                let cls;
                                                if (seleccionado) {
                                                  cls = 'bg-blue-500 text-white border-blue-600 shadow-inner';
                                                } else if (hayCupo) {
                                                  cls = 'bg-green-100 text-green-800 border-green-400 hover:bg-green-200';
                                                } else {
                                                  cls = 'hover:bg-blue-50 text-gray-400 border-gray-200 hover:border-blue-300 hover:text-blue-500';
                                                }
                                                return (
                                                  <div key={inicio} onClick={() => handleSlotClickEditor(dia, inicio, fin, hayCupo)}
                                                    className={`min-h-[34px] flex flex-col justify-center items-center rounded text-[10px] border cursor-pointer transition-colors ${cls}`}
                                                    title={hayCupo && !seleccionado ? '¡Hay cupo! Presiona para agendar directamente' : seleccionado ? 'Clic para quitar' : 'Clic para agregar'}
                                                  >
                                                    <span className="font-bold">{inicio} - {fin}</span>
                                                    {seleccionado && campusNombres.length > 0 && <span className="text-[8px] mt-0.5 opacity-90">{campusNombres.join(', ')}</span>}
                                                    {seleccionado && campusNombres.length === 0 && <span className="text-[8px] mt-0.5 opacity-75">cualquier sede</span>}
                                                    {!seleccionado && hayCupo && <span className="text-[9px]">Hay hora</span>}
                                                  </div>
                                                );
                                              })}
                                            </div>
                                          </td>
                                        ))}
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                            <div className="flex gap-2">
                              <button onClick={() => guardarDisponibilidad(e.id_lista)} className="flex-1 bg-green-600 hover:bg-green-700 text-white font-bold py-2 rounded">Guardar Cambios</button>
                              <button onClick={() => { setEsperaEditando(null); setSlotModal(null); }} className="flex-1 bg-gray-200 hover:bg-gray-300 text-gray-700 font-bold py-2 rounded">Cancelar</button>
                              <button onClick={() => salirDeListaEspera(e.id_lista)} className="bg-red-100 hover:bg-red-200 text-red-700 font-bold py-2 px-4 rounded" title="Darse de baja">Eliminar</button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        )}
      </main>

      {/* Modal de agendar hora directamente desde celda verde */}
      {bookingModal && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-sm w-full mx-4">
            <h3 className="font-bold text-green-800 mb-1 text-lg">¡Hay cupo disponible!</h3>
            <p className="text-sm text-gray-600 mb-1 capitalize">{bookingModal.fechaLabel} · {bookingModal.inicio} – {bookingModal.fin}</p>
            <p className="text-xs text-gray-500 mb-4">Puedes agendar esta hora ahora y salir automáticamente de la lista de espera.</p>

            {bookingModal.campusOpciones.length > 1 ? (
              <>
                <p className="text-sm font-semibold text-gray-700 mb-2">Selecciona la sede:</p>
                <div className="flex flex-wrap gap-2 mb-4">
                  {bookingModal.campusOpciones.map((op, idx) => (
                    <button key={idx} type="button"
                      onClick={() => setCampusBookingIdx(idx)}
                      className={`px-3 py-1.5 rounded-full text-sm font-semibold border transition ${campusBookingIdx === idx ? 'bg-green-600 text-white border-green-700' : 'bg-white text-gray-600 border-gray-300 hover:border-green-400'}`}
                    >
                      {op.nombre || 'Sin sede específica'}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-sm text-gray-700 mb-4">
                📍 <strong>{bookingModal.campusOpciones[0]?.nombre || 'Sin sede específica'}</strong>
              </p>
            )}

            <div className="flex gap-2">
              <button type="button" onClick={confirmarAgendarDesdeEspera}
                disabled={agendandoDesdeEspera || (bookingModal.campusOpciones.length > 1 && campusBookingIdx === -1)}
                className="flex-1 bg-green-600 hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-bold py-2 rounded transition"
              >
                {agendandoDesdeEspera ? 'Agendando...' : 'Agendar Hora'}
              </button>
              <button type="button" onClick={() => setBookingModal(null)}
                className="flex-1 bg-gray-200 hover:bg-gray-300 text-gray-700 font-bold py-2 rounded transition"
              >
                Cancelar
              </button>
            </div>
            <p className="text-xs text-gray-400 mt-3 text-center">Al confirmar saldrás de la lista de espera para este servicio.</p>
          </div>
        </div>
      )}

      {/* Modal de selección de campus al agregar un slot a la lista de espera */}
      {slotModal && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-sm w-full mx-4">
            <h3 className="font-bold text-gray-800 mb-1">¿Qué campus te sirven?</h3>
            <p className="text-sm text-gray-500 mb-4 capitalize">{slotModal.dia} · {slotModal.inicio} – {slotModal.fin}</p>
            <div className="flex flex-wrap gap-2 mb-3">
              {ubicaciones.map(u => {
                const activo = campusSlotTemp.includes(u.id_ubicacion);
                return (
                  <button key={u.id_ubicacion} type="button"
                    onClick={() => setCampusSlotTemp(prev => activo ? prev.filter(id => id !== u.id_ubicacion) : [...prev, u.id_ubicacion])}
                    className={`px-3 py-1.5 rounded-full text-sm font-semibold border transition ${activo ? 'bg-blue-600 text-white border-blue-700' : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400'}`}
                  >
                    {u.nombre}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-gray-500 mb-3">
              {campusSlotTemp.length === 0 ? 'Sin selección = cualquier campus puede asignarte en este horario.' : ''}
            </p>
            {(campusPorDia[slotModal.dia] || []).length > 0 && (
              <button type="button" onClick={() => setCampusSlotTemp([...(campusPorDia[slotModal.dia] || [])])}
                className="text-xs text-blue-600 hover:underline mb-4 block"
              >
                ← Usar campus del día ({(campusPorDia[slotModal.dia] || []).map(id => ubicaciones.find(u => u.id_ubicacion === id)?.nombre).filter(Boolean).join(', ')})
              </button>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={confirmarSlotEditor} className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 rounded">Añadir</button>
              <button type="button" onClick={() => setSlotModal(null)} className="flex-1 bg-gray-200 hover:bg-gray-300 text-gray-700 font-bold py-2 rounded">Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Dashboard