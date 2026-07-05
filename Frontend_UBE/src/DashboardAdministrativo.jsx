import { useState, useEffect, useMemo } from 'react'
import { API_URL } from './config';
import { supabase } from './supabaseClient'
import FormularioMotivo, { buildMotivoFinal } from './FormularioMotivo'
import HistorialEstudiante from './HistorialEstudiante'
import { getLunes, getBlocksForCell, deduplicateCyclicBlocks, getSlotsConDisponibilidad, mergeSlotsConBloques } from './utils/calendarUtils'

function DashboardAdministrativo({ session }) {
  const [vista, setVista] = useState('inicio')
  const [listaEspera, setListaEspera] = useState([])
  const [cargando, setCargando] = useState(false)
  const [riesgoSuspension, setRiesgoSuspension] = useState([]);
  const [cargandoSuspensiones, setCargandoSuspensiones] = useState(false);
  const [suspensionesActivas, setSuspensionesActivas] = useState([]);
  const [justificaciones, setJustificaciones] = useState([]);
  const [cargandoJustificaciones, setCargandoJustificaciones] = useState(false);
  const [casosCriticos, setCasosCriticos] = useState([]);
  const [cargandoCriticos, setCargandoCriticos] = useState(false);

  // --- Estados Triage ---
  const [filtroServicioTriage, setFiltroServicioTriage] = useState('');
  const [motivoExpandido, setMotivoExpandido] = useState(null);
  
  // --- Nuevos Estados para Buscador y Agendamiento ---
  const [estudiantesGlobal, setEstudiantesGlobal] = useState([]);
  const [busqueda, setBusqueda] = useState('');
  const [estudianteSeleccionado, setEstudianteSeleccionado] = useState(null);
  const [procesoExpandido, setProcesoExpandido] = useState(null);
  const [reservasEstudiante, setReservasEstudiante] = useState([]);
  const [cargandoEstudiantes, setCargandoEstudiantes] = useState(false);
  
  const [demanda, setDemanda] = useState([]);
  const [cargandoDemanda, setCargandoDemanda] = useState(false);
  const [servicioFiltroDemanda, setServicioFiltroDemanda] = useState('');
  const [ubicaciones, setUbicaciones] = useState([]);
  const [ubicacionFiltro, setUbicacionFiltro] = useState('');
  const [celdaSeleccionada, setCeldaSeleccionada] = useState(null);
  // Sub-vista de la pestaña "Demanda / Espera": 'demanda' | 'disponibilidad' | 'reservas'
  const [subVistaDemanda, setSubVistaDemanda] = useState('demanda');

  // --- Estados para Calendario de Disponibilidad (oferta de bloques por servicio) ---
  const [servicioFiltroDisp, setServicioFiltroDisp] = useState('');
  const [bloquesDisp, setBloquesDisp] = useState([]);
  const [cargandoDisp, setCargandoDisp] = useState(false);
  const [celdaSeleccionadaDisp, setCeldaSeleccionadaDisp] = useState(null);
  const [fechaBaseSemanaDisp, setFechaBaseSemanaDisp] = useState(getLunes(new Date()));

  // --- Estados para Sesiones por Registrar (marcar ausente sin ficha) ---
  const [sesionesSinRegistrar, setSesionesSinRegistrar] = useState([]);
  const [cargandoSesiones, setCargandoSesiones] = useState(false);
  const [servicioFiltroSesiones, setServicioFiltroSesiones] = useState('');
  const [profesionalFiltroSesiones, setProfesionalFiltroSesiones] = useState('');

  const [modalAgendar, setModalAgendar] = useState(false);
  const [tipoAgendamiento, setTipoAgendamiento] = useState('normal'); // 'normal' o 'prioritario'
  const [pasoAgendar, setPasoAgendar] = useState(1);
  const [servicios, setServicios] = useState([]);
  const [servicioSeleccionado, setServicioSeleccionado] = useState(null);
  const [bloquesDisponibles, setBloquesDisponibles] = useState([]);
  const [bloqueSeleccionado, setBloqueSeleccionado] = useState(null);
  const [disponibilidadPrioritaria, setDisponibilidadPrioritaria] = useState({});
  const [campusSeleccionadosAdmin, setCampusSeleccionadosAdmin] = useState([]); // ids de ubicación que le sirven al beneficiario (+ '__none__')
  const [motivoConsultaAdmin, setMotivoConsultaAdmin] = useState('');
  const [encuestaAdmin, setEncuestaAdmin] = useState({ q1: "0", q2: "0", q3: "0" });
  const esEntrevistaAdmin = servicioSeleccionado?.nombre?.toLowerCase().includes('entrevista de ingreso') || false;

  // --- Estados para Cambiar Horario de Serie Cíclica ---
  const [modalCambiarSerie, setModalCambiarSerie] = useState(false);
  const [procesoCambiar, setProcesoCambiar] = useState(null);
  const [servicioCambiar, setServicioCambiar] = useState(null);
  const [bloquesParaCambio, setBloquesParaCambio] = useState([]);
  const [bloqueCambioSeleccionado, setBloqueCambioSeleccionado] = useState(null);
  const [pasoCambioSerie, setPasoCambioSerie] = useState(1);
  const [fechaBaseCambioSerie, setFechaBaseCambioSerie] = useState(getLunes(new Date()));
  const [campusSeleccionadosCambio, setCampusSeleccionadosCambio] = useState([]);
  const [disponibilidadCambioEspera, setDisponibilidadCambioEspera] = useState({});

  const toggleHoraDiaCambioEspera = (dia, hora) => {
    setDisponibilidadCambioEspera(prev => {
      const nueva = { ...prev };
      if (!nueva[dia]) nueva[dia] = [];
      if (nueva[dia].includes(hora)) {
        nueva[dia] = nueva[dia].filter(h => h !== hora);
        if (nueva[dia].length === 0) delete nueva[dia];
      } else {
        nueva[dia] = [...nueva[dia], hora];
      }
      return nueva;
    });
  };

  // getLunes importado de utils/calendarUtils

  // --- Estados para Calendario de Reservas ---
  const [calendarioReservas, setCalendarioReservas] = useState([]);
  const [cargandoCalendario, setCargandoCalendario] = useState(false);
  const [celdaSeleccionadaReservas, setCeldaSeleccionadaReservas] = useState(null);
  const [servicioFiltroCalendario, setServicioFiltroCalendario] = useState('');
  
  const [fechaBaseSemanaCalendario, setFechaBaseSemanaCalendario] = useState(getLunes(new Date()));
  const cambiarSemanaCalendario = (dias) => {
    const nueva = new Date(fechaBaseSemanaCalendario);
    nueva.setDate(nueva.getDate() + dias);
    setFechaBaseSemanaCalendario(nueva);
  };

  const diasSemana = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'];
  const horasOpciones = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];

  const [fechaBaseSemanaAdmin, setFechaBaseSemanaAdmin] = useState(getLunes(new Date()));

  const cambiarSemanaAdmin = (dias) => {
    const nueva = new Date(fechaBaseSemanaAdmin);
    nueva.setDate(nueva.getDate() + dias);
    setFechaBaseSemanaAdmin(nueva);
  };

  const campusDisponiblesAdmin = useMemo(() => {
    const map = new Map();
    (Array.isArray(bloquesDisponibles) ? bloquesDisponibles : []).forEach(b => {
      const id = b.ubicacion?.id_ubicacion || '__none__';
      if (!map.has(id)) map.set(id, b.ubicacion?.nombre || 'Sin ubicación');
    });
    return Array.from(map, ([id, nombre]) => ({ id, nombre }));
  }, [bloquesDisponibles]);

  const toggleCampusAdmin = (id) => {
    setCampusSeleccionadosAdmin(prev =>
      prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]
    );
  };

  const bloquesAdminFiltrados = useMemo(() => {
    const base = (Array.isArray(bloquesDisponibles) ? bloquesDisponibles : [])
      .filter(b => campusSeleccionadosAdmin.includes(b.ubicacion?.id_ubicacion || '__none__'));
    return deduplicateCyclicBlocks(base, servicioSeleccionado?.es_ciclico);
  }, [bloquesDisponibles, campusSeleccionadosAdmin, servicioSeleccionado]);

  const getBloquesDisponiblesEnGrillaAdmin = (diaIndex, hora) =>
    getBlocksForCell(bloquesAdminFiltrados, fechaBaseSemanaAdmin, diaIndex, hora);

  // Slots (día+hora) con hora disponible para los campus elegidos: se deshabilitan
  // en la grilla de disponibilidad prioritaria (hay que agendarlos directo).
  const slotsConDisponibilidadAdmin = useMemo(
    () => getSlotsConDisponibilidad(bloquesAdminFiltrados),
    [bloquesAdminFiltrados]
  );

  const campusDisponiblesCambio = useMemo(() => {
    const map = new Map();
    (Array.isArray(bloquesParaCambio) ? bloquesParaCambio : []).forEach(b => {
      const id = b.ubicacion?.id_ubicacion || '__none__';
      if (!map.has(id)) map.set(id, b.ubicacion?.nombre || 'Sin ubicación');
    });
    return Array.from(map, ([id, nombre]) => ({ id, nombre }));
  }, [bloquesParaCambio]);

  const bloquesCambioFiltrados = useMemo(() => {
    const base = (Array.isArray(bloquesParaCambio) ? bloquesParaCambio : [])
      .filter(b => campusSeleccionadosCambio.includes(b.ubicacion?.id_ubicacion || '__none__'));
    return deduplicateCyclicBlocks(base, servicioCambiar?.es_ciclico);
  }, [bloquesParaCambio, campusSeleccionadosCambio, servicioCambiar]);

  const getBloquesEnGrillaCambio = (diaIndex, hora) =>
    getBlocksForCell(bloquesCambioFiltrados, fechaBaseCambioSerie, diaIndex, hora);

  const cerrarSesion = async () => {
    await supabase.auth.signOut()
  }

  const cargarTriage = async () => {
    setCargando(true);
    try {
      const respuesta = await fetch(`${API_URL}/admin/triage`, {
        headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (respuesta.ok) {
        const datos = await respuesta.json();
        setListaEspera(datos);
      }
    } catch (error) {
      console.error("Error al cargar motivos:", error);
    } finally {
      setCargando(false);
    }
  };

  const cargarSuspensiones = async () => {
    setCargandoSuspensiones(true);
    try {
      const [resRiesgo, resActivas] = await Promise.all([
        fetch(`${API_URL}/riesgo_suspension`, {
          headers: { "Authorization": `Bearer ${session.access_token}` }
        }),
        fetch(`${API_URL}/admin/suspensiones_activas`, {
          headers: { "Authorization": `Bearer ${session.access_token}` }
        })
      ]);
      if (resRiesgo.ok) {
        setRiesgoSuspension(await resRiesgo.json());
      }
      if (resActivas.ok) {
        setSuspensionesActivas(await resActivas.json());
      }
    } catch (error) {
      console.error("Error al cargar suspensiones:", error);
    } finally {
      setCargandoSuspensiones(false);
    }
  };

  const levantarSuspension = async (estudiante) => {
    const susp = estudiante.suspensiones || [];
    let objetivo;
    if (susp.length === 1) {
      objetivo = susp[0];
    } else {
      // Está suspendido de varios servicios: preguntar cuál levantar.
      const opciones = susp.map((s, i) => `${i + 1}) ${s.servicio_nombre}`).join("\n");
      const eleccion = window.prompt(
        `${estudiante.estudiante_nombres} ${estudiante.estudiante_apellidos} está suspendido de varios servicios.\n` +
        `Escribe el número del servicio cuya suspensión deseas levantar:\n\n${opciones}`
      );
      if (eleccion === null) return;
      const idx = parseInt(eleccion.trim(), 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= susp.length) {
        alert("Opción inválida.");
        return;
      }
      objetivo = susp[idx];
    }

    if (!window.confirm(
      `¿Levantar la suspensión de ${estudiante.estudiante_nombres} ${estudiante.estudiante_apellidos} en el servicio "${objetivo.servicio_nombre}"?\n\n` +
      `El estudiante podrá volver a agendar este servicio de inmediato.`
    )) return;

    try {
      const respuesta = await fetch(`${API_URL}/admin/levantar_suspension`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ id_suspension: objetivo.id_suspension })
      });
      if (respuesta.ok) {
        alert("Suspensión levantada correctamente.");
        cargarSuspensiones();
      } else {
        const data = await respuesta.json();
        alert("Error al levantar la suspensión: " + data.detail);
      }
    } catch (error) {
      console.error("Error al levantar suspensión:", error);
    }
  };

  const cargarCasosCriticos = async () => {
    setCargandoCriticos(true);
    try {
      const respuesta = await fetch(`${API_URL}/admin/casos_criticos`, {
        headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (respuesta.ok) {
        const datos = await respuesta.json();
        setCasosCriticos(datos);
      }
    } catch (error) {
      console.error("Error al cargar casos críticos:", error);
    } finally {
      setCargandoCriticos(false);
    }
  };

  const suspenderServicio = async (id_proceso) => {
    if (!window.confirm("¿Estás seguro de suspender este servicio?\n\n- Se cerrará su ciclo clínico.\n- Se cancelarán y liberarán todas sus horas futuras.\n- No podrá volver a agendar este servicio por 30 días.")) return;
    
    try {
      const respuesta = await fetch(`${API_URL}/suspender_servicio`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ id_proceso })
      });
      
      if (respuesta.ok) {
        alert("El estudiante ha sido suspendido y sus bloques han sido devueltos a la comunidad.");
        cargarSuspensiones(); // Recargamos la lista para que el estudiante desaparezca
      } else {
        const data = await respuesta.json();
        alert("Error al suspender: " + data.detail);
      }
    } catch (error) {
      console.error("Error al suspender servicio:", error);
    }
  };

  const perdonarInasistencia = async (id_proceso) => {
    if (!window.confirm("¿Seguro que deseas descontar 1 falta a este estudiante?")) return;
    try {
      const respuesta = await fetch(`${API_URL}/admin/reducir_inasistencia/${id_proceso}`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (respuesta.ok) {
        cargarSuspensiones();
      } else {
        const errorData = await respuesta.json();
        alert("Error al reducir falta: " + (errorData.detail || "Error interno"));
      }
    } catch (error) {
      console.error("Error al reducir falta:", error);
    }
  };

  const cargarJustificaciones = async () => {
    setCargandoJustificaciones(true);
    try {
      const respuesta = await fetch(`${API_URL}/admin/justificaciones`, {
        headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (respuesta.ok) {
        setJustificaciones(await respuesta.json());
      }
    } catch (error) {
      console.error("Error al cargar justificaciones:", error);
    } finally {
      setCargandoJustificaciones(false);
    }
  };

  const resolverJustificacion = async (id_inasistencia, aprobada) => {
    const verbo = aprobada ? "APROBAR" : "RECHAZAR";
    if (!window.confirm(`¿${verbo} esta justificación?` + (aprobada ? "\n\nNo contará como falta y, si el servicio es cíclico, se agendará una sesión de reposición." : "\n\nSe registrará una falta (+1) para el estudiante."))) return;
    try {
      const respuesta = await fetch(`${API_URL}/admin/resolver_justificacion`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
        body: JSON.stringify({ id_inasistencia, aprobada })
      });
      if (respuesta.ok) {
        const data = await respuesta.json();
        let msg = data.mensaje || "Listo.";
        if (aprobada && data.reposicion) {
          msg += `\nReposición agendada: ${new Date(data.reposicion.fecha_hora_inicio).toLocaleString()}`;
        } else if (aprobada && data.reposicion === null) {
          msg += "\n(No se agendó reposición: servicio no cíclico o sin bloque disponible.)";
        }
        alert(msg);
        cargarJustificaciones();
        cargarSuspensiones();
      } else {
        const data = await respuesta.json();
        alert("Error: " + data.detail);
      }
    } catch (error) {
      console.error("Error al resolver justificación:", error);
    }
  };

  const justificarDirecto = async (id_reserva) => {
    if (!window.confirm("¿Marcar esta inasistencia como JUSTIFICADA (sin falta)?\n\nEquivale a tratarla como una cancelación con más de 48h de anticipación. Si el servicio es cíclico, se agendará una reposición.")) return;
    try {
      const respuesta = await fetch(`${API_URL}/admin/justificar_directo`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
        body: JSON.stringify({ id_reserva })
      });
      if (respuesta.ok) {
        const data = await respuesta.json();
        let msg = data.mensaje || "Inasistencia justificada.";
        if (data.reposicion) msg += `\nReposición agendada: ${new Date(data.reposicion.fecha_hora_inicio).toLocaleString()}`;
        alert(msg);
        seleccionarEstudiante(estudianteSeleccionado);
      } else {
        const data = await respuesta.json();
        alert("Error: " + data.detail);
      }
    } catch (error) {
      console.error("Error al justificar directo:", error);
    }
  };

  // --- Nuevas Funciones para Triage ---
  const marcarComoCritico = async (origen, id_item) => {
    if (!window.confirm("¿Enviar este ESTUDIANTE a revisión como caso crítico? Sus reservas se mantendrán hasta que coordinación confirme el caso.")) return;
    try {
      const respuesta = await fetch(`${API_URL}/admin/triage/${origen}/${id_item}/critico`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (respuesta.ok) {
        alert("✓ Estudiante marcado como pendiente de revisión");
        cargarTriage();
      } else {
        const errorData = await respuesta.json();
        alert("Error: " + (errorData.detail || "Error interno"));
      }
    } catch (error) {
      console.error(error);
    }
  };

  const marcarComoRevisado = async (origen, id_item) => {
    if (!window.confirm("¿Confirmas que leíste el motivo? El estudiante desaparecerá de esta lista y seguirá su flujo normal.")) return;
    try {
      const respuesta = await fetch(`${API_URL}/admin/triage/${origen}/${id_item}/revisado`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (respuesta.ok) {
        cargarTriage();
      } else {
        const errorData = await respuesta.json();
        alert("Error al marcar como revisado: " + (errorData.detail || "Error interno"));
      }
    } catch (error) {
      console.error("Error:", error);
    }
  };

  // --- Nuevas Funciones para Buscador de Estudiantes ---
  const cargarEstudiantes = async () => {
    setCargandoEstudiantes(true);
    try {
      const respuesta = await fetch(`${API_URL}/admin/estudiantes`, {
        headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (respuesta.ok) setEstudiantesGlobal(await respuesta.json());
    } catch (e) { console.error(e); } finally { setCargandoEstudiantes(false); }
  };

  const seleccionarEstudiante = async (estudiante) => {
    setEstudianteSeleccionado(estudiante);
    setProcesoExpandido(null);
    try {
      const respuesta = await fetch(`${API_URL}/admin/estudiantes/${estudiante.id_estudiante}/reservas`, {
        headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (respuesta.ok) setReservasEstudiante(await respuesta.json());
    } catch (e) { console.error(e); }
  };

  const cancelarReservaAdmin = async (id_reserva) => {
    if (!window.confirm("¿Estás segura de eliminar esta hora del estudiante?")) return;
    try {
      const respuesta = await fetch(`${API_URL}/admin/cancelar_reserva`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
        body: JSON.stringify({ id_reserva })
      });
      if (respuesta.ok) {
        alert("Hora cancelada exitosamente.");
        seleccionarEstudiante(estudianteSeleccionado); // Recargar reservas
      } else {
        alert("Error al cancelar la reserva.");
      }
    } catch (e) { console.error(e); }
  };

  const marcarInasistenciaAdmin = async (id_reserva, onSuccess) => {
    if (!window.confirm("¿Estás segura de marcar a este estudiante como AUSENTE? Esto aumentará su contador de inasistencias.")) return;
    try {
      const respuesta = await fetch(`${API_URL}/asistencia`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
        body: JSON.stringify({ id_reserva, estado: 'ausente' })
      });
      if (respuesta.ok) {
        alert("Inasistencia registrada exitosamente.");
        if (onSuccess) onSuccess();
        else seleccionarEstudiante(estudianteSeleccionado); // Recargar historial
      } else {
        const errorData = await respuesta.json();
        alert("Error al registrar inasistencia: " + (errorData.detail || "Error interno"));
      }
    } catch (e) { console.error(e); }
  };

  const cargarSesionesSinRegistrar = async () => {
    setCargandoSesiones(true);
    try {
      const respuesta = await fetch(`${API_URL}/admin/sesiones_sin_registrar`, {
        headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (respuesta.ok) setSesionesSinRegistrar(await respuesta.json());
    } catch (e) { console.error(e); } finally { setCargandoSesiones(false); }
  };

  const cargarUbicaciones = async () => {
    try {
      const res = await fetch(`${API_URL}/ubicaciones`);
      if (res.ok) setUbicaciones(await res.json());
    } catch (e) { console.error(e); }
  };

  // --- Funciones para Demanda (Heatmap) ---
  const cargarDemanda = async () => {
    setCargandoDemanda(true);
    try {
      const respuesta = await fetch(`${API_URL}/admin/demanda_espera`, {
        headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (respuesta.ok) setDemanda(await respuesta.json());

      if (servicios.length === 0) {
        const resServ = await fetch(`${API_URL}/servicios`, { headers: { "Authorization": `Bearer ${session.access_token}` }});
        if (resServ.ok) setServicios(await resServ.json());
      }
    } catch (e) { console.error(e); } finally { setCargandoDemanda(false); }
  };

  const cambiarSemanaDisp = (dias) => {
    const nueva = new Date(fechaBaseSemanaDisp);
    nueva.setDate(nueva.getDate() + dias);
    setFechaBaseSemanaDisp(nueva);
  };

  const cargarDisponibilidadCalendario = async (idServicio) => {
    setServicioFiltroDisp(idServicio);
    setBloquesDisp([]);
    if (!idServicio) return;
    setCargandoDisp(true);
    try {
      const respuesta = await fetch(`${API_URL}/disponibilidad?id_servicio=${idServicio}`, {
        headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (respuesta.ok) {
        const data = await respuesta.json();
        setBloquesDisp(Array.isArray(data) ? data : (data?.data || []));
      }
    } catch (e) { console.error(e); } finally { setCargandoDisp(false); }
  };

  const cargarCalendarioReservas = async () => {
    setCargandoCalendario(true);
    try {
      const respuesta = await fetch(`${API_URL}/admin/calendario_reservas`, {
        headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (respuesta.ok) setCalendarioReservas(await respuesta.json());

      if (servicios.length === 0) {
        const resServ = await fetch(`${API_URL}/servicios`, { headers: { "Authorization": `Bearer ${session.access_token}` }});
        if (resServ.ok) setServicios(await resServ.json());
      }
    } catch (e) { console.error(e); } finally { setCargandoCalendario(false); }
  };

  // --- Funciones para Modal de Agendamiento ---
  const iniciarAgendamiento = async (tipo) => {
    setTipoAgendamiento(tipo);
    setModalAgendar(true);
    setPasoAgendar(1);
    setServicioSeleccionado(null);
    setBloqueSeleccionado(null);
    setDisponibilidadPrioritaria({});
    setMotivoConsultaAdmin('');
    setEncuestaAdmin({ q1: "0", q2: "0", q3: "0" });
    try {
      const respuesta = await fetch(`${API_URL}/servicios`, { headers: { "Authorization": `Bearer ${session.access_token}` }});
      if (respuesta.ok) setServicios(await respuesta.json());
    } catch (e) { console.error(e); }
  };

  const avanzarAServicio = async (servicio) => {
    setServicioSeleccionado(servicio);
    setPasoAgendar(2);
    setFechaBaseSemanaAdmin(getLunes(new Date()));
    try {
      const respuesta = await fetch(`${API_URL}/disponibilidad?id_servicio=${servicio.id_servicio}`, {
        headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (respuesta.ok) {
        const data = await respuesta.json();
        const arr = Array.isArray(data) ? data : (data?.data || []);
        setBloquesDisponibles(arr);
        const campusIds = [...new Set(arr.map(b => b.ubicacion?.id_ubicacion || '__none__'))];
        setCampusSeleccionadosAdmin(campusIds);
      }
    } catch (e) { console.error(e); }
  };

  const toggleHoraDiaAdmin = (dia, hora) => {
    setDisponibilidadPrioritaria(prev => {
      const nueva = { ...prev };
      if (!nueva[dia]) nueva[dia] = [];
      
      if (nueva[dia].includes(hora)) {
        nueva[dia] = nueva[dia].filter(h => h !== hora);
        if (nueva[dia].length === 0) delete nueva[dia];
      } else {
        nueva[dia] = [...nueva[dia], hora];
      }
      return nueva;
    });
  };

  const confirmarAgendamientoAdmin = async () => {
    if (tipoAgendamiento === 'prioritario' && Object.keys(disponibilidadPrioritaria).length === 0 && !bloqueSeleccionado) {
      alert("Para un agendamiento prioritario debes indicar la disponibilidad del estudiante o seleccionar un bloque.");
      return;
    }

    if (!motivoConsultaAdmin.trim()) {
      alert("Por favor, ingresa la observación adicional.");
      return;
    }

    const motivoFinalAdmin = buildMotivoFinal(esEntrevistaAdmin, encuestaAdmin, motivoConsultaAdmin);

    try {
      const respuesta = await fetch(`${API_URL}/admin/agendar_hora`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
        body: JSON.stringify({
          id_estudiante: estudianteSeleccionado.id_estudiante,
          id_servicio: servicioSeleccionado.id_servicio,
          id_bloque: bloqueSeleccionado ? bloqueSeleccionado.id_bloque : null,
          tipo_agendamiento: tipoAgendamiento,
          disponibilidad_indicada: tipoAgendamiento === 'prioritario' ? disponibilidadPrioritaria : null,
          campus_indicados: (tipoAgendamiento === 'prioritario' && campusSeleccionadosAdmin.filter(c => c !== '__none__').length > 0)
            ? campusSeleccionadosAdmin.filter(c => c !== '__none__')
            : null,
          motivo_consulta: motivoFinalAdmin
        })
      });
      if (respuesta.ok) {
        alert("Hora agendada exitosamente al estudiante.");
        setModalAgendar(false);
        seleccionarEstudiante(estudianteSeleccionado); // Recargar historial
      } else {
        const err = await respuesta.json();
        alert("Error al agendar: " + err.detail);
      }
    } catch (e) { console.error(e); }
  };

  const iniciarCambioSerie = async (proceso) => {
    setProcesoCambiar(proceso);
    setBloqueCambioSeleccionado(null);
    setPasoCambioSerie(1);
    setFechaBaseCambioSerie(getLunes(new Date()));
    setDisponibilidadCambioEspera({});
    setModalCambiarSerie(true);
    try {
      let serviciosList = servicios;
      if (serviciosList.length === 0) {
        const res = await fetch(`${API_URL}/servicios`, { headers: { "Authorization": `Bearer ${session.access_token}` } });
        if (res.ok) { serviciosList = await res.json(); setServicios(serviciosList); }
      }
      const srv = serviciosList.find(s => s.id_servicio === proceso.id_servicio) || null;
      setServicioCambiar(srv);
      const res = await fetch(`${API_URL}/disponibilidad?id_servicio=${proceso.id_servicio}`, {
        headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (res.ok) {
        const data = await res.json();
        const arr = Array.isArray(data) ? data : (data?.data || []);
        setBloquesParaCambio(arr);
        const ids = [...new Set(arr.map(b => b.ubicacion?.id_ubicacion || '__none__'))];
        setCampusSeleccionadosCambio(ids);
      }
    } catch (e) { console.error(e); }
  };

  const confirmarCambioSerie = async () => {
    if (!bloqueCambioSeleccionado) return;
    try {
      const res = await fetch(`${API_URL}/admin/cambiar_serie`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
        body: JSON.stringify({ id_proceso: procesoCambiar.id_proceso, id_bloque_nuevo: bloqueCambioSeleccionado.id_bloque })
      });
      if (res.ok) {
        alert("Horario del ciclo cambiado exitosamente.");
        setModalCambiarSerie(false);
        seleccionarEstudiante(estudianteSeleccionado);
      } else {
        const err = await res.json();
        alert("Error: " + err.detail);
      }
    } catch (e) { console.error(e); }
  };

  const confirmarListaEsperaSerie = async () => {
    if (!procesoCambiar) return;
    if (Object.keys(disponibilidadCambioEspera).length === 0) {
      alert("Marca al menos un horario en el que el estudiante quiere quedar en lista de espera.");
      return;
    }
    try {
      const campusFiltrados = campusSeleccionadosCambio.filter(c => c !== '__none__');
      const res = await fetch(`${API_URL}/admin/cancelar_serie_a_lista_espera`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
        body: JSON.stringify({
          id_proceso: procesoCambiar.id_proceso,
          disponibilidad_indicada: disponibilidadCambioEspera,
          campus_indicados: campusFiltrados.length > 0 ? campusFiltrados : null
        })
      });
      if (res.ok) {
        alert("Sesiones canceladas. El estudiante quedó en lista de espera prioritaria.");
        setModalCambiarSerie(false);
        seleccionarEstudiante(estudianteSeleccionado);
      } else {
        const err = await res.json();
        alert("Error: " + err.detail);
      }
    } catch (e) { console.error(e); }
  };

  useEffect(() => {
    if (vista === 'triage') {
      cargarTriage();
    } else if (vista === 'buscador') {
      cargarEstudiantes();
    } else if (vista === 'suspensiones') {
      cargarSuspensiones();
      cargarJustificaciones();
    } else if (vista === 'criticos') {
      cargarCasosCriticos();
    } else if (vista === 'demanda') {
      cargarDemanda();
      cargarCalendarioReservas();
      cargarUbicaciones();
    } else if (vista === 'sesiones') {
      cargarSesionesSinRegistrar();
    }
  }, [vista]);

  const tabClass = (v, danger) => `px-4 py-2 rounded-t-lg font-medium whitespace-nowrap flex-shrink-0 ${vista === v ? (danger ? 'bg-red-100 text-red-800 border-b-4 border-red-600' : 'bg-blue-100 text-blue-800 border-b-4 border-blue-600') : 'text-gray-500 hover:text-blue-600 hover:bg-gray-100'}`;

  const subTabDemandaClass = (v) => `px-4 py-1.5 rounded-full text-sm font-semibold transition ${subVistaDemanda === v ? 'bg-blue-600 text-white shadow' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`;

  return (
    <div className="min-h-screen bg-gray-50 text-gray-800" style={{ fontFamily: 'sans-serif' }}>
      {/* Navbar Superior */}
      <header className="text-white p-4 shadow-md flex justify-between items-center gap-3" style={{ backgroundColor: '#003366' }}>
        <h1 className="text-lg md:text-xl font-bold whitespace-nowrap">Administración UBE</h1>
        <div className="flex items-center gap-2 md:gap-4 min-w-0">
          <span className="text-xs md:text-sm truncate hidden sm:inline">{session.user.email}</span>
          <button onClick={cerrarSesion} className="bg-red-600 hover:bg-red-700 px-3 py-1 rounded text-sm font-semibold transition flex-shrink-0">
            Cerrar Sesión
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4 md:p-6">
        {/* Navegación por pestañas */}
        <div className="flex gap-2 border-b-2 border-gray-200 mb-6 pb-2 overflow-x-auto">
          <button onClick={() => setVista('inicio')} className={tabClass('inicio')}>Inicio</button>
          <button onClick={() => setVista('triage')} className={tabClass('triage')}>Leer Motivos</button>
          <button onClick={() => setVista('criticos')} className={tabClass('criticos', true)}>Casos Críticos</button>
          <button onClick={() => setVista('buscador')} className={tabClass('buscador')}>Buscador Estudiantes</button>
          <button onClick={() => setVista('demanda')} className={tabClass('demanda')}>Demanda / Reservas</button>
          <button onClick={() => setVista('sesiones')} className={tabClass('sesiones')}>Sesiones por Registrar</button>
          <button onClick={() => setVista('suspensiones')} className={tabClass('suspensiones')}>Faltas y Suspensiones</button>
        </div>

        {vista === 'inicio' && (
          <div>
            <h1 className="text-3xl font-bold text-gray-800 mb-4">Panel de Administración Central</h1>
            <p className="text-gray-600">Desde aquí puedes gestionar las listas de espera, revisar casos críticos y ver estudiantes suspendidos.</p>
          </div>
        )}
        {vista === 'triage' && (
          <section className="bg-white p-6 rounded-lg shadow-md mt-6">
            <h2 className="text-2xl font-bold text-gray-800 mb-4">Leer Motivos de Estudiantes</h2>
            <p className="text-gray-600 mb-6">Revisa los motivos de consulta de los estudiantes. Si marcas como crítico a un estudiante, quedará pendiente para revisión de coordinación sin cancelar sus reservas todavía.</p>
            
            <div className="mb-4 flex items-center gap-2">
              <label className="font-bold text-gray-700">Filtrar por Servicio:</label>
              <select 
                value={filtroServicioTriage} 
                onChange={e => setFiltroServicioTriage(e.target.value)} 
                className="p-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">Todos los servicios</option>
                {Array.from(new Set(listaEspera.map(item => item.servicio_nombre))).map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>

            {cargando ? (
              <div className="text-center text-gray-500 py-10">Cargando motivos de estudiantes...</div>
            ) : listaEspera.length === 0 ? (
              <div className="border-dashed border-2 border-gray-300 p-10 text-center text-gray-500 rounded-lg">
                No hay estudiantes pendientes de revisión de motivos en este momento.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full bg-white border border-gray-200">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="py-2 px-4 border-b text-left text-sm font-semibold text-gray-700">Estado/Origen</th>
                      <th className="py-2 px-4 border-b text-left text-sm font-semibold text-gray-700">Estudiante</th>
                      <th className="py-2 px-4 border-b text-left text-sm font-semibold text-gray-700">Ingreso</th>
                      <th className="py-2 px-4 border-b text-left text-sm font-semibold text-gray-700">Motivo de Consulta</th>
                      <th className="py-2 px-4 border-b text-left text-sm font-semibold text-gray-700">Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {listaEspera.filter(item => !filtroServicioTriage || item.servicio_nombre === filtroServicioTriage).map((item) => {
                      const esEntrevista = item.servicio_nombre?.toLowerCase().includes('entrevista de ingreso');
                      const motivoTexto = item.motivo_consulta || 'Sin motivo indicado';
                      const partesMotivo = esEntrevista ? motivoTexto.split('\n') : [motivoTexto];
                      const indexHeader = partesMotivo.findIndex(linea => linea.includes('[Encuesta'));
                      const puntajeHeader = esEntrevista && indexHeader !== -1 ? partesMotivo[indexHeader] : '';
                      const detalleMotivo = puntajeHeader ? partesMotivo.slice(indexHeader + 1).join('\n') : motivoTexto;
                      const isExpandido = motivoExpandido === item.id;
                      
                      let puntajeColorClass = 'text-blue-800 bg-blue-100 border-blue-200';
                      if (puntajeHeader) {
                        const match = puntajeHeader.match(/Puntaje:\s*(\d+)/);
                        if (match) {
                          const score = parseInt(match[1], 10);
                          if (score > 6) puntajeColorClass = 'text-red-800 bg-red-100 border-red-200';
                          else if (score > 3) puntajeColorClass = 'text-orange-800 bg-orange-100 border-orange-200';
                        }
                      }
                      
                      return (
                      <tr key={`${item.origen}-${item.id}`} className="hover:bg-gray-50">
                        <td className="py-2 px-4 border-b">
                          {item.origen === 'lista_espera' ? (
                            <span className="bg-orange-100 text-orange-800 text-xs font-bold px-2 py-1 rounded">En Lista de Espera</span>
                          ) : (
                            <span className="bg-blue-100 text-blue-800 text-xs font-bold px-2 py-1 rounded">Hora Reservada</span>
                          )}
                        </td>
                        <td className="py-2 px-4 border-b text-sm">
                          <div className="font-bold">{item.estudiante_nombres} {item.estudiante_apellidos}</div>
                          <div className="text-gray-500 text-xs">RUT: {item.estudiante_rut} - {item.servicio_nombre}</div>
                        </td>
                        <td className="py-2 px-4 border-b text-sm text-gray-600">{new Date(item.fecha).toLocaleDateString()}</td>
                        <td className="py-2 px-4 border-b text-sm max-w-xs break-words italic text-gray-700">
                          {esEntrevista && puntajeHeader ? (
                            <div className="flex flex-col items-start gap-1">
                              <div className="flex items-center gap-2">
                                <span className={`px-2 py-1 rounded text-xs font-bold not-italic border ${puntajeColorClass}`}>
                                  {puntajeHeader.replace('[', '').replace(']', '')}
                                </span>
                                <button 
                                  onClick={() => setMotivoExpandido(isExpandido ? null : item.id)}
                                  className="text-xs text-blue-600 underline hover:text-blue-800 font-semibold cursor-pointer"
                                >
                                  {isExpandido ? 'Ocultar Detalle' : 'Ver Detalle'}
                                </button>
                              </div>
                              {isExpandido && detalleMotivo && (
                                <div className="mt-1 text-xs bg-gray-50 p-2 border border-gray-200 rounded whitespace-pre-wrap text-gray-800 not-italic shadow-inner w-full">
                                  {detalleMotivo}
                                </div>
                              )}
                            </div>
                          ) : (
                            `"${motivoTexto}"`
                          )}
                        </td>
                        <td className="py-2 px-4 border-b text-sm flex flex-col gap-2">
                          <button 
                            className="bg-green-600 hover:bg-green-700 text-white font-bold py-1 px-3 rounded text-xs transition"
                            onClick={() => marcarComoRevisado(item.origen, item.id)}
                          >
                          Marcar como Revisado
                          </button>
                          <button 
                            className="bg-orange-600 hover:bg-orange-700 text-white font-bold py-1 px-3 rounded text-xs transition"
                            onClick={() => marcarComoCritico(item.origen, item.id)}
                          >
                          Solicitar Revisión Crítica
                          </button>
                        </td>
                      </tr>
                    )})}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
        {vista === 'criticos' && (
          <section className="bg-white p-6 rounded-lg shadow-md mt-6">
            <h2 className="text-2xl font-bold text-red-700 mb-4">Registro de Casos Críticos</h2>
            <p className="text-gray-600 mb-6">Listado histórico de estudiantes marcados como prioritarios o de riesgo.</p>
            
            {cargandoCriticos ? (
              <div className="text-center text-gray-500 py-10">Cargando casos críticos...</div>
            ) : casosCriticos.length === 0 ? (
              <div className="border-dashed border-2 border-gray-300 p-10 text-center text-gray-500 rounded-lg">
                No hay casos críticos registrados.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full bg-white border border-gray-200">
                  <thead className="bg-red-50">
                    <tr>
                      <th className="py-2 px-4 border-b text-left text-sm font-semibold text-red-800">Estudiante</th>
                      <th className="py-2 px-4 border-b text-left text-sm font-semibold text-red-800">Servicio</th>
                      <th className="py-2 px-4 border-b text-left text-sm font-semibold text-red-800">Origen / Fecha</th>
                      <th className="py-2 px-4 border-b text-left text-sm font-semibold text-red-800">Motivo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {casosCriticos.map((item, index) => (
                      <tr key={index} className="hover:bg-red-50">
                        <td className="py-2 px-4 border-b text-sm">
                          <div className="font-bold text-gray-800">{item.nombres} {item.apellidos}</div>
                          <div className="text-gray-500 text-xs">RUT: {item.rut} | {item.carrera}</div>
                        </td>
                        <td className="py-2 px-4 border-b text-sm font-semibold text-gray-700">{item.servicio}</td>
                        <td className="py-2 px-4 border-b text-sm text-gray-600">
                          <span className="bg-red-100 text-red-800 text-xs font-bold px-2 py-1 rounded block w-max mb-1">{item.origen}</span>
                          {new Date(item.fecha).toLocaleDateString()}
                        </td>
                        <td className="py-2 px-4 border-b text-sm max-w-xs break-words italic text-gray-700">"{item.motivo || 'N/A'}"</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
        {vista === 'buscador' && (
          <section className="bg-white p-6 rounded-lg shadow-md mt-6 flex gap-6">
            {/* Panel Izquierdo: Buscador */}
            <div className="w-1/3 border-r pr-6">
              <h2 className="text-xl font-bold text-gray-800 mb-4">Buscar Estudiante</h2>
              <input 
                type="text" 
                placeholder="Buscar por nombre o RUT..." 
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                className="w-full p-2 border border-gray-300 rounded mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <div className="h-96 overflow-y-auto">
                {cargandoEstudiantes ? (
                  <p className="text-gray-500 text-sm">Cargando...</p>
                ) : (
                  estudiantesGlobal.filter(e => e.nombres.toLowerCase().includes(busqueda.toLowerCase()) || e.rut.includes(busqueda)).map(est => (
                    <div 
                      key={est.id_estudiante} 
                      onClick={() => seleccionarEstudiante(est)}
                      className={`p-3 border-b cursor-pointer hover:bg-blue-50 transition ${estudianteSeleccionado?.id_estudiante === est.id_estudiante ? 'bg-blue-100 border-l-4 border-blue-600' : ''}`}
                    >
                      <p className="font-bold text-gray-800">{est.nombres} {est.apellidos}</p>
                      <p className="text-xs text-gray-500">RUT: {est.rut}</p>
                    </div>
                  ))
                )}
              </div>
            </div>
            
            {/* Panel Derecho: Detalles y Gestión */}
            <div className="w-2/3">
              {!estudianteSeleccionado ? (
                <div className="flex items-center justify-center h-full text-gray-400">Selecciona un estudiante de la lista para gestionar sus horas.</div>
              ) : (
                <div>
                  <h2 className="text-2xl font-bold text-blue-900 mb-2">{estudianteSeleccionado.nombres} {estudianteSeleccionado.apellidos}</h2>
                  <p className="text-gray-600 mb-6">Carrera: {estudianteSeleccionado.carrera} | RUT: {estudianteSeleccionado.rut}</p>
                  
                  <div className="flex gap-4 mb-8">
                    <button onClick={() => iniciarAgendamiento('normal')} className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded shadow">
                      Agendar Hora Normal
                    </button>
                    <button onClick={() => iniciarAgendamiento('prioritario')} className="bg-yellow-500 hover:bg-yellow-600 text-white font-bold py-2 px-4 rounded shadow">
                      Agendar Hora Prioritaria
                    </button>
                  </div>

                  <h3 className="text-lg font-bold text-gray-800 border-b pb-2 mb-4">Historial de Servicios</h3>
                  <HistorialEstudiante
                    procesos={reservasEstudiante}
                    procesoExpandido={procesoExpandido}
                    onToggleProceso={setProcesoExpandido}
                    renderAccionesProceso={(proceso) => {
                      if (!proceso.es_ciclico || proceso.estado !== 'activo') return null;
                      const tienePendientesFuturos = proceso.reservas.some(
                        r => r.estado === 'pendiente' && r.fecha && new Date(r.fecha) > new Date()
                      );
                      if (!tienePendientesFuturos) return null;
                      return (
                        <button
                          onClick={() => iniciarCambioSerie(proceso)}
                          className="mt-1 bg-purple-100 text-purple-800 hover:bg-purple-200 font-bold py-1 px-3 rounded text-xs"
                        >
                          Cambiar Horario del Ciclo
                        </button>
                      );
                    }}
                    renderAcciones={(res) => {
                      const esAusencia = ['ausente', 'atraso', 'cancelado_estudiante_tarde'].includes(res.estado);
                      const yaJustificada = res.inasistencia_estado === 'justificada';
                      if (res.estado === 'pendiente') {
                        return (
                          <div className="flex flex-col gap-2 items-end">
                            <button onClick={() => cancelarReservaAdmin(res.id_reserva)} className="bg-red-100 text-red-700 hover:bg-red-200 font-bold py-1 px-3 rounded text-xs w-full text-center">Eliminar Reserva</button>
                            {new Date(res.fecha) < new Date() && (
                              <button onClick={() => marcarInasistenciaAdmin(res.id_reserva)} className="bg-orange-100 text-orange-800 hover:bg-orange-200 font-bold py-1 px-3 rounded text-xs w-full text-center" title="Visible porque la hora de atención ya pasó">Marcar Ausente</button>
                            )}
                          </div>
                        );
                      }
                      if (esAusencia) {
                        return (
                          <div className="flex flex-col gap-2 items-end">
                            {yaJustificada ? (
                              <span className="bg-green-100 text-green-800 font-bold py-1 px-3 rounded text-xs text-center">Justificada</span>
                            ) : (
                              <button onClick={() => justificarDirecto(res.id_reserva)} className="bg-green-100 text-green-800 hover:bg-green-200 font-bold py-1 px-3 rounded text-xs w-full text-center" title="Marca esta inasistencia como justificada (sin falta)">Justificar (sin falta)</button>
                            )}
                          </div>
                        );
                      }
                      return null;
                    }}
                  />
                </div>
              )}
            </div>
          </section>
        )}
        {vista === 'suspensiones' && (
          <div className="space-y-6 mt-6">
            {/* SECCIÓN A: Justificaciones pendientes de revisar */}
            <section className="bg-white p-6 rounded-lg shadow-md border-t-4 border-amber-500">
              <h2 className="text-2xl font-bold text-amber-800 mb-2">Justificaciones por revisar</h2>
              <p className="text-gray-600 mb-6">El estudiante explicó por qué faltó. Si <strong>apruebas</strong>, no cuenta como falta (y se agenda reposición si el servicio es cíclico). Si <strong>rechazas</strong>, suma 1 falta.</p>

              {cargandoJustificaciones ? (
                <div className="text-center text-gray-500 py-6">Cargando...</div>
              ) : justificaciones.length === 0 ? (
                <div className="border-dashed border-2 border-gray-300 p-8 text-center text-gray-500 rounded-lg">
                  No hay justificaciones pendientes de revisión.
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {justificaciones.map((j) => {
                    const tipoTxt = j.tipo === 'cancelacion_tardia' ? 'Cancelación <48h' : j.tipo === 'atraso' ? 'Atraso' : 'No se presentó';
                    return (
                      <div key={j.id_inasistencia} className="border border-gray-200 rounded-lg p-4">
                        <div className="flex justify-between items-start gap-3 flex-wrap">
                          <div className="min-w-0">
                            <div className="font-bold text-gray-800">{j.estudiante_nombres} {j.estudiante_apellidos} <span className="text-gray-400 text-xs font-normal">RUT: {j.estudiante_rut}</span></div>
                            <div className="text-sm text-gray-600">{j.servicio_nombre} · {tipoTxt} {j.fecha_inasistencia ? `· ${new Date(j.fecha_inasistencia).toLocaleDateString()}` : ''}</div>
                            <p className="text-sm text-gray-800 mt-2 bg-amber-50 border border-amber-100 rounded p-2 italic">"{j.motivo_estudiante}"</p>
                          </div>
                          <div className="flex flex-col gap-2 flex-shrink-0">
                            <button onClick={() => resolverJustificacion(j.id_inasistencia, true)} className="bg-green-600 hover:bg-green-700 text-white font-bold py-1 px-4 rounded text-xs">Aprobar</button>
                            <button onClick={() => resolverJustificacion(j.id_inasistencia, false)} className="bg-red-100 hover:bg-red-200 text-red-800 font-bold py-1 px-4 rounded text-xs">Rechazar</button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* SECCIÓN B: Registro de faltas y suspensiones */}
            <section className="bg-white p-6 rounded-lg shadow-md">
              <h2 className="text-2xl font-bold text-gray-800 mb-4">Registro de Faltas y Suspensiones</h2>
              <p className="text-gray-600 mb-6">Estudiantes con <strong>faltas</strong> (inasistencias rechazadas o vencidas sin justificar) en procesos activos. A partir de 2 faltas puedes suspender.</p>

              {cargandoSuspensiones ? (
                <div className="text-center text-gray-500 py-10">Cargando registros...</div>
              ) : riesgoSuspension.length === 0 ? (
                <div className="border-dashed border-2 border-gray-300 p-10 text-center text-gray-500 rounded-lg">
                  Excelente. No hay estudiantes con faltas registradas actualmente.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full bg-white border border-gray-200">
                    <thead className="bg-gray-100">
                      <tr>
                        <th className="py-2 px-4 border-b text-left text-sm font-semibold text-gray-700">Faltas</th>
                        <th className="py-2 px-4 border-b text-left text-sm font-semibold text-gray-700">Estudiante</th>
                        <th className="py-2 px-4 border-b text-left text-sm font-semibold text-gray-700">Servicio</th>
                        <th className="py-2 px-4 border-b text-left text-sm font-semibold text-gray-700">Acción</th>
                      </tr>
                    </thead>
                    <tbody>
                      {riesgoSuspension.map((item) => (
                        <tr key={item.id_proceso} className="hover:bg-gray-50">
                          <td className="py-2 px-4 border-b">
                            <span className={`text-xs font-bold px-2 py-1 rounded ${item.faltas_acumuladas >= 2 ? 'bg-red-100 text-red-800' : 'bg-yellow-100 text-yellow-800'}`}>
                              {item.faltas_acumuladas} Falta{item.faltas_acumuladas === 1 ? '' : 's'}
                            </span>
                            {item.inasistencias_acumuladas > item.faltas_acumuladas && (
                              <div className="text-gray-400 text-[10px] mt-1">{item.inasistencias_acumuladas} inasistencias totales</div>
                            )}
                          </td>
                          <td className="py-2 px-4 border-b text-sm">
                            <div className="font-bold">{item.estudiante_nombres} {item.estudiante_apellidos}</div>
                            <div className="text-gray-500 text-xs">RUT: {item.estudiante_rut}</div>
                          </td>
                          <td className="py-2 px-4 border-b text-sm">{item.servicio_nombre}</td>
                          <td className="py-2 px-4 border-b text-sm flex gap-2">
                            <button
                              className="bg-blue-100 hover:bg-blue-200 text-blue-800 font-bold py-1 px-3 rounded text-xs transition"
                              onClick={() => perdonarInasistencia(item.id_proceso)}
                              title="Descuenta 1 falta del contador"
                            >
                              -1 Falta
                            </button>
                            {item.faltas_acumuladas >= 2 && (
                              <button
                                className="bg-red-600 hover:bg-red-700 text-white font-bold py-1 px-3 rounded text-xs transition"
                                onClick={() => suspenderServicio(item.id_proceso)}
                              >
                                Suspender
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* SECCIÓN C: Estudiantes actualmente suspendidos */}
            <section className="bg-white p-6 rounded-lg shadow-md border-t-4 border-red-500">
              <h2 className="text-2xl font-bold text-red-800 mb-2">Estudiantes Suspendidos</h2>
              <p className="text-gray-600 mb-6">Estudiantes con una suspensión activa. La suspensión es <strong>por servicio</strong>. Presiona "Levantar Suspensión" para reactivar un servicio (si está suspendido de varios, podrás elegir cuál).</p>

              {cargandoSuspensiones ? (
                <div className="text-center text-gray-500 py-10">Cargando suspensiones...</div>
              ) : suspensionesActivas.length === 0 ? (
                <div className="border-dashed border-2 border-gray-300 p-10 text-center text-gray-500 rounded-lg">
                  No hay estudiantes suspendidos actualmente.
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {suspensionesActivas.map((est) => (
                    <div key={est.id_estudiante} className="border border-gray-200 rounded-lg p-4 flex justify-between items-start gap-3 flex-wrap">
                      <div className="min-w-0">
                        <div className="font-bold text-gray-800">
                          {est.estudiante_nombres} {est.estudiante_apellidos}
                          <span className="text-gray-400 text-xs font-normal ml-2">RUT: {est.estudiante_rut}</span>
                        </div>
                        <div className="flex flex-wrap gap-2 mt-2">
                          {est.suspensiones.map((s) => (
                            <span key={s.id_suspension} className="text-xs font-semibold bg-red-100 text-red-800 px-2 py-1 rounded">
                              {s.servicio_nombre}
                              {s.fecha_fin && (
                                <span className="font-normal text-red-600"> · hasta {new Date(s.fecha_fin).toLocaleDateString()}</span>
                              )}
                            </span>
                          ))}
                        </div>
                      </div>
                      <button
                        className="bg-green-600 hover:bg-green-700 text-white font-bold py-1 px-4 rounded text-xs transition flex-shrink-0"
                        onClick={() => levantarSuspension(est)}
                      >
                        Levantar Suspensión
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
        {vista === 'demanda' && (
          <section className="bg-white p-6 rounded-lg shadow-md mt-6">
            <h2 className="text-2xl font-bold text-gray-800 mb-2">Demanda, Disponibilidad y Reservas</h2>
            <p className="text-gray-600 mb-4">Revisa en qué horarios hay más demanda (lista de espera), dónde hay cupos disponibles por servicio y las horas ya agendadas.</p>

            <div className="flex flex-wrap items-center gap-4 mb-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
              <div className="flex items-center gap-2">
                <label className="font-semibold text-gray-700 text-sm">Campus:</label>
                <select value={ubicacionFiltro} onChange={e => setUbicacionFiltro(e.target.value)} className="p-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">Todos los campus</option>
                  {ubicaciones.filter(u => u.activo).map(u => <option key={u.id_ubicacion} value={u.id_ubicacion}>{u.nombre}</option>)}
                </select>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 mb-6 border-b pb-4">
              <button onClick={() => setSubVistaDemanda('demanda')} className={subTabDemandaClass('demanda')}>Calendario de Demanda</button>
              <button onClick={() => setSubVistaDemanda('disponibilidad')} className={subTabDemandaClass('disponibilidad')}>Calendario de Disponibilidad</button>
              <button onClick={() => setSubVistaDemanda('reservas')} className={subTabDemandaClass('reservas')}>Calendario de Reservas</button>
            </div>

            {/* ===== Sub-vista: CALENDARIO DE DEMANDA (heatmap) ===== */}
            {subVistaDemanda === 'demanda' && (
              <div>
                <p className="text-gray-600 mb-4 text-sm">Visualiza en qué horarios los estudiantes están solicitando atención. Haz clic en un bloque para ver el orden de prioridad de la fila.</p>
                <div className="mb-4 flex items-center gap-2">
                  <label className="font-bold text-gray-700">Servicio:</label>
                  <select
                    value={servicioFiltroDemanda}
                    onChange={e => setServicioFiltroDemanda(e.target.value)}
                    className="p-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">-- Selecciona un servicio --</option>
                    {servicios.map(s => <option key={s.id_servicio} value={s.id_servicio}>{s.nombre}</option>)}
                  </select>
                </div>

                {!servicioFiltroDemanda ? (
                  <div className="border-dashed border-2 border-gray-300 p-10 text-center text-gray-500 rounded-lg">
                    Selecciona un servicio para ver la demanda de lista de espera.
                  </div>
                ) : cargandoDemanda ? (
                  <div className="text-center text-gray-500 py-10">Cargando demanda...</div>
                ) : (
                  <div className="overflow-x-auto pb-4">
                    <table className="w-full min-w-[800px] table-fixed border-collapse border-2 border-gray-300 text-sm bg-white">
                      <thead>
                        <tr>
                          <th className="w-20 p-3 border-2 border-gray-300 bg-gray-100 text-gray-700">Hora</th>
                          {diasSemana.map(dia => (
                            <th key={dia} className="p-3 border-2 border-gray-300 bg-gray-100 capitalize font-bold text-gray-700">{dia}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {horasOpciones.map(hora => {
                          const duracionMin = servicios.find(s => s.id_servicio === servicioFiltroDemanda)?.duracion_minutos || 60;
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
                              <td className="p-2 border-2 border-gray-300 text-center font-bold bg-gray-50 text-gray-600 align-top w-20 text-xs">{hora}</td>
                              {diasSemana.map(dia => (
                                <td key={`${dia}-${hora}`} className="border-2 border-gray-300 p-1 align-top bg-white">
                                  <div className="flex flex-col gap-1">
                                    {subSlots.map(({ inicio }) => {
                                      const estudiantesSlot = demanda.filter(est => {
                                        if (est.servicio?.id_servicio !== servicioFiltroDemanda) return false;
                                        const disp = est.disponibilidad_indicada || {};
                                        if (!disp[dia]?.includes(inicio)) return false;
                                        if (ubicacionFiltro) {
                                          const campus = est.campus_indicados;
                                          if (campus && campus.length > 0 && !campus.includes(ubicacionFiltro)) return false;
                                        }
                                        return true;
                                      });
                                      estudiantesSlot.sort((a, b) => {
                                        if (a.es_prioritario && !b.es_prioritario) return -1;
                                        if (!a.es_prioritario && b.es_prioritario) return 1;
                                        return new Date(a.fecha_ingreso) - new Date(b.fecha_ingreso);
                                      });
                                      const count = estudiantesSlot.length;
                                      return count > 0 ? (
                                        <button
                                          key={inicio}
                                          onClick={() => setCeldaSeleccionada({ dia, hora: inicio, estudiantes: estudiantesSlot })}
                                          className={`min-h-[36px] w-full flex items-center justify-center rounded text-[11px] font-semibold text-center cursor-pointer shadow-sm ${count > 2 ? 'bg-red-100 hover:bg-red-200 border border-red-400 text-red-800' : 'bg-yellow-100 hover:bg-yellow-200 border border-yellow-400 text-yellow-800'}`}
                                        >
                                          {count} {count === 1 ? 'estudiante' : 'estudiantes'}
                                        </button>
                                      ) : (
                                        <div key={inicio} className="min-h-[36px] flex items-center justify-center rounded text-[9px] border border-gray-100 bg-gray-50 text-gray-200">
                                          {inicio}
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
                )}
              </div>
            )}

            {/* ===== Sub-vista: CALENDARIO DE DISPONIBILIDAD (oferta) ===== */}
            {subVistaDemanda === 'disponibilidad' && (
              <div>
                <p className="text-gray-600 mb-4 text-sm">Elige un servicio para ver cuántos cupos hay disponibles en cada horario. Haz clic en un bloque para ver qué profesionales atienden.</p>
                <div className="flex flex-wrap justify-between items-center gap-3 mb-4">
                  <div className="flex items-center gap-2">
                    <label className="font-bold text-gray-700">Servicio:</label>
                    <select
                      value={servicioFiltroDisp}
                      onChange={e => cargarDisponibilidadCalendario(e.target.value)}
                      className="p-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">-- Selecciona un servicio --</option>
                      {servicios.map(s => <option key={s.id_servicio} value={s.id_servicio}>{s.nombre}</option>)}
                    </select>
                  </div>
                  <div className="flex space-x-2">
                    <button onClick={() => cambiarSemanaDisp(-7)} className="px-3 py-1 bg-gray-200 rounded font-bold text-sm">&larr; Ant</button>
                    <span className="px-4 py-1 font-semibold border rounded bg-white text-sm">Semana del {fechaBaseSemanaDisp.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })}</span>
                    <button onClick={() => cambiarSemanaDisp(7)} className="px-3 py-1 bg-gray-200 rounded font-bold text-sm">Sig &rarr;</button>
                  </div>
                </div>

                {!servicioFiltroDisp ? (
                  <div className="border-dashed border-2 border-gray-300 p-10 text-center text-gray-500 rounded-lg">
                    Selecciona un servicio para ver su disponibilidad.
                  </div>
                ) : cargandoDisp ? (
                  <div className="text-center text-gray-500 py-10">Cargando disponibilidad...</div>
                ) : (
                  <div className="overflow-x-auto pb-4">
                    <table className="w-full min-w-[800px] table-fixed border-collapse border-2 border-gray-300 text-sm bg-white">
                      <thead>
                        <tr>
                          <th className="w-20 p-3 border-2 border-gray-300 bg-gray-100 text-gray-700">Hora</th>
                          {diasSemana.map((dia, i) => {
                            const f = new Date(fechaBaseSemanaDisp); f.setDate(f.getDate() + i);
                            return <th key={dia} className="p-3 border-2 border-gray-300 bg-gray-100 capitalize font-bold text-gray-700">{dia} <br/> <span className="text-xs font-normal text-gray-500">{f.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}</span></th>;
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {horasOpciones.map(hora => {
                          const duracionMin = servicios.find(s => s.id_servicio === servicioFiltroDisp)?.duracion_minutos || 60;
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
                            <td className="p-2 border-2 border-gray-300 text-center font-bold bg-gray-50 text-gray-600 align-top w-20 text-xs">{hora}</td>
                            {diasSemana.map((dia, i) => {
                              const fechaDia = new Date(fechaBaseSemanaDisp);
                              fechaDia.setDate(fechaBaseSemanaDisp.getDate() + i);
                              const anio = fechaDia.getFullYear();
                              const mes = String(fechaDia.getMonth() + 1).padStart(2, '0');
                              const d = String(fechaDia.getDate()).padStart(2, '0');
                              const fechaStr = `${anio}-${mes}-${d}`;

                              return (
                                <td key={`${dia}-${hora}`} className="border-2 border-gray-300 p-1 align-top bg-white">
                                  <div className="flex flex-col gap-1">
                                    {subSlots.map(({ inicio, fin }) => {
                                      const bloquesSlot = bloquesDisp.filter(b => {
                                        if (!b.fecha_hora_inicio) return false;
                                        const [bFechaStr, bHoraStr] = b.fecha_hora_inicio.replace(' ', 'T').split('T');
                                        if (bFechaStr !== fechaStr || bHoraStr.substring(0, 5) !== inicio) return false;
                                        if (ubicacionFiltro && b.ubicacion?.id_ubicacion !== ubicacionFiltro) return false;
                                        return true;
                                      });
                                      const count = bloquesSlot.length;
                                      return count > 0 ? (
                                        <button
                                          key={inicio}
                                          onClick={() => setCeldaSeleccionadaDisp({ dia, hora: inicio, fecha: fechaStr, bloques: bloquesSlot })}
                                          className="min-h-[40px] flex flex-col justify-center items-center bg-green-100 hover:bg-green-200 border border-green-500 text-green-900 rounded text-[10px] text-center shadow-sm cursor-pointer"
                                        >
                                          <span className="font-bold">{inicio} - {fin}</span>
                                          <span className="font-semibold">{count} {count === 1 ? 'cupo' : 'cupos'}</span>
                                        </button>
                                      ) : (
                                        <div key={inicio} className="min-h-[40px] flex flex-col justify-center items-center rounded text-[10px] border border-gray-200 bg-gray-50 text-gray-300">
                                          <span>{inicio} - {fin}</span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </td>
                              )
                            })}
                          </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* ===== Sub-vista: CALENDARIO DE RESERVAS (horas agendadas) ===== */}
            {subVistaDemanda === 'reservas' && (
              <div>
                <p className="text-gray-600 mb-4 text-sm">Visualiza las horas agendadas de los estudiantes en la semana. Haz clic en un bloque para ver qué estudiantes están citados en ese horario.</p>
                <div className="flex flex-wrap justify-between items-center gap-3 mb-4">
                  <div className="flex items-center gap-2">
                    <label className="font-bold text-gray-700">Servicio:</label>
                    <select
                      value={servicioFiltroCalendario}
                      onChange={e => setServicioFiltroCalendario(e.target.value)}
                      className="p-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">-- Selecciona un servicio --</option>
                      {servicios.map(s => <option key={s.id_servicio} value={s.id_servicio}>{s.nombre}</option>)}
                    </select>
                  </div>
                  <div className="flex space-x-2">
                    <button onClick={() => cambiarSemanaCalendario(-7)} className="px-3 py-1 bg-gray-200 rounded font-bold text-sm">&larr; Ant</button>
                    <span className="px-4 py-1 font-semibold border rounded bg-white text-sm">Semana del {fechaBaseSemanaCalendario.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })}</span>
                    <button onClick={() => cambiarSemanaCalendario(7)} className="px-3 py-1 bg-gray-200 rounded font-bold text-sm">Sig &rarr;</button>
                  </div>
                </div>

                {!servicioFiltroCalendario ? (
                  <div className="border-dashed border-2 border-gray-300 p-10 text-center text-gray-500 rounded-lg">
                    Selecciona un servicio para ver las reservas agendadas.
                  </div>
                ) : cargandoCalendario ? (
                  <div className="text-center text-gray-500 py-10">Cargando reservas...</div>
                ) : (
                  <div className="overflow-x-auto pb-4">
                    <table className="w-full min-w-[800px] table-fixed border-collapse border-2 border-gray-300 text-sm bg-white">
                      <thead>
                        <tr>
                          <th className="w-20 p-3 border-2 border-gray-300 bg-gray-100 text-gray-700">Hora</th>
                          {diasSemana.map((dia, i) => {
                            const f = new Date(fechaBaseSemanaCalendario); f.setDate(f.getDate() + i);
                            return <th key={dia} className="p-3 border-2 border-gray-300 bg-gray-100 capitalize font-bold text-gray-700">{dia} <br/> <span className="text-xs font-normal text-gray-500">{f.toLocaleDateString('es-ES', {day: 'numeric', month: 'short'})}</span></th>;
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {horasOpciones.map(hora => {
                          const duracionMin = servicios.find(s => s.id_servicio === servicioFiltroCalendario)?.duracion_minutos || 60;
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
                              <td className="p-2 border-2 border-gray-300 text-center font-bold bg-gray-50 text-gray-600 align-top w-20 text-xs">{hora}</td>
                              {diasSemana.map((dia, i) => {
                                const fechaDia = new Date(fechaBaseSemanaCalendario);
                                fechaDia.setDate(fechaBaseSemanaCalendario.getDate() + i);
                                const anio = fechaDia.getFullYear();
                                const mes = String(fechaDia.getMonth() + 1).padStart(2, '0');
                                const d = String(fechaDia.getDate()).padStart(2, '0');
                                const fechaStr = `${anio}-${mes}-${d}`;
                                return (
                                  <td key={`${dia}-${hora}`} className="border-2 border-gray-300 p-1 align-top bg-white">
                                    <div className="flex flex-col gap-1">
                                      {subSlots.map(({ inicio }) => {
                                        const reservasSlot = calendarioReservas.filter(res => {
                                          if (res.bloque_horario?.id_servicio !== servicioFiltroCalendario) return false;
                                          if (!res.bloque_horario?.fecha_hora_inicio) return false;
                                          const [bFechaStr, bHoraStr] = res.bloque_horario.fecha_hora_inicio.replace(' ', 'T').split('T');
                                          if (bFechaStr !== fechaStr || bHoraStr.substring(0, 5) !== inicio) return false;
                                          if (ubicacionFiltro && res.bloque_horario?.ubicacion?.id_ubicacion !== ubicacionFiltro) return false;
                                          return true;
                                        });
                                        const count = reservasSlot.length;
                                        return count > 0 ? (
                                          <button
                                            key={inicio}
                                            onClick={() => setCeldaSeleccionadaReservas({ dia, hora: inicio, fecha: fechaStr, reservas: reservasSlot })}
                                            className="min-h-[36px] w-full flex items-center justify-center bg-blue-100 hover:bg-blue-200 border border-blue-400 text-blue-900 rounded text-[11px] font-semibold text-center shadow-sm"
                                          >
                                            {count} {count === 1 ? 'reserva' : 'reservas'}
                                          </button>
                                        ) : (
                                          <div key={inicio} className="min-h-[36px] flex items-center justify-center rounded text-[9px] border border-gray-100 bg-gray-50 text-gray-200">
                                            {inicio}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

          </section>
        )}
        {vista === 'sesiones' && (
          <section className="bg-white p-6 rounded-lg shadow-md mt-6">
            <h2 className="text-2xl font-bold text-gray-800 mb-4">Sesiones por Registrar</h2>
            <p className="text-gray-600 mb-6">Citas cuyo horario ya pasó y siguen pendientes sin ficha clínica subida. Puedes marcar ausente al estudiante (esto aumenta su contador de inasistencias). No reemplaza el registro de la ficha por parte del profesional.</p>

            <div className="mb-4 flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <label className="font-bold text-gray-700">Servicio:</label>
                <select
                  value={servicioFiltroSesiones}
                  onChange={e => setServicioFiltroSesiones(e.target.value)}
                  className="p-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Todos los servicios</option>
                  {Array.from(new Map(sesionesSinRegistrar.map(s => [s.id_servicio, s.servicio_nombre])).entries())
                    .map(([id, nombre]) => <option key={id} value={id}>{nombre}</option>)}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <label className="font-bold text-gray-700">Profesional:</label>
                <select
                  value={profesionalFiltroSesiones}
                  onChange={e => setProfesionalFiltroSesiones(e.target.value)}
                  className="p-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Todos los profesionales</option>
                  {Array.from(new Map(sesionesSinRegistrar.map(s => [s.id_profesional, `${s.profesional_nombres} ${s.profesional_apellidos}`])).entries())
                    .map(([id, nombre]) => <option key={id} value={id}>{nombre}</option>)}
                </select>
              </div>
            </div>

            {cargandoSesiones ? (
              <div className="text-center text-gray-500 py-10">Cargando sesiones...</div>
            ) : (() => {
              const filtradas = sesionesSinRegistrar.filter(s =>
                (!servicioFiltroSesiones || s.id_servicio === servicioFiltroSesiones) &&
                (!profesionalFiltroSesiones || s.id_profesional === profesionalFiltroSesiones)
              );
              return filtradas.length === 0 ? (
                <div className="border-dashed border-2 border-gray-300 p-10 text-center text-gray-500 rounded-lg">
                  No hay sesiones pendientes sin registrar.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full bg-white border border-gray-200">
                    <thead className="bg-gray-100">
                      <tr>
                        <th className="py-2 px-4 border-b text-left text-sm font-semibold text-gray-700">Estudiante</th>
                        <th className="py-2 px-4 border-b text-left text-sm font-semibold text-gray-700">Servicio</th>
                        <th className="py-2 px-4 border-b text-left text-sm font-semibold text-gray-700">Profesional</th>
                        <th className="py-2 px-4 border-b text-left text-sm font-semibold text-gray-700">Fecha de la cita</th>
                        <th className="py-2 px-4 border-b text-left text-sm font-semibold text-gray-700">Estado</th>
                        <th className="py-2 px-4 border-b text-left text-sm font-semibold text-gray-700">Acción</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtradas.map((s) => (
                        <tr key={s.id_reserva} className="hover:bg-gray-50">
                          <td className="py-2 px-4 border-b text-sm">
                            <div className="font-bold">{s.estudiante_nombres} {s.estudiante_apellidos}</div>
                            <div className="text-gray-500 text-xs">RUT: {s.estudiante_rut}</div>
                          </td>
                          <td className="py-2 px-4 border-b text-sm">{s.servicio_nombre}</td>
                          <td className="py-2 px-4 border-b text-sm">{s.profesional_nombres} {s.profesional_apellidos}</td>
                          <td className="py-2 px-4 border-b text-sm text-gray-600">{new Date(s.fecha).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                          <td className="py-2 px-4 border-b text-sm">
                            <span className="bg-orange-100 text-orange-800 text-xs font-bold px-2 py-1 rounded">Sesión sin registrar</span>
                          </td>
                          <td className="py-2 px-4 border-b text-sm">
                            <button
                              onClick={() => marcarInasistenciaAdmin(s.id_reserva, cargarSesionesSinRegistrar)}
                              className="bg-orange-100 text-orange-800 hover:bg-orange-200 font-bold py-1 px-3 rounded text-xs transition"
                            >
                              Marcar Ausente
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })()}
          </section>
        )}
      </main>

      {/* Modal Detalle de Demanda */}
      {celdaSeleccionada && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg p-6 max-w-2xl w-full max-h-[80vh] flex flex-col shadow-xl">
            <div className="flex justify-between items-center mb-4 border-b pb-3">
              <h3 className="text-xl font-bold text-gray-800">
                Fila para el <span className="capitalize">{celdaSeleccionada.dia}</span> a las {celdaSeleccionada.hora}
              </h3>
              <button onClick={() => setCeldaSeleccionada(null)} className="text-gray-400 hover:text-red-500 font-bold text-2xl transition">✕</button>
            </div>
            
            <div className="overflow-y-auto flex-1 pr-2">
              <div className="flex flex-col gap-3">
                {celdaSeleccionada.estudiantes.map((est, i) => (
                  <div key={est.id_lista} className={`p-4 border rounded-lg flex items-start gap-4 shadow-sm ${est.es_prioritario ? 'border-red-400 bg-red-50' : 'bg-white border-gray-200'}`}>
                    <div className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center font-bold text-lg text-white shadow ${est.es_prioritario ? 'bg-red-600' : 'bg-blue-600'}`}>
                      {i + 1}
                    </div>
                    <div className="flex-1">
                      <div className="flex justify-between items-start mb-1">
                        <h4 className="font-bold text-gray-900 text-lg">{est.estudiante?.nombres} {est.estudiante?.apellidos}</h4>
                        {est.es_prioritario && <span className="bg-red-600 text-white text-[10px] px-2 py-1 rounded font-bold tracking-wide">CASO CRÍTICO / PRIORITARIO</span>}
                      </div>
                      <div className="text-sm text-gray-600 mb-2">
                        <p><strong>RUT:</strong> {est.estudiante?.rut} <span className="mx-2">|</span> <strong>Servicio:</strong> {est.servicio?.nombre}</p>
                        <p><strong>Ingreso a lista:</strong> {new Date(est.fecha_ingreso).toLocaleString()}</p>
                      </div>
                      {est.motivo_consulta && (
                        <div className="bg-white bg-opacity-60 p-2 rounded text-sm italic text-gray-700 border border-gray-100">
                          "{est.motivo_consulta}"
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal Detalle de Reservas */}
      {celdaSeleccionadaReservas && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg p-6 max-w-2xl w-full max-h-[80vh] flex flex-col shadow-xl">
            <div className="flex justify-between items-center mb-4 border-b pb-3">
              <h3 className="text-xl font-bold text-gray-800">
                Reservas para el <span className="capitalize">{celdaSeleccionadaReservas.dia}</span> a las {celdaSeleccionadaReservas.hora}
              </h3>
              <button onClick={() => setCeldaSeleccionadaReservas(null)} className="text-gray-400 hover:text-red-500 font-bold text-2xl transition">✕</button>
            </div>
            
            <div className="overflow-y-auto flex-1 pr-2">
              <div className="flex flex-col gap-3">
                {celdaSeleccionadaReservas.reservas.map((res, i) => {
                  const est = res.proceso_clinico?.estudiante;
                  const bloque = res.bloque_horario;
                  const prof = bloque?.profesional;
                  return (
                    <div key={res.id_reserva} className={`p-4 border rounded-lg flex items-start gap-4 shadow-sm bg-white border-gray-200`}>
                      <div className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center font-bold text-lg text-white shadow bg-green-600`}>{i + 1}</div>
                      <div className="flex-1">
                        <div className="flex justify-between items-start mb-1">
                          <h4 className="font-bold text-gray-900 text-lg">{est?.nombres} {est?.apellidos}</h4>
                          <span className={`text-[10px] px-2 py-1 rounded font-bold uppercase ${res.estado === 'presente' ? 'bg-green-100 text-green-800' : 'bg-blue-100 text-blue-800'}`}>{res.estado}</span>
                        </div>
                        <div className="text-sm text-gray-600 mb-2">
                          <p><strong>RUT:</strong> {est?.rut} <span className="mx-2">|</span> <strong>Servicio:</strong> {bloque?.servicio?.nombre}</p>
                          <p><strong>Profesional:</strong> {prof?.nombres} {prof?.apellidos}</p>
                          <p><strong>📍 Ubicación:</strong> {bloque?.ubicacion?.nombre || 'Sin ubicación'}</p>
                          <p><strong>Hora Cita:</strong> {new Date(bloque?.fecha_hora_inicio).toLocaleTimeString('es-ES', {hour: '2-digit', minute: '2-digit'})}</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal Detalle de Disponibilidad (profesionales por cupo) */}
      {celdaSeleccionadaDisp && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg p-6 max-w-2xl w-full max-h-[80vh] flex flex-col shadow-xl">
            <div className="flex justify-between items-center mb-4 border-b pb-3">
              <h3 className="text-xl font-bold text-gray-800">
                Disponibilidad del <span className="capitalize">{celdaSeleccionadaDisp.dia}</span> a las {celdaSeleccionadaDisp.hora}
              </h3>
              <button onClick={() => setCeldaSeleccionadaDisp(null)} className="text-gray-400 hover:text-red-500 font-bold text-2xl transition">✕</button>
            </div>

            <div className="overflow-y-auto flex-1 pr-2">
              <div className="flex flex-col gap-4">
                {(() => {
                  const grupos = {};
                  celdaSeleccionadaDisp.bloques.forEach(b => {
                    const t = b.fecha_hora_inicio.replace(' ', 'T').split('T')[1];
                    const hhmm = t.substring(0, 5);
                    (grupos[hhmm] ||= []).push(b);
                  });
                  return Object.keys(grupos).sort().map(hhmm => {
                    const bloques = grupos[hhmm];
                    const fin = bloques[0].fecha_hora_fin
                      ? bloques[0].fecha_hora_fin.replace(' ', 'T').split('T')[1].substring(0, 5)
                      : null;
                    return (
                      <div key={hhmm} className="border border-gray-200 rounded-lg p-3">
                        <div className="flex items-center justify-between mb-2">
                          <span className="font-bold text-gray-800">{hhmm}{fin ? ` – ${fin}` : ''}</span>
                          <span className="text-xs font-semibold text-green-800 bg-green-100 px-2 py-0.5 rounded-full">
                            {bloques.length} {bloques.length === 1 ? 'profesional' : 'profesionales'}
                          </span>
                        </div>
                        <ul className="flex flex-col gap-1">
                          {bloques.map(b => (
                            <li key={b.id_bloque} className="flex items-center justify-between text-sm text-gray-700 bg-gray-50 rounded px-3 py-1.5">
                              <span className="font-semibold">{b.profesional?.nombres} {b.profesional?.apellidos}</span>
                              <span className="text-xs text-gray-500">📍 {b.ubicacion?.nombre || 'Sin ubicación'}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal Multi-paso de Agendamiento Manual (Normal y Prioritario) */}
      {modalAgendar && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <h3 className="text-2xl font-bold text-blue-900 mb-2">
              Agendamiento {tipoAgendamiento === 'prioritario' ? 'Prioritario (Alta Prioridad)' : 'Normal'}
            </h3>
            <p className="text-gray-600 mb-4 border-b pb-2">Estudiante: <strong>{estudianteSeleccionado?.nombres} {estudianteSeleccionado?.apellidos}</strong></p>
            
            {pasoAgendar === 1 && (
              <div>
                <p className="font-bold mb-3">1. Selecciona el servicio:</p>
                <div className="grid grid-cols-2 gap-3">
                  {servicios.map(srv => {
                    const serviciosBloqueados = reservasEstudiante
                      .filter(p => p.reservas.some(r => r.estado === 'pendiente' || r.estado === 'presente'))
                      .map(p => p.servicio_nombre);
                    const estaBloqueado = serviciosBloqueados.includes(srv.nombre);

                    return (
                      <button 
                        key={srv.id_servicio} 
                        onClick={() => !estaBloqueado && avanzarAServicio(srv)} 
                        className={`p-3 border rounded text-left transition ${estaBloqueado ? 'bg-red-50 border-red-200 cursor-not-allowed opacity-75' : 'hover:bg-blue-50'}`}
                        title={estaBloqueado ? 'El estudiante ya tiene una cita pendiente para este servicio' : ''}
                      >
                        <p className={`font-bold ${estaBloqueado ? 'text-red-700' : ''}`}>{srv.nombre}</p>
                        <p className="text-xs text-gray-500">{srv.es_ciclico ? 'Tratamiento' : 'Atención Única'}</p>
                        {estaBloqueado && <p className="text-xs text-red-600 font-semibold mt-1">Cita pendiente activa</p>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {pasoAgendar === 2 && (
              <div>
                <button onClick={() => setPasoAgendar(1)} className="text-blue-600 text-sm mb-3">← Volver a servicios</button>
                
                {tipoAgendamiento === 'prioritario' && (
                  <button onClick={() => { setBloqueSeleccionado(null); setPasoAgendar(3); }} className="mb-4 w-full bg-yellow-100 hover:bg-yellow-200 text-yellow-800 font-bold py-2 px-4 rounded border border-yellow-300 transition">
                    Ninguna hora actual sirve (Enviar directo a Lista Prioritaria)
                  </button>
                )}
                <p className="font-bold mb-3">2. Selecciona un bloque disponible para {servicioSeleccionado?.nombre}:</p>
                {campusDisponiblesAdmin.length > 1 && (
                  <div className="mb-4 bg-white border border-gray-200 rounded-lg p-3">
                    <p className="text-xs font-semibold text-gray-700 mb-2">📍 Campus que le sirven al beneficiario:</p>
                    <div className="flex flex-wrap gap-2">
                      {campusDisponiblesAdmin.map(c => {
                        const activo = campusSeleccionadosAdmin.includes(c.id);
                        return (
                          <button
                            key={c.id}
                            onClick={() => toggleCampusAdmin(c.id)}
                            className={`px-3 py-1 rounded-full text-xs font-medium border transition ${activo ? 'bg-blue-600 text-white border-blue-700' : 'bg-white text-gray-600 border-gray-300 hover:bg-blue-50'}`}
                          >
                            {activo ? '✓ ' : ''}{c.nombre}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {bloquesDisponibles.length === 0 ? (
                  <p className="p-4 bg-yellow-50 text-yellow-800 rounded border border-yellow-200">No hay bloques disponibles en este momento.</p>
                ) : (
                  <div>
                    <div className="flex justify-between items-center mb-4 mt-2">
                      <div className="flex space-x-2">
                        <button onClick={() => cambiarSemanaAdmin(-7)} className="px-3 py-1 bg-gray-200 rounded hover:bg-gray-300 font-bold text-sm">&larr; Ant</button>
                        <span className="px-4 py-1 font-semibold border rounded bg-white text-sm">
                          Semana del {fechaBaseSemanaAdmin.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })}
                        </span>
                        <button onClick={() => cambiarSemanaAdmin(7)} className="px-3 py-1 bg-gray-200 rounded hover:bg-gray-300 font-bold text-sm">Sig &rarr;</button>
                      </div>
                    </div>

                    <div className="overflow-x-auto pb-4">
                      <table className="w-full min-w-[800px] table-fixed border-collapse border-2 border-gray-300 text-sm bg-white">
                        <thead>
                          <tr>
                            <th className="w-20 p-2 border-2 border-gray-300 bg-gray-100 text-gray-700">Hora</th>
                            {diasSemana.map((dia, i) => {
                              const fechaHeader = new Date(fechaBaseSemanaAdmin);
                              fechaHeader.setDate(fechaBaseSemanaAdmin.getDate() + i);
                              return (
                                <th key={dia} className="p-2 border-2 border-gray-300 bg-gray-100 font-bold text-gray-700 capitalize">
                                  {dia} <br/> <span className="text-xs font-normal text-gray-500">{fechaHeader.toLocaleDateString('es-ES', {day: 'numeric', month: 'short'})}</span>
                                </th>
                              );
                            })}
                          </tr>
                        </thead>
                        <tbody>
                          {horasOpciones.map(hora => {
                            const duracionMin = servicioSeleccionado?.duracion_minutos || 60;
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
                              <td className="p-2 border-2 border-gray-300 text-center font-bold text-gray-500 bg-gray-50 align-top w-20 text-xs">
                                {hora} - {String(parseInt(hora.split(':')[0]) + 1).padStart(2, '0')}:00
                              </td>
                              {diasSemana.map((_, i) => {
                                const bloquesCelda = getBloquesDisponiblesEnGrillaAdmin(i, hora);
                                return (
                                  <td key={i} className="border-2 border-gray-300 p-1 align-top bg-white">
                                    <div className="flex flex-col gap-1">
                                      {mergeSlotsConBloques(subSlots, bloquesCelda, duracionMin).map(({ inicio, fin, bloques }) => {
                                        // Un bloque por campus disponible en este horario (getBlocksForCell ya deduplica por hora+campus).
                                        return bloques.length > 0 ? (
                                          bloques.map(bloque => (
                                            <button
                                              key={`${inicio}-${bloque.id_bloque}`}
                                              onClick={() => { setBloqueSeleccionado(bloque); setPasoAgendar(tipoAgendamiento === 'prioritario' ? 3 : 4); }}
                                              className="min-h-[40px] flex flex-col justify-center items-center bg-green-100 hover:bg-green-200 border border-green-500 text-green-900 rounded text-[10px] text-center shadow-sm transition cursor-pointer"
                                            >
                                              <span className="font-bold">{inicio} - {fin}</span>
                                              <span className="font-semibold text-[9px]">📍 {bloque.ubicacion?.nombre || 'Sin ubicación'}</span>
                                            </button>
                                          ))
                                        ) : (
                                          <div key={inicio} className="min-h-[40px] flex flex-col justify-center items-center rounded text-[10px] border border-gray-200 bg-gray-50 text-gray-300">
                                            <span>{inicio} - {fin}</span>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </td>
                                );
                              })}
                            </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}

            {pasoAgendar === 3 && tipoAgendamiento === 'prioritario' && (
              <div>
                <button onClick={() => setPasoAgendar(2)} className="text-blue-600 text-sm mb-3">← Volver a bloques</button>
                <p className="font-bold mb-1 text-yellow-600">3. Solicitud de Disponibilidad Restante</p>
                <p className="text-sm text-gray-600 mb-4">
                  {bloqueSeleccionado ? 'Marca los horarios adicionales donde tiene libre para intentar ascenderlo si se libera una hora más cercana.' : 'Marca los horarios donde el estudiante tiene disponibilidad para buscarle una hora prioritaria.'}
                </p>
                
                <div className="overflow-x-auto mb-6">
                  <table className="w-full min-w-[800px] table-fixed border-collapse border-2 border-gray-300 text-sm bg-white">
                    <thead>
                      <tr>
                        <th className="w-20 p-2 border-2 border-gray-300 bg-gray-100">Hora</th>
                        {diasSemana.map(dia => (
                          <th key={dia} className="p-2 border-2 border-gray-300 bg-gray-100 font-bold capitalize text-gray-700">{dia}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {horasOpciones.map(hora => {
                        const duracionMin = servicioSeleccionado?.duracion_minutos || 60;
                        const startMin = parseInt(hora.split(':')[0], 10) * 60;
                        const subSlots = [];
                        for (let m = startMin; m + duracionMin <= startMin + 60; m += duracionMin) {
                          const hh = String(Math.floor(m / 60)).padStart(2, '0');
                          const mm = String(m % 60).padStart(2, '0');
                          const endMin = m + duracionMin;
                          subSlots.push({ inicio: `${hh}:${mm}`, fin: `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}` });
                        }
                        return (
                        <tr key={hora}>
                          <td className="p-2 border-2 border-gray-300 text-center font-bold text-gray-500 bg-gray-50 text-xs">
                            {hora} - {String(parseInt(hora.split(':')[0]) + 1).padStart(2, '0')}:00
                          </td>
                          {diasSemana.map(dia => (
                            <td key={`${dia}-${hora}`} className="border-2 border-gray-300 p-1 align-top bg-white">
                              <div className="flex flex-col gap-1">
                                {subSlots.map(({ inicio, fin }) => {
                                  const hayDisponible = slotsConDisponibilidadAdmin.has(`${dia}|${inicio}`);
                                  const seleccionado = disponibilidadPrioritaria[dia] && disponibilidadPrioritaria[dia].includes(inicio);
                                  if (hayDisponible) {
                                    return (
                                      <div key={inicio} title="Hay una hora disponible en este horario. Agéndala directamente desde el calendario de bloques." className="min-h-[40px] flex flex-col justify-center items-center rounded text-[10px] border border-green-300 bg-green-50 text-green-700 cursor-not-allowed">
                                        <span className="font-bold">{inicio} - {fin}</span>
                                        <span className="text-[9px]">Hay hora</span>
                                      </div>
                                    );
                                  }
                                  return (
                                    <div key={inicio} onClick={() => toggleHoraDiaAdmin(dia, inicio)} className={`min-h-[40px] flex flex-col justify-center items-center rounded text-[10px] border cursor-pointer transition ${seleccionado ? 'bg-yellow-500 hover:bg-yellow-600 text-white border-yellow-600 shadow-inner' : 'hover:bg-yellow-50 text-gray-300 border-gray-200 hover:text-yellow-500 hover:border-yellow-300'}`}>
                                      <span className="font-bold">{inicio} - {fin}</span>
                                      {seleccionado && <span className="text-[9px]">✓</span>}
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
                <button onClick={() => setPasoAgendar(4)} className="mt-4 w-full bg-blue-600 text-white font-bold py-2 rounded">Continuar a Confirmación →</button>
              </div>
            )}

            {pasoAgendar === 4 && (
              <div>
                <button onClick={() => setPasoAgendar(tipoAgendamiento === 'prioritario' ? 3 : 2)} className="text-blue-600 text-sm mb-3">← Volver</button>
                <p className="font-bold mb-3">Resumen del Agendamiento:</p>
                <div className="bg-gray-100 p-4 rounded mb-4">
                  <p><strong>Servicio:</strong> {servicioSeleccionado?.nombre}</p>
                  <p><strong>Profesional:</strong> Asignación automática por disponibilidad</p>
                  <p><strong>Bloque:</strong> {bloqueSeleccionado ? `${new Date(bloqueSeleccionado.fecha_hora_inicio).toLocaleString()}` : 'Ninguno (Anotado directo en Lista Prioritaria)'}</p>
                  {tipoAgendamiento === 'prioritario' && <p className="mt-2 text-yellow-600 text-sm font-bold">✓ Disponibilidad adicional adjunta</p>}
                </div>

                <FormularioMotivo
                  esEntrevista={esEntrevistaAdmin}
                  respuestas={encuestaAdmin}
                  setRespuestas={setEncuestaAdmin}
                  motivo={motivoConsultaAdmin}
                  setMotivo={setMotivoConsultaAdmin}
                />

                <button onClick={confirmarAgendamientoAdmin} className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-3 rounded text-lg">
                  Confirmar Agendamiento
                </button>
              </div>
            )}
            
            <button onClick={() => setModalAgendar(false)} className="mt-4 text-center w-full text-gray-500 hover:text-gray-800 font-bold">
              Cancelar y Cerrar
            </button>
          </div>
        </div>
      )}

      {modalCambiarSerie && procesoCambiar && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <h3 className="text-2xl font-bold text-purple-900 mb-2">Cambiar Horario del Ciclo</h3>
            <p className="text-gray-600 mb-1">Estudiante: <strong>{estudianteSeleccionado?.nombres} {estudianteSeleccionado?.apellidos}</strong></p>
            <p className="text-gray-600 mb-4 border-b pb-2">Servicio: <strong>{procesoCambiar.servicio_nombre}</strong> · Sesiones realizadas: {procesoCambiar.sesiones_realizadas}</p>

            {pasoCambioSerie === 1 && (
              <div>
                <p className="font-bold mb-3">Selecciona el nuevo bloque de inicio del ciclo:</p>
                <p className="text-sm text-gray-500 mb-4">Las sesiones futuras pendientes serán canceladas y reagendadas desde el bloque que elijas, manteniendo el mismo proceso clínico.</p>
                {campusDisponiblesCambio.length > 1 && (
                  <div className="mb-4 bg-white border border-gray-200 rounded-lg p-3">
                    <p className="text-xs font-semibold text-gray-700 mb-2">Campus disponibles:</p>
                    <div className="flex flex-wrap gap-2">
                      {campusDisponiblesCambio.map(c => {
                        const activo = campusSeleccionadosCambio.includes(c.id);
                        return (
                          <button
                            key={c.id}
                            onClick={() => setCampusSeleccionadosCambio(prev => activo ? prev.filter(x => x !== c.id) : [...prev, c.id])}
                            className={`px-3 py-1 rounded-full text-xs font-medium border transition ${activo ? 'bg-purple-600 text-white border-purple-700' : 'bg-white text-gray-600 border-gray-300 hover:bg-purple-50'}`}
                          >
                            {activo ? '✓ ' : ''}{c.nombre}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {bloquesParaCambio.length === 0 ? (
                  <div>
                    <p className="p-4 bg-yellow-50 text-yellow-800 rounded border border-yellow-200 mb-4">No hay bloques disponibles para este servicio.</p>
                    <button
                      onClick={() => setPasoCambioSerie(3)}
                      className="w-full bg-orange-100 hover:bg-orange-200 text-orange-800 border border-orange-300 font-bold py-2 px-4 rounded text-sm"
                    >
                      Poner en Lista de Espera Prioritaria
                    </button>
                  </div>
                ) : (
                  <div>
                    <div className="flex justify-between items-center mb-4 mt-2">
                      <div className="flex space-x-2">
                        <button onClick={() => { const d = new Date(fechaBaseCambioSerie); d.setDate(d.getDate() - 7); setFechaBaseCambioSerie(d); }} className="px-3 py-1 bg-gray-200 rounded hover:bg-gray-300 font-bold text-sm">&larr; Ant</button>
                        <span className="px-4 py-1 font-semibold border rounded bg-white text-sm">
                          Semana del {fechaBaseCambioSerie.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })}
                        </span>
                        <button onClick={() => { const d = new Date(fechaBaseCambioSerie); d.setDate(d.getDate() + 7); setFechaBaseCambioSerie(d); }} className="px-3 py-1 bg-gray-200 rounded hover:bg-gray-300 font-bold text-sm">Sig &rarr;</button>
                      </div>
                    </div>
                    <div className="overflow-x-auto pb-4">
                      <table className="w-full min-w-[800px] table-fixed border-collapse border-2 border-gray-300 text-sm bg-white">
                        <thead>
                          <tr>
                            <th className="w-20 p-2 border-2 border-gray-300 bg-gray-100 text-gray-700">Hora</th>
                            {diasSemana.map((dia, i) => {
                              const fh = new Date(fechaBaseCambioSerie);
                              fh.setDate(fechaBaseCambioSerie.getDate() + i);
                              return (
                                <th key={dia} className="p-2 border-2 border-gray-300 bg-gray-100 font-bold text-gray-700 capitalize">
                                  {dia} <br/> <span className="text-xs font-normal text-gray-500">{fh.toLocaleDateString('es-ES', {day: 'numeric', month: 'short'})}</span>
                                </th>
                              );
                            })}
                          </tr>
                        </thead>
                        <tbody>
                          {horasOpciones.map(hora => {
                            const duracionMin = servicioCambiar?.duracion_minutos || 60;
                            const startMin = parseInt(hora.split(':')[0], 10) * 60;
                            const subSlots = [];
                            for (let m = startMin; m + duracionMin <= startMin + 60; m += duracionMin) {
                              const hh = String(Math.floor(m / 60)).padStart(2, '0');
                              const mm = String(m % 60).padStart(2, '0');
                              const endMin = m + duracionMin;
                              subSlots.push({ inicio: `${hh}:${mm}`, fin: `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}` });
                            }
                            return (
                              <tr key={hora}>
                                <td className="p-2 border-2 border-gray-300 text-center font-bold text-gray-500 bg-gray-50 align-top w-20 text-xs">
                                  {hora} - {String(parseInt(hora.split(':')[0]) + 1).padStart(2, '0')}:00
                                </td>
                                {diasSemana.map((_, i) => {
                                  const bloquesCelda = getBloquesEnGrillaCambio(i, hora);
                                  return (
                                    <td key={i} className="border-2 border-gray-300 p-1 align-top bg-white">
                                      <div className="flex flex-col gap-1">
                                        {mergeSlotsConBloques(subSlots, bloquesCelda, duracionMin).map(({ inicio, fin, bloques }) => {
                                          // Un bloque por campus disponible en este horario (getBlocksForCell ya deduplica por hora+campus).
                                          return bloques.length > 0 ? (
                                            bloques.map(bloque => (
                                              <button
                                                key={`${inicio}-${bloque.id_bloque}`}
                                                onClick={() => { setBloqueCambioSeleccionado(bloque); setPasoCambioSerie(2); }}
                                                className="min-h-[40px] flex flex-col justify-center items-center bg-purple-100 hover:bg-purple-200 border border-purple-400 text-purple-900 rounded text-[10px] text-center shadow-sm transition cursor-pointer"
                                              >
                                                <span className="font-bold">{inicio} - {fin}</span>
                                                <span className="font-semibold text-[9px]">📍 {bloque.ubicacion?.nombre || 'Sin ubicación'}</span>
                                              </button>
                                            ))
                                          ) : (
                                            <div key={inicio} className="min-h-[40px] flex flex-col justify-center items-center rounded text-[10px] border border-gray-200 bg-gray-50 text-gray-300">
                                              <span>{inicio} - {fin}</span>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    </td>
                                  );
                                })}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="mt-4 pt-4 border-t border-gray-200">
                      <button
                        onClick={() => setPasoCambioSerie(3)}
                        className="w-full bg-orange-100 hover:bg-orange-200 text-orange-800 border border-orange-300 font-bold py-2 px-4 rounded text-sm"
                      >
                        Sin horario disponible — Poner en Lista de Espera Prioritaria
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {pasoCambioSerie === 2 && bloqueCambioSeleccionado && (
              <div>
                <button onClick={() => setPasoCambioSerie(1)} className="text-purple-600 text-sm mb-3">← Volver a bloques</button>
                <p className="font-bold mb-3">Confirmar cambio de horario:</p>
                <div className="bg-purple-50 border border-purple-200 p-4 rounded mb-4 text-sm">
                  <p><strong>Servicio:</strong> {procesoCambiar.servicio_nombre}</p>
                  <p><strong>Nuevo primer bloque:</strong> {new Date(bloqueCambioSeleccionado.fecha_hora_inicio).toLocaleString('es-ES')}</p>
                  <p><strong>Campus:</strong> {bloqueCambioSeleccionado.ubicacion?.nombre || 'Sin ubicación'}</p>
                  <p className="mt-2 text-orange-700 font-semibold">Las sesiones futuras pendientes del ciclo actual serán canceladas y reagendadas en el nuevo horario.</p>
                </div>
                <button onClick={confirmarCambioSerie} className="w-full bg-purple-600 hover:bg-purple-700 text-white font-bold py-3 rounded text-lg">
                  Confirmar Cambio de Horario
                </button>
              </div>
            )}

            {pasoCambioSerie === 3 && (
              <div>
                <button onClick={() => setPasoCambioSerie(1)} className="text-orange-600 text-sm mb-3">← Volver a bloques</button>
                <p className="font-bold mb-1 text-orange-600">Lista de Espera Prioritaria</p>
                <p className="text-sm text-gray-600 mb-2">
                  Marca los horarios en los que el estudiante tiene disponibilidad. Quedará como caso <strong>prioritario</strong> en lista de espera; si se libera un bloque que calce con su disponibilidad, se le asignará automáticamente. El proceso clínico se mantiene activo.
                </p>
                <div className="bg-orange-50 border border-orange-200 p-3 rounded mb-4 text-xs text-orange-700">
                  Las sesiones futuras pendientes del ciclo actual serán <strong>canceladas</strong> al confirmar.
                </div>

                {campusDisponiblesCambio.length > 1 && (
                  <div className="mb-4 bg-white border border-gray-200 rounded-lg p-3">
                    <p className="text-xs font-semibold text-gray-700 mb-2">📍 Campus que le sirven al estudiante:</p>
                    <div className="flex flex-wrap gap-2">
                      {campusDisponiblesCambio.map(c => {
                        const activo = campusSeleccionadosCambio.includes(c.id);
                        return (
                          <button
                            key={c.id}
                            onClick={() => setCampusSeleccionadosCambio(prev => activo ? prev.filter(x => x !== c.id) : [...prev, c.id])}
                            className={`px-3 py-1 rounded-full text-xs font-medium border transition ${activo ? 'bg-orange-600 text-white border-orange-700' : 'bg-white text-gray-600 border-gray-300 hover:bg-orange-50'}`}
                          >
                            {activo ? '✓ ' : ''}{c.nombre}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="overflow-x-auto mb-6">
                  <table className="w-full min-w-[800px] table-fixed border-collapse border-2 border-gray-300 text-sm bg-white">
                    <thead>
                      <tr>
                        <th className="w-20 p-2 border-2 border-gray-300 bg-gray-100">Hora</th>
                        {diasSemana.map(dia => (
                          <th key={dia} className="p-2 border-2 border-gray-300 bg-gray-100 font-bold capitalize text-gray-700">{dia}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {horasOpciones.map(hora => {
                        const duracionMin = servicioCambiar?.duracion_minutos || 60;
                        const startMin = parseInt(hora.split(':')[0], 10) * 60;
                        const subSlots = [];
                        for (let m = startMin; m + duracionMin <= startMin + 60; m += duracionMin) {
                          const hh = String(Math.floor(m / 60)).padStart(2, '0');
                          const mm = String(m % 60).padStart(2, '0');
                          const endMin = m + duracionMin;
                          subSlots.push({ inicio: `${hh}:${mm}`, fin: `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}` });
                        }
                        return (
                        <tr key={hora}>
                          <td className="p-2 border-2 border-gray-300 text-center font-bold text-gray-500 bg-gray-50 text-xs">
                            {hora} - {String(parseInt(hora.split(':')[0]) + 1).padStart(2, '0')}:00
                          </td>
                          {diasSemana.map(dia => (
                            <td key={`${dia}-${hora}`} className="border-2 border-gray-300 p-1 align-top bg-white">
                              <div className="flex flex-col gap-1">
                                {subSlots.map(({ inicio, fin }) => {
                                  const seleccionado = disponibilidadCambioEspera[dia] && disponibilidadCambioEspera[dia].includes(inicio);
                                  return (
                                    <div key={inicio} onClick={() => toggleHoraDiaCambioEspera(dia, inicio)} className={`min-h-[40px] flex flex-col justify-center items-center rounded text-[10px] border cursor-pointer transition ${seleccionado ? 'bg-orange-500 hover:bg-orange-600 text-white border-orange-600 shadow-inner' : 'hover:bg-orange-50 text-gray-300 border-gray-200 hover:text-orange-500 hover:border-orange-300'}`}>
                                      <span className="font-bold">{inicio} - {fin}</span>
                                      {seleccionado && <span className="text-[9px]">✓</span>}
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

                <button onClick={confirmarListaEsperaSerie} className="w-full bg-orange-500 hover:bg-orange-600 text-white font-bold py-3 rounded text-lg">
                  Confirmar — Poner en Lista de Espera Prioritaria
                </button>
              </div>
            )}

            <button onClick={() => setModalCambiarSerie(false)} className="mt-4 text-center w-full text-gray-500 hover:text-gray-800 font-bold">
              Cancelar y Cerrar
            </button>
          </div>
        </div>
      )}

    </div>
  )
}

export default DashboardAdministrativo
