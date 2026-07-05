import { useState, useEffect, useMemo } from 'react';
import { API_URL } from './config';
import { supabase } from './supabaseClient';
import FormularioMotivo, { buildMotivoFinal } from './FormularioMotivo';
import HistorialEstudiante from './HistorialEstudiante';
import { getLunes, getBlocksForCell, deduplicateCyclicBlocks, getSlotsConDisponibilidad, mergeSlotsConBloques } from './utils/calendarUtils';

export default function DashboardCoordinador({ session }) {
  const [pestañaActiva, setPestañaActiva] = useState('registro');

  // ==========================================
  // ESTADOS PARA REGISTRO DE PERSONAL
  // ==========================================
  const [nuevoEmail, setNuevoEmail] = useState('');
  const [nuevoPassword, setNuevoPassword] = useState('');
  const [nuevoRol, setNuevoRol] = useState('profesional');
  const [nuevoNombres, setNuevoNombres] = useState('');
  const [nuevoApellidos, setNuevoApellidos] = useState('');
  const [serviciosAsignados, setServiciosAsignados] = useState([]);
  const [cargandoRegistro, setCargandoRegistro] = useState(false);

  const registrarUsuario = async (e) => {
    e.preventDefault();
    setCargandoRegistro(true);
    try {
      const respuesta = await fetch(`${API_URL}/coordinador/crear_usuario`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`
        },
        body: JSON.stringify({
          email: nuevoEmail,
          password: nuevoPassword,
          rol: nuevoRol,
          nombres: (nuevoRol === 'profesional' || nuevoRol === 'profesional_apoyo') ? nuevoNombres : null,
          apellidos: (nuevoRol === 'profesional' || nuevoRol === 'profesional_apoyo') ? nuevoApellidos : null,
          servicios: nuevoRol === 'profesional' ? serviciosAsignados : null
        })
      });

      if (respuesta.ok) {
        alert(`Usuario ${nuevoRol} creado exitosamente.`);
        setNuevoEmail(''); setNuevoPassword(''); setNuevoNombres(''); setNuevoApellidos(''); setServiciosAsignados([]);
        cargarDatosAgenda(); // Refrescar lista por si agregó un profesional
      } else {
        const data = await respuesta.json();
        alert("Error al crear usuario: " + data.detail);
      }
    } catch (error) {
      console.error(error);
      alert("Error de conexión al registrar.");
    } finally {
      setCargandoRegistro(false);
    }
  };

  // Edición/Eliminación de Profesionales
  const [modalEditProf, setModalEditProf] = useState(null);
  
  const eliminarProfesional = async (idUsuario) => {
    if (!window.confirm("¿Seguro que deseas eliminar este profesional? Sus horarios disponibles serán borrados.")) return;
    try {
      const res = await fetch(`${API_URL}/coordinador/profesionales/${idUsuario}`, {
        method: "DELETE", headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (res.ok) { alert("Profesional eliminado"); cargarDatosAgenda(); }
      else { const data = await res.json(); alert("Error: " + data.detail); }
    } catch (e) { console.error(e); }
  };

  const guardarServiciosProfesional = async () => {
    try {
      const res = await fetch(`${API_URL}/coordinador/profesionales/${modalEditProf.id_profesional}/servicios`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
        body: JSON.stringify({ servicios: modalEditProf.servicios })
      });
      if (res.ok) {
        alert("Especialidades actualizadas");
        setModalEditProf(null);
        cargarDatosAgenda();
      } else { const data = await res.json(); alert("Error: " + data.detail); }
    } catch (e) { console.error(e); }
  };

  // ==========================================
  // ESTADOS PARA CREACIÓN DE SERVICIOS
  // ==========================================
  const [servicioEditando, setServicioEditando] = useState(null);
  const [nuevoServicioNombre, setNuevoServicioNombre] = useState('');
  const [nuevoServicioCiclico, setNuevoServicioCiclico] = useState(false);
  const [nuevoServicioDuracion, setNuevoServicioDuracion] = useState(60);
  const [nuevoServicioTope, setNuevoServicioTope] = useState('');
  const [nuevoServicioAcronimo, setNuevoServicioAcronimo] = useState('');

  const prepararEdicionServicio = (s) => {
    setServicioEditando(s.id_servicio);
    setNuevoServicioNombre(s.nombre);
    setNuevoServicioCiclico(s.es_ciclico);
    setNuevoServicioDuracion(s.duracion_minutos);
    setNuevoServicioTope(s.tope_sesiones || '');
    setNuevoServicioAcronimo(s.acronimo || '');
  };

  const eliminarServicio = async (id) => {
    if (!window.confirm("¿Seguro que deseas eliminar este servicio?")) return;
    try {
      const res = await fetch(`${API_URL}/coordinador/servicios/${id}`, {
        method: "DELETE", headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (res.ok) { alert("Servicio eliminado"); cargarServicios(); }
      else { const data = await res.json(); alert("Error: " + data.detail); }
    } catch (e) { console.error(e); }
  };

  // ==========================================
  // ESTADOS PARA GESTIÓN DE UBICACIONES (CAMPUS)
  // ==========================================
  const [ubicaciones, setUbicaciones] = useState([]);
  const [ubicacionEditando, setUbicacionEditando] = useState(null);
  const [nuevaUbicacionNombre, setNuevaUbicacionNombre] = useState('');
  const [nuevaUbicacionAbreviatura, setNuevaUbicacionAbreviatura] = useState('');
  const [nuevaUbicacionDireccion, setNuevaUbicacionDireccion] = useState(''); // dirección física: solo se usa en el correo de confirmación
  const [ubicacionPorDia, setUbicacionPorDia] = useState({}); // { 0: id_ubicacion, 1: ... } en pestaña agenda
  const [crearUbicacionId, setCrearUbicacionId] = useState(''); // ubicación elegida en el modal de crear bloque

  const cargarUbicaciones = async () => {
    try {
      const res = await fetch(`${API_URL}/ubicaciones`);
      if (res.ok) setUbicaciones(await res.json());
    } catch (e) { console.error(e); }
  };

  const guardarUbicacion = async (e) => {
    e.preventDefault();
    if (!nuevaUbicacionNombre.trim()) return;
    if (!nuevaUbicacionDireccion.trim()) { alert("Debes indicar la dirección del campus."); return; }
    try {
      const url = ubicacionEditando
        ? `${API_URL}/coordinador/ubicaciones/${ubicacionEditando}`
        : `${API_URL}/coordinador/ubicaciones`;
      const method = ubicacionEditando ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
        body: JSON.stringify({
          nombre: nuevaUbicacionNombre.trim(),
          abreviatura: nuevaUbicacionAbreviatura ? nuevaUbicacionAbreviatura.trim() : null,
          direccion: nuevaUbicacionDireccion.trim()
        })
      });
      if (res.ok) {
        setUbicacionEditando(null); setNuevaUbicacionNombre(''); setNuevaUbicacionAbreviatura(''); setNuevaUbicacionDireccion('');
        cargarUbicaciones();
      } else { const data = await res.json(); alert("Error: " + data.detail); }
    } catch (e) { console.error(e); alert("Error de conexión"); }
  };

  const prepararEdicionUbicacion = (u) => {
    setUbicacionEditando(u.id_ubicacion);
    setNuevaUbicacionNombre(u.nombre);
    setNuevaUbicacionAbreviatura(u.abreviatura || '');
    setNuevaUbicacionDireccion(u.direccion || '');
  };

  const eliminarUbicacion = async (id) => {
    if (!window.confirm("¿Eliminar esta ubicación? Si tiene bloques asociados se desactivará en vez de borrarse.")) return;
    try {
      const res = await fetch(`${API_URL}/coordinador/ubicaciones/${id}`, {
        method: "DELETE", headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (res.ok) { const data = await res.json(); alert(data.mensaje); cargarUbicaciones(); }
      else { const data = await res.json(); alert("Error: " + data.detail); }
    } catch (e) { console.error(e); }
  };

  const toggleActivoUbicacion = async (u) => {
    try {
      const res = await fetch(`${API_URL}/coordinador/ubicaciones/${u.id_ubicacion}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
        body: JSON.stringify({ activo: !u.activo })
      });
      if (res.ok) cargarUbicaciones();
    } catch (e) { console.error(e); }
  };

  // ==========================================
  // ESTADOS PARA GESTIÓN DE AGENDAS (GRILLA)
  // ==========================================
  const [profesionales, setProfesionales] = useState([]);
  const [administrativos, setAdministrativos] = useState([]);
  const [servicios, setServicios] = useState([]);
  const [profesionalSeleccionado, setProfesionalSeleccionado] = useState('');
  const [servicioSeleccionado, setServicioSeleccionado] = useState('');

  const [bloquesPublicados, setBloquesPublicados] = useState([]);

  // getLunes importado de utils/calendarUtils
  const [fechaBaseGestion, setFechaBaseGestion] = useState(getLunes(new Date()));

  // Calendario unificado: modal para crear un bloque al hacer clic en un espacio vacío
  const [modalCrear, setModalCrear] = useState(null); // { diaIndex, hora, fechaStr }
  const [crearServicioId, setCrearServicioId] = useState('');
  const [crearHoraInicio, setCrearHoraInicio] = useState('');
  const [creandoBloque, setCreandoBloque] = useState(false);

  const cambiarSemanaGestion = (dias) => {
    const nueva = new Date(fechaBaseGestion);
    nueva.setDate(nueva.getDate() + dias);
    setFechaBaseGestion(nueva);
  };

  const getBloquesPublicadosEnGrilla = (diaIndex, hora) => {
    const fechaDia = new Date(fechaBaseGestion);
    fechaDia.setDate(fechaBaseGestion.getDate() + diaIndex);
    
    const anio = fechaDia.getFullYear();
    const mes = String(fechaDia.getMonth() + 1).padStart(2, '0');
    const dia = String(fechaDia.getDate()).padStart(2, '0');
    const fechaStr = `${anio}-${mes}-${dia}`;
    
    const prefijoHora = hora.split(':')[0];
    
    return bloquesPublicados.filter(b => {
      if (!b.fecha_hora_inicio) return false;
      if (b.estado === 'cancelado') return false;
      const [bFechaStr, bHoraStr] = b.fecha_hora_inicio.replace(' ', 'T').split('T');
      const bHora = bHoraStr.split(':')[0];
      return bFechaStr === fechaStr && bHora === prefijoHora;
    }).sort((a, b) => a.fecha_hora_inicio.localeCompare(b.fecha_hora_inicio));
  };

  const getColorEstado = (estado) => {
    if (estado === 'disponible') return 'bg-green-100 border-green-500 text-green-900 border-solid shadow-sm';
    if (estado === 'reservado') return 'bg-yellow-100 border-yellow-500 text-yellow-900 border-solid shadow-md';
    if (estado === 'bloqueado') return 'bg-orange-50 border-orange-400 text-orange-800 border-dashed';
    return 'bg-gray-100 border-gray-400 text-gray-800 border-solid';
  };

  const [modalEliminar, setModalEliminar] = useState(false);
  const [bloqueAEliminar, setBloqueAEliminar] = useState(null);
  const [campusEditar, setCampusEditar] = useState(''); // campus elegido en el modal de detalle para cambiar la ubicación del bloque

  const diasSemana = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'];
  
  // ==========================================
  // ESTADOS PARA BUSCADOR Y AGENDAMIENTO
  // ==========================================
  const [estudiantesGlobal, setEstudiantesGlobal] = useState([]);
  const [busqueda, setBusqueda] = useState('');
  const [estudianteSeleccionado, setEstudianteSeleccionado] = useState(null);
  const [procesoExpandido, setProcesoExpandido] = useState(null);
  const [reservasEstudiante, setReservasEstudiante] = useState([]);
  const [cargandoEstudiantes, setCargandoEstudiantes] = useState(false);

  const [modalAgendar, setModalAgendar] = useState(false);
  const [tipoAgendamiento, setTipoAgendamiento] = useState('normal');
  const [pasoAgendar, setPasoAgendar] = useState(1);
  const [bloquesDisponibles, setBloquesDisponibles] = useState([]);
  const [bloqueSeleccionado, setBloqueSeleccionado] = useState(null);
  const [disponibilidadPrioritaria, setDisponibilidadPrioritaria] = useState({});
  const [motivoConsultaAdmin, setMotivoConsultaAdmin] = useState('');
  const [encuestaAdmin, setEncuestaAdmin] = useState({ q1: "0", q2: "0", q3: "0" });
  const esEntrevistaAdmin = servicios.find(s => s.id_servicio === servicioSeleccionado)?.nombre?.toLowerCase().includes('entrevista de ingreso') || false;

  // ==========================================
  // ESTADOS PARA CALENDARIO DE RESERVAS
  // ==========================================
  const [calendarioReservas, setCalendarioReservas] = useState([]);
  const [cargandoCalendario, setCargandoCalendario] = useState(false);
  const [celdaSeleccionadaReservas, setCeldaSeleccionadaReservas] = useState(null);
  const [servicioFiltroCalendario, setServicioFiltroCalendario] = useState('');
  const [fechaBaseSemanaCalendario, setFechaBaseSemanaCalendario] = useState(getLunes(new Date()));

  // ==========================================
  // ESTADOS PARA CASOS CRÍTICOS PENDIENTES
  // ==========================================
  const [casosPendientes, setCasosPendientes] = useState([]);
  const [cargandoPendientes, setCargandoPendientes] = useState(false);

  // ==========================================
  // ESTADOS PARA CALENDARIO DE DEMANDA (LISTA DE ESPERA)
  // ==========================================
  const [demanda, setDemanda] = useState([]);
  const [cargandoDemanda, setCargandoDemanda] = useState(false);
  const [servicioFiltroDemanda, setServicioFiltroDemanda] = useState('');
  const [ubicacionFiltro, setUbicacionFiltro] = useState('');
  const [celdaSeleccionada, setCeldaSeleccionada] = useState(null);
  // Sub-vista de la pestaña "Demanda / Reservas": 'demanda' | 'disponibilidad' | 'reservas'
  const [subVistaDemanda, setSubVistaDemanda] = useState('demanda');

  // ==========================================
  // ESTADOS PARA CALENDARIO DE DISPONIBILIDAD (OFERTA POR SERVICIO)
  // ==========================================
  const [servicioFiltroDisp, setServicioFiltroDisp] = useState('');
  const [bloquesDisp, setBloquesDisp] = useState([]);
  const [cargandoDisp, setCargandoDisp] = useState(false);
  const [celdaSeleccionadaDisp, setCeldaSeleccionadaDisp] = useState(null);
  const [fechaBaseSemanaDisp, setFechaBaseSemanaDisp] = useState(getLunes(new Date()));

  const subTabDemandaClass = (v) => `px-4 py-1.5 rounded-full text-sm font-semibold transition ${subVistaDemanda === v ? 'bg-blue-600 text-white shadow' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`;

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

  const diasSemanaAgendamiento = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'];
  const horasOpcionesAgendamiento = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];

  const [fechaBaseSemanaAgendamiento, setFechaBaseSemanaAgendamiento] = useState(getLunes(new Date()));

  const cambiarSemanaAgendamiento = (dias) => {
    const nueva = new Date(fechaBaseSemanaAgendamiento);
    nueva.setDate(nueva.getDate() + dias);
    setFechaBaseSemanaAgendamiento(nueva);
  };

  const cambiarSemanaCalendario = (dias) => {
    const nueva = new Date(fechaBaseSemanaCalendario);
    nueva.setDate(nueva.getDate() + dias);
    setFechaBaseSemanaCalendario(nueva);
  };

  const bloquesAdminFiltrados = useMemo(() =>
    deduplicateCyclicBlocks(bloquesDisponibles, servicios.find(s => s.id_servicio === servicioSeleccionado)?.es_ciclico)
  , [bloquesDisponibles, servicioSeleccionado, servicios]);

  const getBloquesDisponiblesEnGrillaAdmin = (diaIndex, hora) =>
    getBlocksForCell(bloquesAdminFiltrados, fechaBaseSemanaAgendamiento, diaIndex, hora);

  // Slots (día+hora) con hora disponible: se deshabilitan en la grilla de
  // disponibilidad prioritaria (hay que agendarlos directo, no a la espera).
  const slotsConDisponibilidadAdmin = useMemo(
    () => getSlotsConDisponibilidad(bloquesAdminFiltrados),
    [bloquesAdminFiltrados]
  );

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
        seleccionarEstudiante(estudianteSeleccionado);
      } else {
        alert("Error al cancelar la reserva.");
      }
    } catch (e) { console.error(e); }
  };

  const marcarInasistenciaAdmin = async (id_reserva) => {
    if (!window.confirm("¿Estás segura de marcar a este estudiante como AUSENTE? Esto aumentará su contador de inasistencias.")) return;
    try {
      const respuesta = await fetch(`${API_URL}/asistencia`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
        body: JSON.stringify({ id_reserva, estado: 'ausente' })
      });
      if (respuesta.ok) {
        alert("Inasistencia registrada exitosamente.");
        seleccionarEstudiante(estudianteSeleccionado);
      } else {
        const errorData = await respuesta.json();
        alert("Error al registrar inasistencia: " + (errorData.detail || "Error interno"));
      }
    } catch (e) { console.error(e); }
  };

  const iniciarAgendamiento = async (tipo) => {
    setTipoAgendamiento(tipo);
    setModalAgendar(true);
    setPasoAgendar(1);
    setServicioSeleccionado('');
    setBloqueSeleccionado(null);
    setDisponibilidadPrioritaria({});
    setMotivoConsultaAdmin('');
    setEncuestaAdmin({ q1: "0", q2: "0", q3: "0" });
    await cargarServicios();
  };

  const avanzarAServicio = async (servicio) => {
    setServicioSeleccionado(servicio.id_servicio);
    setPasoAgendar(2);
    setFechaBaseSemanaAgendamiento(getLunes(new Date()));
    try {
      const respuesta = await fetch(`${API_URL}/disponibilidad?id_servicio=${servicio.id_servicio}`, {
        headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (respuesta.ok) setBloquesDisponibles(await respuesta.json());
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
          id_servicio: servicioSeleccionado,
          id_bloque: bloqueSeleccionado ? bloqueSeleccionado.id_bloque : null,
          tipo_agendamiento: tipoAgendamiento,
          disponibilidad_indicada: tipoAgendamiento === 'prioritario' ? disponibilidadPrioritaria : null,
          motivo_consulta: motivoFinalAdmin
        })
      });
      if (respuesta.ok) {
        alert("Hora agendada exitosamente al estudiante.");
        setModalAgendar(false);
        seleccionarEstudiante(estudianteSeleccionado);
      } else {
        const err = await respuesta.json();
        alert("Error al agendar: " + err.detail);
      }
    } catch (e) { console.error(e); }
  };

  const cargarDatosAgenda = async () => {
    try {
      const [resProf, resAdmin] = await Promise.all([
        fetch(`${API_URL}/coordinador/profesionales`, { headers: { "Authorization": `Bearer ${session.access_token}` } }),
        fetch(`${API_URL}/coordinador/administrativos`, { headers: { "Authorization": `Bearer ${session.access_token}` } }),
      ]);
      if (resProf.ok) setProfesionales(await resProf.json());
      if (resAdmin.ok) setAdministrativos(await resAdmin.json());
    } catch (e) {
      console.error("Error cargando datos de agenda", e);
    }
  };

  const cargarServicios = async () => {
    try {
      const resServ = await fetch(`${API_URL}/servicios`);
      if (resServ.ok) setServicios(await resServ.json());
    } catch (e) { console.error(e); }
  };

  const cargarCalendarioReservas = async () => {
    setCargandoCalendario(true);
    try {
      const respuesta = await fetch(`${API_URL}/admin/calendario_reservas`, {
        headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (respuesta.ok) setCalendarioReservas(await respuesta.json());
    } catch (e) { console.error(e); } finally { setCargandoCalendario(false); }
  };

  const cargarCasosPendientes = async () => {
    setCargandoPendientes(true);
    try {
      const respuesta = await fetch(`${API_URL}/coordinador/casos_criticos_pendientes`, {
        headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (respuesta.ok) setCasosPendientes(await respuesta.json());
    } catch (e) { console.error(e); } finally { setCargandoPendientes(false); }
  };

  const cargarDemanda = async () => {
    setCargandoDemanda(true);
    try {
      const respuesta = await fetch(`${API_URL}/admin/demanda_espera`, {
        headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (respuesta.ok) setDemanda(await respuesta.json());

      if (servicios.length === 0) {
        const resServ = await fetch(`${API_URL}/servicios`, { headers: { "Authorization": `Bearer ${session.access_token}` } });
        if (resServ.ok) setServicios(await resServ.json());
      }
    } catch (e) { console.error(e); } finally { setCargandoDemanda(false); }
  };

  const aprobarCasosCriticos = async (idEstudiante) => {
    if (!window.confirm("¿Confirmar aprobación de este ESTUDIANTE como caso crítico? Saldrá del sistema.")) return;
    try {
      const respuesta = await fetch(`${API_URL}/coordinador/aprobar_critico/${idEstudiante}`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (respuesta.ok) {
        alert("✓ Estudiante confirmado como crítico. Ha salido del sistema.");
        cargarCasosPendientes();
      } else {
        const errorData = await respuesta.json();
        alert("Error: " + (errorData.detail || "Error interno"));
      }
    } catch (error) {
      console.error(error);
    }
  };

  const rechazarCasoCritico = async (idEstudiante) => {
    if (!window.confirm("¿Rechazar marca de crítico? Estudiante continúa en el sistema.")) return;
    try {
      const respuesta = await fetch(`${API_URL}/coordinador/rechazar_critico/${idEstudiante}`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (respuesta.ok) {
        alert("✓ Rechazado. Estudiante continúa activo.");
        cargarCasosPendientes();
      } else {
        const errorData = await respuesta.json();
        alert("Error: " + (errorData.detail || "Error interno"));
      }
    } catch (error) {
      console.error(error);
    }
  };

  useEffect(() => {
    cargarServicios(); // Se cargan siempre porque se usan en el registro y agenda
    cargarDatosAgenda(); // Trae el personal actual para todas las pestañas donde se muestra
    cargarUbicaciones(); // Catálogo de campus para la pestaña de ubicaciones y la publicación
    if (pestañaActiva === 'buscador') cargarEstudiantes();
    if (pestañaActiva === 'casos_pendientes') cargarCasosPendientes();
    if (pestañaActiva === 'demanda') { cargarDemanda(); cargarCalendarioReservas(); }
  }, [pestañaActiva]);

  useEffect(() => {
    if (profesionalSeleccionado) {
      cargarBloquesPublicados();
    }
  }, [profesionalSeleccionado]);

  const cargarBloquesPublicados = async () => {
    try {
      const res = await fetch(`${API_URL}/coordinador/profesionales/${profesionalSeleccionado}/bloques`, {
        headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setBloquesPublicados(Array.isArray(data) ? data : (data?.data || []));
      }
    } catch (e) { console.error(e); }
  };

  const iniciarEliminacion = (bloque) => {
    setBloqueAEliminar(bloque);
    setCampusEditar(bloque?.ubicacion?.id_ubicacion || '');
    setModalEliminar(true);
  };

  const ejecutarCambioCampus = async (serie) => {
    try {
      const res = await fetch(`${API_URL}/bloques/${bloqueAEliminar.id_bloque}?actualizar_serie=${serie}`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ id_ubicacion: campusEditar || "" })
      });
      const data = await res.json();
      if (res.ok) {
        cargarBloquesPublicados();
        setModalEliminar(false);
        setBloqueAEliminar(null);
      } else {
        alert(data.detail || "No se pudo cambiar el campus.");
      }
    } catch (e) { console.error(e); }
  };

  const ejecutarEliminacion = async (serie) => {
    try {
      const res = await fetch(`${API_URL}/bloques/${bloqueAEliminar.id_bloque}?eliminar_serie=${serie}`, {
        method: "DELETE", headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (res.ok) {
          cargarBloquesPublicados();
          setModalEliminar(false);
          setBloqueAEliminar(null);
      }
      else { const data = await res.json(); alert(data.detail); }
    } catch (e) { console.error(e); }
  };

  // ===== Calendario unificado: crear bloque al hacer clic en un espacio vacío =====

  // Estudiante de una reserva activa (no cancelada) asociada al bloque, si existe.
  const getEstudianteDeBloque = (bloque) => {
    const reservas = Array.isArray(bloque?.reserva) ? bloque.reserva : (bloque?.reserva ? [bloque.reserva] : []);
    const activa = reservas.find(r => r?.estado && !r.estado.startsWith('cancelado'));
    return activa?.proceso_clinico?.estudiante || null;
  };

  // Reserva activa (no cancelada) del bloque, si existe.
  const getReservaActiva = (bloque) => {
    const reservas = Array.isArray(bloque?.reserva) ? bloque.reserva : (bloque?.reserva ? [bloque.reserva] : []);
    return reservas.find(r => r?.estado && !r.estado.startsWith('cancelado')) || null;
  };

  // Para una sesión PASADA, deriva el estado clínico (Presente / Ausente / Falta rellenar
  // ficha / Sin reserva). Devuelve null si el bloque es futuro (se usa el render normal).
  const getEstadoSesion = (bloque) => {
    if (!bloque?.fecha_hora_inicio) return null;
    const esPasada = new Date(bloque.fecha_hora_inicio.replace(' ', 'T')) < new Date();
    if (!esPasada) return null;

    const reserva = getReservaActiva(bloque);
    if (!reserva) {
      return { clave: 'sin_reserva', etiqueta: 'Sin reserva', colorClass: 'bg-gray-100 border-gray-400 text-gray-600 border-solid' };
    }
    const estado = reserva.estado;
    if (estado === 'ausente' || estado === 'atraso') {
      return { clave: 'ausente', etiqueta: 'Ausente', colorClass: 'bg-red-100 border-red-500 text-red-900 border-solid shadow-sm' };
    }
    const evo = Array.isArray(reserva.evolucion_clinica) ? reserva.evolucion_clinica[0] : reserva.evolucion_clinica;
    const tieneFicha = !!(evo && evo.id_evolucion);
    if (estado === 'presente' && tieneFicha) {
      return { clave: 'presente', etiqueta: 'Presente', colorClass: 'bg-blue-100 border-blue-500 text-blue-900 border-solid shadow-sm' };
    }
    // pendiente / confirmado / reservado pasados, o presente sin ficha (defensivo).
    return { clave: 'falta_ficha', etiqueta: 'Falta rellenar ficha', colorClass: 'bg-amber-100 border-amber-500 text-amber-900 border-solid shadow-sm' };
  };

  // Abre el modal de creación para una celda (día + hora) del calendario.
  const abrirCrearBloque = (diaIndex, hora) => {
    const fechaDia = new Date(fechaBaseGestion);
    fechaDia.setDate(fechaBaseGestion.getDate() + diaIndex);
    const fechaStr = `${fechaDia.getFullYear()}-${String(fechaDia.getMonth() + 1).padStart(2, '0')}-${String(fechaDia.getDate()).padStart(2, '0')}`;
    setCrearServicioId(serviciosFiltrados.length === 1 ? serviciosFiltrados[0].id_servicio : '');
    setCrearHoraInicio(hora); // prellena con la hora en punto de la celda; el coordinador puede afinar el minuto
    setCrearUbicacionId(ubicacionPorDia[diaIndex] || ''); // hereda la ubicación del día (editable)
    setModalCrear({ diaIndex, hora, fechaStr });
  };

  // Valida la hora libre elegida (estilo Google Calendar): calcula la hora de término
  // según la duración fija del servicio y detecta si ya pasó, si queda fuera del horario
  // de atención (08:00–17:59) o si se solapa con otro bloque del profesional ese día.
  // El backend hace la validación autoritativa; esto es solo feedback inmediato.
  const getValidacionCrear = () => {
    if (!modalCrear || !crearServicioId || !crearHoraInicio || !/^\d{2}:\d{2}$/.test(crearHoraInicio)) return null;
    const duracion = servicios.find(s => s.id_servicio === crearServicioId)?.duracion_minutos || 60;
    const iniDate = new Date(`${modalCrear.fechaStr}T${crearHoraInicio}:00`);
    if (isNaN(iniDate.getTime())) return null;
    const finDate = new Date(iniDate.getTime() + duracion * 60000);
    const fin = `${String(finDate.getHours()).padStart(2, '0')}:${String(finDate.getMinutes()).padStart(2, '0')}`;
    const esPasada = iniDate <= new Date();
    const [hIni] = crearHoraInicio.split(':').map(Number);
    const fueraDeRango = hIni < 8 || hIni > 17;
    // Solape con otro bloque del profesional ese mismo día (la serie se repite igual cada semana).
    const haySolape = bloquesPublicados.some(b => {
      if (!b.fecha_hora_inicio || b.estado === 'cancelado') return false;
      const bIni = new Date(b.fecha_hora_inicio.replace(' ', 'T'));
      const bFin = b.fecha_hora_fin ? new Date(b.fecha_hora_fin.replace(' ', 'T')) : new Date(bIni.getTime() + 3600000);
      return iniDate < bFin && finDate > bIni;
    });
    return { duracion, fin, esPasada, fueraDeRango, haySolape };
  };

  const crearBloqueEnCelda = async () => {
    if (!crearServicioId || !crearHoraInicio || !modalCrear || !profesionalSeleccionado) return;
    if (!crearUbicacionId) { alert("Debes seleccionar un campus para publicar la hora."); return; }
    setCreandoBloque(true);
    try {
      const res = await fetch(`${API_URL}/bloques`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
        body: JSON.stringify({
          id_profesional: profesionalSeleccionado,
          id_servicio: crearServicioId,
          es_ciclico: false,
          fechas_inicio: [`${modalCrear.fechaStr}T${crearHoraInicio}:00`],
          id_ubicacion: crearUbicacionId
        })
      });
      const data = await res.json();
      if (res.ok) {
        alert(data.mensaje || "Disponibilidad publicada.");
        setModalCrear(null);
        cargarBloquesPublicados();
      } else {
        alert("Error al crear bloques: " + (data.detail || "Desconocido"));
      }
    } catch (error) {
      console.error(error);
      alert("Error de conexión");
    } finally {
      setCreandoBloque(false);
    }
  };

  const guardarServicio = async (e) => {
    e.preventDefault();
    try {
      const url = servicioEditando 
        ? `${API_URL}/coordinador/servicios/${servicioEditando}`
        : `${API_URL}/coordinador/servicios`;
      const method = servicioEditando ? "PUT" : "POST";
      
      const res = await fetch(url, {
        method: method,
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
        body: JSON.stringify({
          nombre: nuevoServicioNombre,
          es_ciclico: nuevoServicioCiclico,
          duracion_minutos: nuevoServicioDuracion,
          tope_sesiones: nuevoServicioTope ? parseInt(nuevoServicioTope) : null,
          acronimo: nuevoServicioAcronimo ? nuevoServicioAcronimo.toUpperCase().slice(0, 3) : null
        })
      });
      if (res.ok) {
        alert(servicioEditando ? "Servicio actualizado." : "Servicio agregado correctamente.");
        setServicioEditando(null); setNuevoServicioNombre(''); setNuevoServicioCiclico(false); setNuevoServicioDuracion(60); setNuevoServicioTope(''); setNuevoServicioAcronimo('');
        cargarServicios();
      } else {
        const data = await res.json(); alert("Error: " + data.detail);
      }
    } catch (e) { console.error(e); alert("Error de conexión"); }
  };

  // Filtrar servicios en la agenda
  const profData = profesionales.find(p => p.id_profesional === profesionalSeleccionado);
  const profServiciosAsignados = profData ? profData.profesional_servicio.map(ps => ps.id_servicio) : [];
  const serviciosFiltrados = servicios.filter(s => profServiciosAsignados.includes(s.id_servicio));

  return (
    <div className="min-h-screen bg-gray-50 text-gray-800">
      <header className="text-white p-4 shadow-md flex justify-between items-center" style={{ backgroundColor: '#003366' }}>
        <h1 className="text-xl font-bold">Portal Coordinador - UBE</h1>
        <div>
          <span className="mr-4 text-sm">{session?.user?.email}</span>
          <button onClick={() => supabase.auth.signOut()} className="bg-red-600 hover:bg-red-700 px-3 py-1 rounded text-sm font-semibold transition">
            Cerrar Sesión
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6">
        <div className="flex space-x-2 border-b-2 border-gray-200 mb-6 pb-2">
          <button onClick={() => setPestañaActiva('registro')} className={`px-4 py-2 rounded-t-lg font-medium ${pestañaActiva === 'registro' ? 'bg-blue-100 text-blue-800 border-b-4 border-blue-600' : 'text-gray-500 hover:bg-gray-100'}`}>
            Registrar Personal
          </button>
          <button onClick={() => setPestañaActiva('servicios')} className={`px-4 py-2 rounded-t-lg font-medium ${pestañaActiva === 'servicios' ? 'bg-blue-100 text-blue-800 border-b-4 border-blue-600' : 'text-gray-500 hover:bg-gray-100'}`}>
            Gestionar Servicios
          </button>
          <button onClick={() => setPestañaActiva('ubicaciones')} className={`px-4 py-2 rounded-t-lg font-medium ${pestañaActiva === 'ubicaciones' ? 'bg-blue-100 text-blue-800 border-b-4 border-blue-600' : 'text-gray-500 hover:bg-gray-100'}`}>
            Gestionar Ubicaciones
          </button>
          <button onClick={() => setPestañaActiva('agenda')} className={`px-4 py-2 rounded-t-lg font-medium ${pestañaActiva === 'agenda' ? 'bg-blue-100 text-blue-800 border-b-4 border-blue-600' : 'text-gray-500 hover:bg-gray-100'}`}>
            Publicar Disponibilidad
          </button>
          <button onClick={() => setPestañaActiva('buscador')} className={`px-4 py-2 rounded-t-lg font-medium ${pestañaActiva === 'buscador' ? 'bg-blue-100 text-blue-800 border-b-4 border-blue-600' : 'text-gray-500 hover:bg-gray-100'}`}>
            Buscador Estudiantes
          </button>
          <button onClick={() => setPestañaActiva('demanda')} className={`px-4 py-2 rounded-t-lg font-medium ${pestañaActiva === 'demanda' ? 'bg-blue-100 text-blue-800 border-b-4 border-blue-600' : 'text-gray-500 hover:bg-gray-100'}`}>
            Demanda / Reservas
          </button>
          <button onClick={() => setPestañaActiva('casos_pendientes')} className={`px-4 py-2 rounded-t-lg font-medium ${pestañaActiva === 'casos_pendientes' ? 'bg-amber-100 text-amber-800 border-b-4 border-amber-600' : 'text-gray-500 hover:bg-gray-100'}`}>
            Casos Pendientes
          </button>
        </div>

        <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
          
          {pestañaActiva === 'registro' && (
            <section className="max-w-md mx-auto">
              <h2 className="text-2xl font-bold mb-6 text-blue-900">Registrar Nuevo Usuario</h2>
              <form onSubmit={registrarUsuario} className="space-y-4">
                <div>
                  <label className="block text-gray-700 font-medium mb-1">Correo Electrónico</label>
                  <input type="email" value={nuevoEmail} onChange={(e)=>setNuevoEmail(e.target.value)} required className="w-full p-2 border rounded text-sm" />
                </div>
                <div>
                  <label className="block text-gray-700 font-medium mb-1">Contraseña Temporal</label>
                  <input type="text" value={nuevoPassword} onChange={(e)=>setNuevoPassword(e.target.value)} required minLength="6" className="w-full p-2 border rounded text-sm" />
                </div>
                <div>
                  <label className="block text-gray-700 font-medium mb-1">Rol en el Sistema</label>
                  <select value={nuevoRol} onChange={(e)=>setNuevoRol(e.target.value)} className="w-full p-2 border rounded text-sm">
                    <option value="profesional">Profesional (De especialidad)</option>
                    <option value="administrativo">Administrativo (Triage/Recepción)</option>
                    <option value="profesional_apoyo">Profesional de Apoyo (Reportes)</option>
                  </select>
                </div>

                {(nuevoRol === 'profesional' || nuevoRol === 'profesional_apoyo') && (
                  <>
                    <div className="flex gap-4">
                      <div className="w-1/2">
                        <label className="block text-gray-700 font-medium mb-1">Nombres</label>
                        <input type="text" value={nuevoNombres} onChange={(e)=>setNuevoNombres(e.target.value)} required className="w-full p-2 border rounded text-sm" />
                      </div>
                      <div className="w-1/2">
                        <label className="block text-gray-700 font-medium mb-1">Apellidos</label>
                        <input type="text" value={nuevoApellidos} onChange={(e)=>setNuevoApellidos(e.target.value)} required className="w-full p-2 border rounded text-sm" />
                      </div>
                    </div>
                  </>
                )}

                {nuevoRol === 'profesional' && (
                  <div className="mt-4">
                      <label className="block text-gray-700 font-medium mb-1">Servicios (Especialidades)</label>
                      <div className="grid grid-cols-2 gap-2 mt-2">
                        {servicios.map(s => (
                          <label key={s.id_servicio} className="flex items-center space-x-2">
                            <input type="checkbox" value={s.id_servicio} checked={serviciosAsignados.includes(s.id_servicio)} onChange={(e) => {
                              if (e.target.checked) setServiciosAsignados([...serviciosAsignados, s.id_servicio]);
                              else setServiciosAsignados(serviciosAsignados.filter(id => id !== s.id_servicio));
                            }} />
                            <span className="text-sm text-gray-700">{s.nombre}</span>
                          </label>
                        ))}
                      </div>
                  </div>
                )}

                <button type="submit" disabled={cargandoRegistro} className="w-full bg-blue-700 hover:bg-blue-800 text-white font-bold py-3 rounded mt-4">
                  {cargandoRegistro ? 'Registrando...' : 'Crear Cuenta'}
                </button>
              </form>

              {/* Listado de Personal Existente */}
              <div className="mt-10 border-t pt-6">
                <h3 className="text-lg font-bold text-blue-900 mb-4">Personal Actual</h3>
                <ul className="space-y-3">
                  {profesionales.filter(p => p.usuario?.rol !== 'profesional_apoyo').map(p => (
                    <li key={p.id_profesional} className="bg-gray-50 p-3 rounded border flex justify-between items-center">
                      <div>
                        <p className="font-bold">{p.nombres} {p.apellidos}</p>
                        <p className="text-xs text-gray-500">{p.profesional_servicio?.length || 0} Especialidad(es)</p>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => setModalEditProf({ ...p, servicios: p.profesional_servicio?.map(s => s.id_servicio) || [] })} className="text-blue-600 hover:underline text-sm">Editar</button>
                        <button onClick={() => eliminarProfesional(p.id_usuario)} className="text-red-600 hover:underline text-sm">Eliminar</button>
                      </div>
                    </li>
                  ))}
                </ul>

                {profesionales.some(p => p.usuario?.rol === 'profesional_apoyo') && (
                  <>
                    <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mt-6 mb-2">Profesionales de Apoyo</h4>
                    <ul className="space-y-3">
                      {profesionales.filter(p => p.usuario?.rol === 'profesional_apoyo').map(p => (
                        <li key={p.id_profesional} className="bg-gray-50 p-3 rounded border flex justify-between items-center">
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="font-bold text-gray-700">{p.nombres} {p.apellidos}</p>
                              <span className="text-xs bg-purple-100 text-purple-700 font-semibold px-2 py-0.5 rounded-full">Apoyo / Reportes</span>
                            </div>
                            <p className="text-xs text-gray-400 mt-0.5">Sin especialidades asignadas · solo acceso a reportes</p>
                          </div>
                          <button onClick={() => eliminarProfesional(p.id_usuario)} className="text-red-600 hover:underline text-sm">Eliminar</button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                {administrativos.length > 0 && (
                  <>
                    <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mt-6 mb-2">Administrativos</h4>
                    <ul className="space-y-3">
                      {administrativos.map(a => (
                        <li key={a.id_usuario} className="bg-gray-50 p-3 rounded border flex justify-between items-center">
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="font-bold text-gray-700">{a.email}</p>
                              <span className="text-xs bg-gray-200 text-gray-600 font-semibold px-2 py-0.5 rounded-full">Administrativo</span>
                            </div>
                            <p className="text-xs text-gray-400 mt-0.5">Acceso a triage y gestión de reservas</p>
                          </div>
                          <button onClick={() => eliminarProfesional(a.id_usuario)} className="text-red-600 hover:underline text-sm">Eliminar</button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </section>
          )}

          {pestañaActiva === 'servicios' && (
            <section className="max-w-md mx-auto">
              <h2 className="text-2xl font-bold mb-6 text-blue-900">
                {servicioEditando ? "Editar Especialidad" : "Agregar Nueva Especialidad/Servicio"}
              </h2>
              <form onSubmit={guardarServicio} className="space-y-4">
                <div>
                  <label className="block text-gray-700 font-medium mb-1">Nombre (Ej: Medicina General)</label>
                  <input type="text" value={nuevoServicioNombre} onChange={(e)=>setNuevoServicioNombre(e.target.value)} required className="w-full p-2 border rounded text-sm" />
                </div>
                <div>
                  <label className="block text-gray-700 font-medium mb-1">Acrónimo (máx 3 letras, aparece en el calendario)</label>
                  <input
                    type="text"
                    value={nuevoServicioAcronimo}
                    onChange={(e) => setNuevoServicioAcronimo(e.target.value.toUpperCase().slice(0, 3))}
                    placeholder="Ej: MG, PSI, NN"
                    maxLength={3}
                    className="w-full p-2 border rounded uppercase"
                  />
                  <p className="text-xs text-gray-400 mt-1">Si se deja vacío aparecerá "NN" en el calendario.</p>
                </div>
                <div>
                  <label className="block text-gray-700 font-medium mb-1">Duración en minutos (por atención)</label>
                  <input type="number" value={nuevoServicioDuracion} onChange={(e)=>setNuevoServicioDuracion(e.target.value)} required min="1" className="w-full p-2 border rounded text-sm" />
                </div>
                <div>
                  <label className="block text-gray-700 font-medium mb-1">Tope de sesiones (Dejar vacío si no tiene límite)</label>
                  <input type="number" value={nuevoServicioTope} onChange={(e)=>setNuevoServicioTope(e.target.value)} min="1" className="w-full p-2 border rounded text-sm" />
                </div>
                <div className="flex items-center space-x-2 mt-4">
                  <input type="checkbox" id="es_ciclico" checked={nuevoServicioCiclico} onChange={(e)=>setNuevoServicioCiclico(e.target.checked)} className="h-4 w-4 text-blue-600" />
                  <label htmlFor="es_ciclico" className="text-gray-700 font-medium">Es un servicio cíclico (seguimiento semanal)</label>
                </div>
                <div className="flex gap-2 mt-4">
                  <button type="submit" className="w-full bg-blue-700 hover:bg-blue-800 text-white font-bold py-3 rounded">
                    {servicioEditando ? "Actualizar" : "Guardar Especialidad"}
                  </button>
                  {servicioEditando && (
                    <button type="button" onClick={() => { setServicioEditando(null); setNuevoServicioNombre(''); setNuevoServicioCiclico(false); setNuevoServicioDuracion(60); setNuevoServicioTope(''); setNuevoServicioAcronimo(''); }} className="w-full bg-gray-300 hover:bg-gray-400 text-gray-800 font-bold py-3 rounded">
                      Cancelar
                    </button>
                  )}
                </div>
              </form>
              
              <h3 className="text-lg font-bold mt-10 mb-4 text-blue-900">Servicios Actuales</h3>
              <ul className="divide-y divide-gray-200">
                {servicios.map(s => (
                  <li key={s.id_servicio} className="py-3 flex justify-between items-center">
                    <span className="text-sm text-gray-700"><strong>{s.nombre}</strong> <span className="inline-block bg-gray-200 text-gray-600 text-xs font-bold px-1 rounded">{s.acronimo || 'NN'}</span> — {s.duracion_minutos} min {s.es_ciclico && '(Cíclico)'}</span>
                    <div className="flex gap-3">
                      <button onClick={() => prepararEdicionServicio(s)} className="text-blue-600 hover:text-indigo-800 text-sm">Editar</button>
                      <button onClick={() => eliminarServicio(s.id_servicio)} className="text-red-600 hover:text-red-800 text-sm">Borrar</button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {pestañaActiva === 'ubicaciones' && (
            <section className="max-w-md mx-auto">
              <h2 className="text-2xl font-bold mb-6 text-blue-900">
                {ubicacionEditando ? "Editar Ubicación" : "Agregar Ubicación (Campus)"}
              </h2>
              <form onSubmit={guardarUbicacion} className="space-y-4">
                <div>
                  <label className="block text-gray-700 font-medium mb-1">Nombre (Ej: Casa Central, IBC, Curauma)</label>
                  <input type="text" value={nuevaUbicacionNombre} onChange={(e)=>setNuevaUbicacionNombre(e.target.value)} required className="w-full p-2 border rounded text-sm" />
                </div>
                <div>
                  <label className="block text-gray-700 font-medium mb-1">Abreviatura (aparece en el calendario de disponibilidad)</label>
                  <input
                    type="text"
                    value={nuevaUbicacionAbreviatura}
                    onChange={(e) => setNuevaUbicacionAbreviatura(e.target.value)}
                    placeholder="Ej: CC, IBC, CUR"
                    maxLength={10}
                    className="w-full p-2 border rounded text-sm"
                  />
                  <p className="text-xs text-gray-400 mt-1">Opcional. Si se deja vacío se muestra el nombre completo.</p>
                </div>
                <div>
                  <label className="block text-gray-700 font-medium mb-1">Dirección <span className="text-red-600">*</span></label>
                  <input
                    type="text"
                    value={nuevaUbicacionDireccion}
                    onChange={(e) => setNuevaUbicacionDireccion(e.target.value)}
                    placeholder="Ej: Avenida Brasil N.º 2950"
                    required
                    className="w-full p-2 border rounded text-sm"
                  />
                  <p className="text-xs text-gray-400 mt-1">No se muestra en la app; solo aparece en el correo de confirmación de la cita.</p>
                </div>
                <div className="flex gap-2">
                  <button type="submit" className="w-full bg-blue-700 hover:bg-blue-800 text-white font-bold py-3 rounded">
                    {ubicacionEditando ? "Actualizar" : "Guardar Ubicación"}
                  </button>
                  {ubicacionEditando && (
                    <button type="button" onClick={() => { setUbicacionEditando(null); setNuevaUbicacionNombre(''); setNuevaUbicacionAbreviatura(''); setNuevaUbicacionDireccion(''); }} className="w-full bg-gray-300 hover:bg-gray-400 text-gray-800 font-bold py-3 rounded">
                      Cancelar
                    </button>
                  )}
                </div>
              </form>

              <h3 className="text-lg font-bold mt-10 mb-4 text-blue-900">Ubicaciones Actuales</h3>
              <ul className="divide-y divide-gray-200">
                {ubicaciones.length === 0 && <li className="py-3 text-sm text-gray-500">No hay ubicaciones registradas.</li>}
                {ubicaciones.map(u => (
                  <li key={u.id_ubicacion} className="py-3 flex justify-between items-center">
                    <span className={`text-sm ${u.activo ? 'text-gray-700' : 'text-gray-400 line-through'}`}>
                      <strong>{u.nombre}</strong>{u.abreviatura && <span className="ml-1 inline-block bg-gray-200 text-gray-600 text-xs font-bold px-1 rounded">{u.abreviatura}</span>} {!u.activo && '(inactiva)'}
                      {u.direccion && <span className="block text-xs text-gray-400">📍 {u.direccion}</span>}
                    </span>
                    <div className="flex gap-3">
                      <button onClick={() => prepararEdicionUbicacion(u)} className="text-blue-600 hover:text-indigo-800 text-sm">Editar</button>
                      <button onClick={() => toggleActivoUbicacion(u)} className="text-amber-600 hover:text-amber-800 text-sm">{u.activo ? 'Desactivar' : 'Activar'}</button>
                      <button onClick={() => eliminarUbicacion(u.id_ubicacion)} className="text-red-600 hover:text-red-800 text-sm">Borrar</button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {pestañaActiva === 'agenda' && (
            <section>
              <h2 className="text-2xl font-bold mb-4">Gestión y Publicación de Agendas</h2>

              <div className="mb-6 max-w-md">
                <label className="block text-gray-700 font-medium mb-2">Seleccionar Profesional</label>
                <select value={profesionalSeleccionado} onChange={(e)=>setProfesionalSeleccionado(e.target.value)} className="w-full p-2 border rounded text-sm">
                  <option value="">-- Elija un profesional --</option>
                  {profesionales.filter(p => p.usuario?.rol !== 'profesional_apoyo').map(p => (
                    <option key={p.id_profesional} value={p.id_profesional}>{p.nombres} {p.apellidos}</option>
                  ))}
                </select>
              </div>

              {profesionalSeleccionado && (
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <div className="flex justify-between items-center mb-2">
                    <h3 className="font-bold text-lg text-blue-900">Calendario del Profesional</h3>
                    <div className="flex space-x-2">
                      <button onClick={() => cambiarSemanaGestion(-7)} className="px-2 py-1 bg-gray-100 rounded hover:bg-gray-200 font-bold">&larr; Ant</button>
                      <span className="px-3 py-1 font-semibold text-sm bg-white border rounded">Semana del {fechaBaseGestion.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })}</span>
                      <button onClick={() => cambiarSemanaGestion(7)} className="px-2 py-1 bg-gray-100 rounded hover:bg-gray-200 font-bold">Sig &rarr;</button>
                    </div>
                  </div>
                  <p className="text-sm text-gray-500 mb-4">Haz clic en un espacio vacío para publicar una hora (se repite cada semana hasta fin de año, omitiendo feriados). Haz clic en un bloque reservado para ver con qué estudiante es la sesión.</p>

                  {/* Barra de ubicación por día: define el campus por defecto al publicar cada día (editable por bloque en el modal). */}
                  <div className="mb-4 bg-blue-50 border border-blue-200 rounded-lg p-3">
                    <p className="text-xs font-semibold text-blue-900 mb-2">📍 Ubicación por día (se aplica a las horas que publiques en ese día; puedes cambiarla por bloque al crear)</p>
                    <div className="grid grid-cols-5 gap-2">
                      {diasSemana.map((dia, i) => (
                        <div key={dia}>
                          <label className="block text-[11px] font-medium text-gray-600 mb-1">{dia}</label>
                          <select
                            value={ubicacionPorDia[i] || ''}
                            onChange={(e) => setUbicacionPorDia(prev => ({ ...prev, [i]: e.target.value }))}
                            className="w-full p-1 text-xs border rounded select-compacto"
                          >
                            <option value="">(elegir al publicar)</option>
                            {ubicaciones.filter(u => u.activo).map(u => (
                              <option key={u.id_ubicacion} value={u.id_ubicacion}>{u.nombre}</option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="overflow-x-auto pb-4">
                    <table className="w-full min-w-[1000px] table-fixed border-collapse border-2 border-gray-300 text-sm bg-white">
                      <thead>
                        <tr>
                          <th className="w-24 p-3 border-2 border-gray-300 bg-gray-100 text-gray-700 shadow-sm">Hora</th>
                          {diasSemana.map((dia, i) => {
                            const fechaHeader = new Date(fechaBaseGestion);
                            fechaHeader.setDate(fechaBaseGestion.getDate() + i);
                            return (
                              <th key={dia} className="w-1/5 p-3 border-2 border-gray-300 text-center font-bold text-gray-700 bg-gray-100 shadow-sm">
                                {dia} <br/> <span className="text-xs font-normal text-gray-500">{fechaHeader.toLocaleDateString('es-ES', {day: 'numeric', month: 'short'})}</span>
                              </th>
                            );
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'].map(hora => {
                          const MIN_SLOT_PX = 52;
                          let maxSlots = 1;
                          for (let di = 0; di < diasSemana.length; di++) {
                            const bCelda = getBloquesPublicadosEnGrilla(di, hora);
                            if (bCelda.length > 0) {
                              const minDur = Math.min(...bCelda.map(b => b.fecha_hora_fin
                                ? (new Date(b.fecha_hora_fin) - new Date(b.fecha_hora_inicio)) / 60000
                                : 60));
                              if (minDur > 0) maxSlots = Math.max(maxSlots, Math.ceil(60 / minDur));
                            }
                          }
                          const rowH = Math.max(maxSlots * MIN_SLOT_PX, 80);
                          return (
                          <tr key={hora}>
                            <td className="p-2 border-2 border-gray-300 text-center text-xs font-bold text-gray-500 bg-gray-50 align-top w-24" style={{ height: rowH }}>
                              {hora} - {String(parseInt(hora.split(':')[0]) + 1).padStart(2, '0')}:00
                            </td>
                            {diasSemana.map((_, i) => {
                              const bloquesCelda = getBloquesPublicadosEnGrilla(i, hora);
                              return (
                                <td
                                  key={i}
                                  onClick={() => abrirCrearBloque(i, hora)}
                                  title="Clic para publicar una hora aquí"
                                  className="border-2 border-gray-300 hover:bg-blue-50 transition p-0 align-top relative cursor-pointer group"
                                  style={{ height: rowH }}
                                >
                                  <span className="absolute inset-0 flex items-center justify-center text-2xl text-blue-300 opacity-0 group-hover:opacity-100 transition pointer-events-none">+</span>
                                  <div className="w-full h-full relative block">
                                    {bloquesCelda.map((bloque) => {
                                      const horaStr = bloque.fecha_hora_inicio.replace(' ', 'T').split('T')[1].substring(0, 5);
                                      const horaFinStr = bloque.fecha_hora_fin ? bloque.fecha_hora_fin.replace(' ', 'T').split('T')[1].substring(0, 5) : '';
                                      const minInicio = parseInt(horaStr.split(':')[1], 10);

                                      const bInicio = new Date(bloque.fecha_hora_inicio);
                                      let duracionMin = 60; // 1 hora por defecto
                                      if (bloque.fecha_hora_fin) {
                                        const bFin = new Date(bloque.fecha_hora_fin);
                                        duracionMin = (bFin - bInicio) / 60000;
                                      }

                                      const topPct = (minInicio / 60) * 100;
                                      const altoPct = Math.max((duracionMin / 60) * 100, 10);
                                      const estudiante = getEstudianteDeBloque(bloque);
                                      const sesion = getEstadoSesion(bloque); // null si el bloque es futuro

                                      // Segunda línea del chip: pasada → estado clínico (+ estudiante);
                                      // futura → estudiante o estado crudo del bloque (comportamiento previo).
                                      let segundaLinea;
                                      if (sesion && sesion.clave === 'sin_reserva') {
                                        segundaLinea = 'Sin reserva';
                                      } else if (sesion) {
                                        const detalleEst = estudiante
                                          ? `👤 ${estudiante.nombres} ${estudiante.apellidos}`
                                          : '(sin datos del estudiante)';
                                        segundaLinea = `${sesion.etiqueta} · ${detalleEst}`;
                                      } else {
                                        segundaLinea = estudiante ? `👤 ${estudiante.nombres} ${estudiante.apellidos}` : bloque.estado;
                                      }

                                      return (
                                        <div
                                          key={bloque.id_bloque}
                                          onClick={(e) => { e.stopPropagation(); iniciarEliminacion(bloque); }}
                                          className={`absolute left-0 right-0 m-0.5 p-1 border rounded-md flex flex-col text-xs transition-colors shadow-sm overflow-hidden cursor-pointer hover:opacity-80 z-10 ${sesion ? sesion.colorClass : getColorEstado(bloque.estado)}`}
                                          style={{ top: `${topPct}%`, height: `calc(${altoPct}% - 4px)` }}
                                        >
                                          <div className="font-bold truncate leading-tight flex justify-between items-start">
                                            <span>{horaStr} - {horaFinStr}</span>
                                            <div className="ml-1 flex-shrink-0 flex flex-col items-end gap-0.5">
                                              <span className="bg-white/60 text-gray-700 font-bold text-[9px] px-0.5 rounded leading-tight">
                                                {(servicios.find(s => s.id_servicio === bloque.id_servicio)?.acronimo || 'NN').toUpperCase()}
                                              </span>
                                              <span className="bg-sky-300/80 text-sky-900 font-bold text-[9px] px-0.5 rounded leading-tight">
                                                {(bloque.ubicacion?.abreviatura || 'NN').toUpperCase()}
                                              </span>
                                            </div>
                                          </div>
                                          <div className="truncate leading-tight mt-0.5 font-medium text-[10px]">
                                            {segundaLinea}
                                          </div>
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
            </section>
          )}


          {pestañaActiva === 'buscador' && (
            <section className="flex flex-col md:flex-row gap-6">
              <div className="md:w-1/3 md:border-r border-gray-200 md:pr-6">
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
                        className={`p-3 border-b cursor-pointer hover:bg-blue-50 transition ${estudianteSeleccionado?.id_estudiante === est.id_estudiante ? 'bg-indigo-100 border-l-4 border-indigo-600' : ''}`}
                      >
                        <p className="font-bold text-gray-800">{est.nombres} {est.apellidos}</p>
                        <p className="text-xs text-gray-500">RUT: {est.rut}</p>
                      </div>
                    ))
                  )}
                </div>
              </div>
              
              <div className="md:w-2/3">
                {!estudianteSeleccionado ? (
                  <div className="flex items-center justify-center h-full text-gray-400">Selecciona un estudiante de la lista para gestionar sus horas.</div>
                ) : (
                  <div>
                    <h2 className="text-2xl font-bold text-blue-900 mb-2">{estudianteSeleccionado.nombres} {estudianteSeleccionado.apellidos}</h2>
                    <p className="text-gray-600 mb-6">Carrera: {estudianteSeleccionado.carrera} | RUT: {estudianteSeleccionado.rut}</p>
                    
                    <div className="flex gap-4 mb-8">
                      <button onClick={() => iniciarAgendamiento('normal')} className="bg-blue-700 hover:bg-blue-800 text-white font-bold py-2 px-4 rounded shadow">
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
                      renderAcciones={(res) => res.estado === 'pendiente' ? (
                        <div className="flex flex-col gap-2 items-end">
                          <button onClick={() => cancelarReservaAdmin(res.id_reserva)} className="bg-red-100 text-red-700 hover:bg-red-200 font-bold py-1 px-3 rounded text-xs w-full text-center">Eliminar Reserva</button>
                          {new Date(res.fecha) < new Date() && (
                            <button onClick={() => marcarInasistenciaAdmin(res.id_reserva)} className="bg-orange-100 text-orange-800 hover:bg-orange-200 font-bold py-1 px-3 rounded text-xs w-full text-center" title="Visible porque la hora de atención ya pasó">Marcar Ausente</button>
                          )}
                        </div>
                      ) : null}
                    />
                  </div>
                )}
              </div>
            </section>
          )}

          {pestañaActiva === 'demanda' && (
            <section>
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
                            {diasSemanaAgendamiento.map(dia => (
                              <th key={dia} className="p-3 border-2 border-gray-300 bg-gray-100 capitalize font-bold text-gray-700">{dia}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {horasOpcionesAgendamiento.map(hora => {
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
                                {diasSemanaAgendamiento.map(dia => (
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
                            {diasSemanaAgendamiento.map((dia, i) => {
                              const f = new Date(fechaBaseSemanaDisp); f.setDate(f.getDate() + i);
                              return <th key={dia} className="p-3 border-2 border-gray-300 bg-gray-100 capitalize font-bold text-gray-700">{dia} <br/> <span className="text-xs font-normal text-gray-500">{f.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}</span></th>;
                            })}
                          </tr>
                        </thead>
                        <tbody>
                          {horasOpcionesAgendamiento.map(hora => {
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
                              {diasSemanaAgendamiento.map((dia, i) => {
                                const fechaDia = new Date(fechaBaseSemanaDisp);
                                fechaDia.setDate(fechaBaseSemanaDisp.getDate() + i);
                                const anio = fechaDia.getFullYear();
                                const mes = String(fechaDia.getMonth() + 1).padStart(2, '0');
                                const d = String(fechaDia.getDate()).padStart(2, '0');
                                const fechaStr = `${anio}-${mes}-${d}`;

                                return (
                                  <td key={`${dia}-${hora}`} className="border-2 border-gray-300 p-1 align-top bg-white">
                                    <div className="flex flex-col gap-1">
                                      {(() => {
                                        const prefijoHora = hora.split(':')[0];
                                        const bloquesCeldaDisp = bloquesDisp.filter(b => {
                                          if (!b.fecha_hora_inicio) return false;
                                          const [bFechaStr, bHoraStr] = b.fecha_hora_inicio.replace(' ', 'T').split('T');
                                          if (bFechaStr !== fechaStr || bHoraStr.split(':')[0] !== prefijoHora) return false;
                                          if (ubicacionFiltro && b.ubicacion?.id_ubicacion !== ubicacionFiltro) return false;
                                          return true;
                                        });
                                        return mergeSlotsConBloques(subSlots, bloquesCeldaDisp, duracionMin).map(({ inicio, fin, bloques }) => {
                                          const count = bloques.length;
                                          return count > 0 ? (
                                            <button
                                              key={inicio}
                                              onClick={() => setCeldaSeleccionadaDisp({ dia, hora: inicio, fecha: fechaStr, bloques })}
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
                                        });
                                      })()}
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
                  <p className="text-gray-600 mb-4 text-sm">Visualiza las horas agendadas de los estudiantes. Haz clic en un bloque para ver qué estudiantes están citados en ese horario con su respectivo profesional.</p>
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
                            {diasSemanaAgendamiento.map((dia, i) => {
                              const f = new Date(fechaBaseSemanaCalendario); f.setDate(f.getDate() + i);
                              return <th key={dia} className="p-3 border-2 border-gray-300 bg-gray-100 capitalize font-bold text-gray-700">{dia} <br/> <span className="text-xs font-normal text-gray-500">{f.toLocaleDateString('es-ES', {day: 'numeric', month: 'short'})}</span></th>;
                            })}
                          </tr>
                        </thead>
                        <tbody>
                          {horasOpcionesAgendamiento.map(hora => {
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
                                {diasSemanaAgendamiento.map((dia, i) => {
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
                                              className="min-h-[36px] w-full flex items-center justify-center bg-indigo-100 hover:bg-indigo-200 border border-indigo-400 text-indigo-900 rounded text-[11px] font-semibold text-center shadow-sm"
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

          {pestañaActiva === 'casos_pendientes' && (
            <section>
              <h2 className="text-2xl font-bold mb-2 text-amber-900">Estudiantes Pendientes de Aprobación Crítica</h2>
              <p className="text-gray-600 mb-6">Estos estudiantes fueron marcados por administrativos. Decide si son realmente casos críticos.</p>
          
              {cargandoPendientes ? (
                <div className="text-center text-gray-500 py-10">Cargando...</div>
              ) : casosPendientes.length === 0 ? (
                <div className="border-dashed border-2 border-gray-300 p-10 text-center text-gray-500 rounded-lg">
                  ✓ No hay estudiantes pendientes de revisión.
                </div>
              ) : (
                <div className="grid gap-4">
                  {casosPendientes.map((est) => (
                    <div key={est.id_estudiante} className="bg-amber-50 border-2 border-amber-200 rounded-lg p-5 hover:shadow-md transition">
                      <div className="flex justify-between items-start gap-4">
                        <div className="flex-1">
                          <h3 className="text-xl font-bold text-amber-900">{est.nombres} {est.apellidos}</h3>
                          <p className="text-sm text-gray-600 mt-1"><strong>RUT:</strong> {est.rut} | <strong>Carrera:</strong> {est.carrera}</p>
                          <p className="text-sm text-gray-600 mt-2"><strong>Motivo:</strong> {est.motivo_caso_critico}</p>
                          <p className="text-xs text-gray-400 mt-1">Marcado: {new Date(est.fecha_marcado_critico).toLocaleString('es-ES')}</p>
                        </div>
                        <div className="flex flex-col gap-2">
                          <button 
                            onClick={() => aprobarCasosCriticos(est.id_estudiante)}
                            className="bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-3 rounded text-sm transition"
                          >
                            ✓ Aprobar
                          </button>
                          <button 
                            onClick={() => rechazarCasoCritico(est.id_estudiante)}
                            className="bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-3 rounded text-sm transition"
                          >
                            ✗ Rechazar
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
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

      {/* Modal Edición de Profesional */}
      {modalEditProf && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg p-6 max-w-sm w-full shadow-xl">
            <h3 className="text-lg font-bold text-gray-900 mb-4">Editar {modalEditProf.nombres}</h3>
            <label className="block text-gray-700 font-medium mb-2">Servicios Asignados</label>
            <div className="grid gap-2 max-h-48 overflow-y-auto mb-4 p-2 border rounded">
              {servicios.map(s => (
                <label key={s.id_servicio} className="flex items-center space-x-2">
                  <input type="checkbox" checked={modalEditProf.servicios.includes(s.id_servicio)} onChange={(e) => {
                    const nuevos = e.target.checked 
                      ? [...modalEditProf.servicios, s.id_servicio] 
                      : modalEditProf.servicios.filter(id => id !== s.id_servicio);
                    setModalEditProf({...modalEditProf, servicios: nuevos});
                  }} />
                  <span className="text-sm">{s.nombre}</span>
                </label>
              ))}
            </div>
            <div className="flex gap-2">
              <button onClick={guardarServiciosProfesional} className="w-full bg-indigo-600 text-white py-2 rounded font-bold">Guardar</button>
              <button onClick={() => setModalEditProf(null)} className="w-full bg-gray-300 text-gray-800 py-2 rounded font-bold">Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Eliminación de Bloque */}
      {modalEliminar && bloqueAEliminar && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg p-6 max-w-sm w-full shadow-xl">
            <h3 className="text-lg font-bold text-gray-900 mb-2">Gestionar Bloque</h3>
            {(() => {
              const est = getEstudianteDeBloque(bloqueAEliminar);
              const sesion = getEstadoSesion(bloqueAEliminar); // null si la sesión es futura
              return (
                <div className="mb-4 text-sm bg-gray-50 border border-gray-200 rounded p-3">
                  <p><strong>Servicio:</strong> {bloqueAEliminar.servicio?.nombre || '—'}</p>
                  <p><strong>Fecha:</strong> {new Date(bloqueAEliminar.fecha_hora_inicio).toLocaleDateString()} a las {bloqueAEliminar.fecha_hora_inicio.replace(' ', 'T').split('T')[1].substring(0, 5)}</p>
                  {sesion ? (
                    <p><strong>Estado de la sesión:</strong>{' '}
                      <span className={`px-1.5 py-0.5 rounded text-xs font-semibold border ${sesion.colorClass}`}>{sesion.etiqueta}</span>
                    </p>
                  ) : (
                    <p><strong>Estado:</strong> <span className="capitalize">{bloqueAEliminar.estado}</span></p>
                  )}
                  {est ? (
                    <p className="mt-1 text-blue-900"><strong>Estudiante:</strong> {est.nombres} {est.apellidos}{est.rut ? ` (${est.rut})` : ''}</p>
                  ) : (
                    <p className="mt-1 text-gray-500">Sin reserva</p>
                  )}
                </div>
              );
            })()}
            {/* ----- Cambiar campus (ubicación) ----- */}
            <div className="mb-5 border border-blue-200 bg-blue-50 rounded p-3">
              <label className="block text-sm font-bold text-blue-900 mb-1">📍 Cambiar campus</label>
              <p className="text-xs text-blue-800 mb-2">
                Campus actual: <strong>{bloqueAEliminar.ubicacion?.nombre || 'Sin ubicación'}</strong>
              </p>
              <select
                value={campusEditar}
                onChange={(e) => setCampusEditar(e.target.value)}
                className="w-full p-2 border rounded mb-2 text-sm"
              >
                <option value="">-- Selecciona un campus --</option>
                {ubicaciones.filter(u => u.activo || u.id_ubicacion === campusEditar).map(u => (
                  <option key={u.id_ubicacion} value={u.id_ubicacion}>{u.nombre}</option>
                ))}
              </select>
              <div className="flex flex-col gap-2">
                <button
                  onClick={() => ejecutarCambioCampus(false)}
                  disabled={!campusEditar || campusEditar === (bloqueAEliminar.ubicacion?.id_ubicacion || '')}
                  className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-2 px-4 rounded text-sm transition"
                >
                  Cambiar campus solo esta vez
                </button>
                <button
                  onClick={() => ejecutarCambioCampus(true)}
                  disabled={!campusEditar || campusEditar === (bloqueAEliminar.ubicacion?.id_ubicacion || '')}
                  className="bg-blue-100 hover:bg-blue-200 disabled:opacity-40 disabled:cursor-not-allowed text-blue-800 font-semibold py-2 px-4 rounded text-sm transition"
                >
                  Cambiar campus de aquí en adelante
                </button>
              </div>
            </div>

            <p className="text-gray-600 mb-6 text-sm">
              ¿Deseas eliminar solo esta hora, o también las de las semanas siguientes en este mismo horario?
              {bloqueAEliminar.estado !== 'disponible' && (
                <span className="block mt-2 text-red-600 font-semibold">Atención: Si este bloque tiene horas reservadas, dichas reservas serán canceladas automáticamente y se liberará la agenda.</span>
              )}
            </p>

            <div className="flex flex-col gap-3">
              <button
                onClick={() => ejecutarEliminacion(false)}
                className="bg-indigo-100 hover:bg-indigo-200 text-indigo-800 font-bold py-2 px-4 rounded transition"
              >
                Eliminar solo este bloque
              </button>
              <button
                onClick={() => ejecutarEliminacion(true)}
                className="bg-orange-100 hover:bg-orange-200 text-orange-800 font-bold py-2 px-4 rounded transition"
              >
                Eliminar todas las semanas siguientes
              </button>
              <button
                onClick={() => { setModalEliminar(false); setBloqueAEliminar(null); }}
                className="mt-2 text-gray-500 hover:text-gray-700 font-semibold"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Creación de Bloque (calendario unificado) */}
      {modalCrear && (() => {
        const vc = getValidacionCrear();
        const bloqueoValidacion = !!vc && (vc.esPasada || vc.haySolape);
        return (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg p-6 max-w-sm w-full shadow-xl">
            <h3 className="text-lg font-bold text-gray-900 mb-1">Publicar Hora</h3>
            <p className="text-sm text-gray-500 mb-4">
              {diasSemana[modalCrear.diaIndex]} {new Date(`${modalCrear.fechaStr}T00:00:00`).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })} · {modalCrear.hora}
            </p>

            {serviciosFiltrados.length === 0 ? (
              <p className="text-sm text-red-600 mb-4">Este profesional no tiene servicios asignados.</p>
            ) : (
              <>
                {serviciosFiltrados.length > 1 && (
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-gray-700 mb-1">Servicio</label>
                    <select
                      value={crearServicioId}
                      onChange={(e) => { setCrearServicioId(e.target.value); setCrearHoraInicio(''); }}
                      className="w-full p-2 border rounded text-sm"
                    >
                      <option value="">-- Selecciona un servicio --</option>
                      {serviciosFiltrados.map(s => (
                        <option key={s.id_servicio} value={s.id_servicio}>{s.nombre}</option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Ubicación (campus) <span className="text-red-600">*</span></label>
                  <select
                    value={crearUbicacionId}
                    onChange={(e) => setCrearUbicacionId(e.target.value)}
                    className="w-full p-2 border rounded text-sm"
                  >
                    <option value="">-- Selecciona un campus --</option>
                    {ubicaciones.filter(u => u.activo || u.id_ubicacion === crearUbicacionId).map(u => (
                      <option key={u.id_ubicacion} value={u.id_ubicacion}>{u.nombre}</option>
                    ))}
                  </select>
                </div>

                {crearServicioId && (
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-gray-700 mb-1">Hora de inicio</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="time"
                        value={crearHoraInicio}
                        min="08:00"
                        max="17:59"
                        onChange={(e) => setCrearHoraInicio(e.target.value)}
                        className="p-2 border rounded text-sm w-32"
                      />
                      {vc && (
                        <span className="text-sm text-gray-600">→ termina <strong>{vc.fin}</strong> <span className="text-gray-400">({vc.duracion} min)</span></span>
                      )}
                    </div>
                    <p className="text-[11px] text-gray-400 mt-1">Puedes elegir cualquier minuto (ej. 12:10, 12:45). Se repite cada semana hasta fin de año.</p>
                    {vc?.esPasada && <p className="text-xs text-red-600 mt-1">⚠ Ese horario ya pasó.</p>}
                    {vc?.haySolape && <p className="text-xs text-red-600 mt-1">⚠ Se solapa con otro bloque del profesional ese día.</p>}
                    {vc?.fueraDeRango && !vc.esPasada && !vc.haySolape && <p className="text-xs text-amber-600 mt-1">⚠ Fuera del horario de atención habitual (08:00–17:59), pero puedes publicarlo igual.</p>}
                  </div>
                )}
              </>
            )}

            <div className="flex flex-col gap-3 mt-2">
              <button
                onClick={crearBloqueEnCelda}
                disabled={!crearServicioId || !crearHoraInicio || !crearUbicacionId || creandoBloque || bloqueoValidacion}
                className={`font-bold py-2 px-4 rounded transition ${(!crearServicioId || !crearHoraInicio || !crearUbicacionId || creandoBloque || bloqueoValidacion) ? 'bg-gray-300 text-gray-500 cursor-not-allowed' : 'bg-blue-700 hover:bg-blue-800 text-white'}`}
              >
                {creandoBloque ? 'Publicando...' : 'Publicar (hasta fin de año)'}
              </button>
              <button
                onClick={() => setModalCrear(null)}
                className="text-gray-500 hover:text-gray-700 font-semibold"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
        );
      })()}

      {/* Modal Detalle de Reservas Coordinador */}
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
                      <div className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center font-bold text-lg text-white shadow bg-indigo-600`}>{i + 1}</div>
                      <div className="flex-1">
                        <div className="flex justify-between items-start mb-1">
                          <h4 className="font-bold text-gray-900 text-lg">{est?.nombres} {est?.apellidos}</h4>
                          <span className={`text-[10px] px-2 py-1 rounded font-bold uppercase ${res.estado === 'presente' ? 'bg-green-100 text-green-800' : 'bg-indigo-100 text-indigo-800'}`}>{res.estado}</span>
                        </div>
                        <div className="text-sm text-gray-600 mb-2">
                          <p><strong>RUT:</strong> {est?.rut} <span className="mx-2">|</span> <strong>Servicio:</strong> {bloque?.servicio?.nombre}</p>
                          <p><strong>Profesional:</strong> {prof?.nombres} {prof?.apellidos}</p>
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

      {/* Modal Multi-paso de Agendamiento Manual (Buscador) */}
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
                    const serviciosBloqueados = reservasEstudiante.filter(p => p.reservas.some(r => r.estado === 'pendiente' || r.estado === 'presente')).map(p => p.servicio_nombre);
                    const estaBloqueado = serviciosBloqueados.includes(srv.nombre);
                    return (
                      <button 
                        key={srv.id_servicio} 
                        onClick={() => !estaBloqueado && avanzarAServicio(srv)} 
                        className={`p-3 border rounded text-left transition ${estaBloqueado ? 'bg-red-50 border-red-200 cursor-not-allowed opacity-75' : 'hover:bg-blue-50'}`}
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
                <p className="font-bold mb-3">2. Selecciona un bloque disponible para {servicios.find(s => s.id_servicio === servicioSeleccionado)?.nombre}:</p>
                {bloquesDisponibles.length === 0 ? (
                  <p className="p-4 bg-yellow-50 text-yellow-800 rounded border border-yellow-200">No hay bloques disponibles en este momento.</p>
                ) : (
                  <div>
                    <div className="flex justify-between items-center mb-4 mt-2">
                      <div className="flex space-x-2">
                        <button onClick={() => cambiarSemanaAgendamiento(-7)} className="px-3 py-1 bg-gray-200 rounded font-bold text-sm">&larr; Ant</button>
                        <span className="px-4 py-1 font-semibold border rounded bg-white text-sm">Semana del {fechaBaseSemanaAgendamiento.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })}</span>
                        <button onClick={() => cambiarSemanaAgendamiento(7)} className="px-3 py-1 bg-gray-200 rounded font-bold text-sm">Sig &rarr;</button>
                      </div>
                    </div>
                    <div className="overflow-x-auto pb-4">
                      <table className="w-full min-w-[800px] table-fixed border-collapse border-2 border-gray-300 text-sm bg-white">
                        <thead>
                          <tr>
                            <th className="w-20 p-2 border-2 border-gray-300 bg-gray-100 text-gray-700">Hora</th>
                            {diasSemanaAgendamiento.map((dia, i) => {
                              const f = new Date(fechaBaseSemanaAgendamiento); f.setDate(f.getDate() + i);
                              return <th key={dia} className="p-2 border-2 border-gray-300 bg-gray-100 font-bold text-gray-700 capitalize">{dia} <br/> <span className="text-xs font-normal text-gray-500">{f.toLocaleDateString('es-ES', {day: 'numeric', month: 'short'})}</span></th>;
                            })}
                          </tr>
                        </thead>
                        <tbody>
                          {horasOpcionesAgendamiento.map(hora => {
                            const duracionMin = servicios.find(s => s.id_servicio === servicioSeleccionado)?.duracion_minutos || 60;
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
                              <td className="p-2 border-2 border-gray-300 text-center font-bold text-gray-500 bg-gray-50 align-top w-20 text-xs">{hora}</td>
                              {diasSemanaAgendamiento.map((_, i) => {
                                const celdas = getBloquesDisponiblesEnGrillaAdmin(i, hora);
                                return (
                                  <td key={i} className="border-2 border-gray-300 p-1 align-top bg-white">
                                    <div className="flex flex-col gap-1">
                                      {mergeSlotsConBloques(subSlots, celdas, duracionMin).map(({ inicio, fin, bloques }) => {
                                        // Un bloque por campus disponible en este horario (getBlocksForCell ya deduplica por hora+campus).
                                        return bloques.length > 0 ? (
                                          bloques.map(bloque => (
                                            <button key={`${inicio}-${bloque.id_bloque}`} onClick={() => { setBloqueSeleccionado(bloque); setPasoAgendar(tipoAgendamiento === 'prioritario' ? 3 : 4); }} className="min-h-[40px] flex flex-col justify-center items-center bg-green-100 hover:bg-green-200 border border-green-500 text-green-900 rounded text-[10px] text-center shadow-sm cursor-pointer">
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
                <div className="overflow-x-auto mb-6 mt-4">
                  <table className="w-full min-w-[800px] table-fixed border-collapse border-2 border-gray-300 text-sm bg-white">
                    <thead>
                      <tr>
                        <th className="w-20 p-2 border-2 border-gray-300 bg-gray-100">Hora</th>
                        {diasSemanaAgendamiento.map(dia => <th key={dia} className="p-2 border-2 border-gray-300 bg-gray-100 font-bold capitalize text-gray-700">{dia}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {horasOpcionesAgendamiento.map(hora => {
                        const duracionMin = servicios.find(s => s.id_servicio === servicioSeleccionado)?.duracion_minutos || 60;
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
                          <td className="p-2 border-2 border-gray-300 text-center font-bold text-gray-500 bg-gray-50 text-xs">{hora}</td>
                          {diasSemanaAgendamiento.map(dia => (
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
                <button onClick={() => setPasoAgendar(4)} className="mt-4 w-full bg-indigo-600 text-white font-bold py-2 rounded">Continuar a Confirmación →</button>
              </div>
            )}

            {pasoAgendar === 4 && (
              <div>
                <button onClick={() => setPasoAgendar(tipoAgendamiento === 'prioritario' ? 3 : 2)} className="text-blue-600 text-sm mb-3">← Volver</button>
                <p className="font-bold mb-3">Resumen del Agendamiento:</p>
                <div className="bg-gray-100 p-4 rounded mb-4">
                  <p><strong>Servicio:</strong> {servicios.find(s => s.id_servicio === servicioSeleccionado)?.nombre}</p>
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
    </div>
  );
}
