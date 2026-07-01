import { useState, useEffect, useMemo } from 'react';
import { API_URL } from './config';
import { supabase } from './supabaseClient';
import FormularioMotivo, { buildMotivoFinal } from './FormularioMotivo';
import HistorialEstudiante from './HistorialEstudiante';
import { getLunes, getBlocksForCell, deduplicateCyclicBlocks, getSlotsConDisponibilidad } from './utils/calendarUtils';

export default function DashboardProfesional({ session }) {
  const [pestañaActiva, setPestañaActiva] = useState('agenda');

  // Estados para la vista de agenda
  const [bloques, setBloques] = useState([]);
  const [cargando, setCargando] = useState(false);

  // Estados para modal de eliminación de bloques
  const [modalEliminar, setModalEliminar] = useState(false);
  const [bloqueAEliminar, setBloqueAEliminar] = useState(null);

  // Estados para modal de detalle de bloque
  const [modalDetalle, setModalDetalle] = useState(false);
  const [bloqueDetalle, setBloqueDetalle] = useState(null);

  const [fechaBaseSemana, setFechaBaseSemana] = useState(() => getLunes(new Date()));

  // Estados para el buscador de pacientes
  const [estudiantesGlobal, setEstudiantesGlobal] = useState([]);
  const [busqueda, setBusqueda] = useState('');
  const [estudianteSeleccionado, setEstudianteSeleccionado] = useState(null);
  const [procesoExpandido, setProcesoExpandido] = useState(null);
  const [reservasEstudiante, setReservasEstudiante] = useState([]);
  const [cargandoEstudiantes, setCargandoEstudiantes] = useState(false);


  // Cargar bloques desde FastAPI
  const cargarAgenda = async () => {
    setCargando(true);
    try {
      const respuesta = await fetch(`${API_URL}/bloques`, {
        headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (respuesta.ok) {
        const datos = await respuesta.json();
        const arrValido = Array.isArray(datos) ? datos : (datos?.data || []);
        setBloques(arrValido);
      } else {
        setBloques([]);
      }
    } catch (error) {
      console.error("Error al cargar la agenda:", error);
    } finally {
      setCargando(false);
    }
  };

  // Estados para la pestaña de atención (Evolución Clínica)
  const [atenciones, setAtenciones] = useState([]);
  const [atencionSeleccionada, setAtencionSeleccionada] = useState(null);
  const [asistencia, setAsistencia] = useState('presente');
  const [observaciones, setObservaciones] = useState('');
  const [diagnostico, setDiagnostico] = useState('');
  const [planTratamiento, setPlanTratamiento] = useState('');
  const [decisionContinuidad, setDecisionContinuidad] = useState('continuar');
  const [sesionesAdicionales, setSesionesAdicionales] = useState(0); // extensión de ciclo (última sesión)
  const [serviciosTotales, setServiciosTotales] = useState([]);
  const [esCasoCritico, setEsCasoCritico] = useState(false);
  
  // Flujo secuencial: un servicio a la vez
  const [servicioDerivacionActual, setServicioDerivacionActual] = useState('');  // Servicio que estoy configurando AHORA
  const [derivacionesAgregadas, setDerivacionesAgregadas] = useState([]);  // Lista de derivaciones ya guardadas
  
  // Estados para agendamiento de derivación (solo para el servicio actual)
  const [bloquesDerivacion, setBloquesDerivacion] = useState([]);
  const [bloqueDerivacionSeleccionado, setBloqueDerivacionSeleccionado] = useState(null);
  const [disponibilidadDerivacion, setDisponibilidadDerivacion] = useState({});
  const [campusSeleccionadosDeriv, setCampusSeleccionadosDeriv] = useState([]); // ids de ubicación que le sirven al beneficiario (+ '__none__')
  const [modoDerivacion, setModoDerivacion] = useState('ninguno'); // 'ninguno', 'calendario', 'lista'
  // campus picker para el modo calendario (múltiples campus mismo slot)
  const [opcionesCampusDerivacion, setOpcionesCampusDerivacion] = useState([]);
  const [mostrarPickerCampusDeriv, setMostrarPickerCampusDeriv] = useState(false);
  // campus por slot en modo lista de espera
  const [campusPorDiaDeriv, setCampusPorDiaDeriv] = useState({});
  const [campusPorSlotDeriv, setCampusPorSlotDeriv] = useState({});
  const [slotModalDeriv, setSlotModalDeriv] = useState(null);
  const [campusSlotTempDeriv, setCampusSlotTempDeriv] = useState([]);
  const [ubicacionesDeriv, setUbicacionesDeriv] = useState([]);
  const [encuestaDerivacion, setEncuestaDerivacion] = useState({ q1: "0", q2: "0", q3: "0" });
  const [motiDeriv, setMotiDeriv] = useState('');
  const esEntrevistaDerivacion = useMemo(() =>
    serviciosTotales.find(s => s.id_servicio === servicioDerivacionActual)?.nombre?.toLowerCase().includes('entrevista de ingreso') || false
  , [servicioDerivacionActual, serviciosTotales]);
  const duracionDerivacion = useMemo(() =>
    serviciosTotales.find(s => s.id_servicio === servicioDerivacionActual)?.duracion_minutos || 60
  , [servicioDerivacionActual, serviciosTotales]);


  // Carga TODOS los servicios para el menú de derivación
  const cargarServiciosTotales = async () => {
    try {
      const respuesta = await fetch(`${API_URL}/servicios`, {
        headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (respuesta.ok) {
        const datos = await respuesta.json();
        setServiciosTotales(datos);
      }
    } catch (error) {
      console.error("Error al cargar servicios totales:", error);
    }
  };

  // Carga las atenciones pendientes del profesional
  const cargarAtenciones = async () => {
    setCargando(true);
    try {
      const respuesta = await fetch(`${API_URL}/mis_atenciones`, {
        headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (respuesta.ok) {
        const datos = await respuesta.json();
        setAtenciones(datos);
      }
    } catch (error) {
      console.error("Error al cargar atenciones:", error);
    } finally {
      setCargando(false);
    }
  };

  // Traer disponibilidad cuando se selecciona un servicio a derivar
  useEffect(() => {
    if (servicioDerivacionActual) {
      const fetchDisponibilidad = async () => {
        try {
          const respuesta = await fetch(`${API_URL}/disponibilidad?id_servicio=${servicioDerivacionActual}`, {
            headers: { "Authorization": `Bearer ${session.access_token}` }
          });
          const data = await respuesta.json();
          const arr = Array.isArray(data) ? data : (data?.data || []);
          setBloquesDerivacion(arr);
          setCampusSeleccionadosDeriv([...new Set(arr.map(b => b.ubicacion?.id_ubicacion || '__none__'))]);
          setModoDerivacion('calendario');
          setBloqueDerivacionSeleccionado(null);
          setDisponibilidadDerivacion({});
        } catch (error) {
          console.error("Error obteniendo disponibilidad:", error);
        }
      };
      fetchDisponibilidad();
    } else {
      setModoDerivacion('ninguno');
      setBloqueDerivacionSeleccionado(null);
      setDisponibilidadDerivacion({});
      setBloquesDerivacion([]);
    }
    setEncuestaDerivacion({ q1: "0", q2: "0", q3: "0" });
    setMotiDeriv('');
  }, [servicioDerivacionActual]);

  // Cargar ubicaciones activas cuando se entra al modo lista de espera de derivación
  useEffect(() => {
    if (modoDerivacion === 'lista' && ubicacionesDeriv.length === 0) {
      fetch(`${API_URL}/ubicaciones?activo=true`)
        .then(r => r.ok ? r.json() : [])
        .then(setUbicacionesDeriv)
        .catch(console.error);
    }
  }, [modoDerivacion]);

  const [fechaBaseSemanaDerivacion, setFechaBaseSemanaDerivacion] = useState(() => getLunes(new Date()));

  const cambiarSemanaDerivacion = (dias) => {
    const nueva = new Date(fechaBaseSemanaDerivacion);
    nueva.setDate(nueva.getDate() + dias);
    setFechaBaseSemanaDerivacion(nueva);
  };

  const campusDisponiblesDeriv = useMemo(() => {
    const map = new Map();
    (Array.isArray(bloquesDerivacion) ? bloquesDerivacion : []).forEach(b => {
      const id = b.ubicacion?.id_ubicacion || '__none__';
      if (!map.has(id)) map.set(id, b.ubicacion?.nombre || 'Sin ubicación');
    });
    return Array.from(map, ([id, nombre]) => ({ id, nombre }));
  }, [bloquesDerivacion]);

  const toggleCampusDeriv = (id) => {
    setCampusSeleccionadosDeriv(prev =>
      prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]
    );
  };

  const bloquesDerivacionFiltrados = useMemo(() => {
    const base = (Array.isArray(bloquesDerivacion) ? bloquesDerivacion : [])
      .filter(b => campusSeleccionadosDeriv.includes(b.ubicacion?.id_ubicacion || '__none__'));
    return deduplicateCyclicBlocks(base, serviciosTotales.find(s => s.id_servicio === servicioDerivacionActual)?.es_ciclico);
  }, [bloquesDerivacion, campusSeleccionadosDeriv, servicioDerivacionActual, serviciosTotales]);

  const getBloquesDisponiblesEnGrillaDerivacion = (diaIndex, hora) =>
    getBlocksForCell(bloquesDerivacionFiltrados, fechaBaseSemanaDerivacion, diaIndex, hora);

  // Slots (día+hora) con hora disponible para los campus elegidos: se deshabilitan
  // en la grilla de lista de espera de la derivación (hay que reservarlos directo).
  const slotsConDisponibilidadDeriv = useMemo(
    () => getSlotsConDisponibilidad(bloquesDerivacionFiltrados),
    [bloquesDerivacionFiltrados]
  );

  const toggleDisponibilidadGridDerivacion = (dia, hora) => {
    setDisponibilidadDerivacion(prev => {
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

  // Abre selector de campus al hacer click en slot del calendario de derivación
  const abrirSeleccionSlotDeriv = (bloquesEnSlot) => {
    const map = new Map();
    bloquesEnSlot.forEach(b => {
      const id = b.ubicacion?.id_ubicacion || '__none__';
      if (!map.has(id)) map.set(id, { id, nombre: b.ubicacion?.nombre || 'Sin ubicación', bloque: b });
    });
    const opciones = Array.from(map.values());
    if (opciones.length === 1) {
      setBloqueDerivacionSeleccionado(opciones[0].bloque);
    } else {
      setOpcionesCampusDerivacion(opciones);
      setMostrarPickerCampusDeriv(true);
    }
  };

  // Manejo de slots en lista de espera de derivación (con campus por slot)
  const handleSlotClickEsperaDeriv = (dia, inicio, fin) => {
    const yaSeleccionado = (disponibilidadDerivacion[dia] || []).includes(inicio);
    if (yaSeleccionado) {
      setDisponibilidadDerivacion(prev => {
        const nueva = { ...prev };
        nueva[dia] = nueva[dia].filter(h => h !== inicio);
        if (nueva[dia].length === 0) delete nueva[dia];
        return nueva;
      });
      setCampusPorSlotDeriv(prev => { const n = { ...prev }; delete n[`${dia}|${inicio}`]; return n; });
    } else if (ubicacionesDeriv.length > 0) {
      setSlotModalDeriv({ dia, inicio, fin });
      setCampusSlotTempDeriv([...(campusPorDiaDeriv[dia] || [])]);
    } else {
      toggleDisponibilidadGridDerivacion(dia, inicio);
    }
  };

  const confirmarSlotEsperaDeriv = () => {
    if (!slotModalDeriv) return;
    const { dia, inicio } = slotModalDeriv;
    setDisponibilidadDerivacion(prev => {
      const nueva = { ...prev };
      if (!nueva[dia]) nueva[dia] = [];
      if (!nueva[dia].includes(inicio)) nueva[dia] = [...nueva[dia], inicio];
      return nueva;
    });
    setCampusPorSlotDeriv(prev => ({ ...prev, [`${dia}|${inicio}`]: campusSlotTempDeriv }));
    setSlotModalDeriv(null);
  };

  // Funciones para el buscador de pacientes
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

  const guardarEvolucion = async (e) => {
    e.preventDefault();

    if (asistencia === 'ausente') {
      try {
        const respuesta = await fetch(`${API_URL}/asistencia`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${session.access_token}`
          },
          body: JSON.stringify({
            id_reserva: atencionSeleccionada.id_reserva,
            estado: 'ausente'
          })
        });

        if (respuesta.ok) {
          alert("Inasistencia registrada exitosamente.");
          setAtencionSeleccionada(null);
          setObservaciones(''); setDiagnostico(''); setPlanTratamiento(''); setDecisionContinuidad('continuar'); setSesionesAdicionales(0); setDerivacionesAgregadas([]); setServicioDerivacionActual('');
          setBloqueDerivacionSeleccionado(null);
          setDisponibilidadDerivacion({});
          setModoDerivacion('ninguno');
          setAsistencia('presente');
          setEsCasoCritico(false);
          cargarAtenciones(); 
        } else {
          const data = await respuesta.json();
          alert("Error al registrar inasistencia: " + (data.detail || "Desconocido"));
        }
      } catch (error) {
        console.error(error);
        alert("Error de conexión al registrar inasistencia.");
      }
      return;
    }

    try {
      const respuesta = await fetch(`${API_URL}/evolucion`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`
        },
        body: JSON.stringify({
          id_reserva: atencionSeleccionada.id_reserva,
          observaciones,
          diagnostico,
          plan_tratamiento: planTratamiento,
          id_servicios_derivacion: derivacionesAgregadas.map(d => d.id_servicio),
          derivaciones_detalles: derivacionesAgregadas,
          decision_continuidad: !atencionSeleccionada?.es_ciclico
            ? 'cerrar_proceso'
            : (atencionSeleccionada?.es_ultima_sesion
                ? (sesionesAdicionales > 0 ? 'continuar' : 'cerrar_proceso')
                : decisionContinuidad),
          es_caso_critico: esCasoCritico,
          sesiones_adicionales: atencionSeleccionada?.es_ultima_sesion ? Number(sesionesAdicionales) : 0
        })
      });

      if (respuesta.ok) {
        alert("Evolución clínica registrada exitosamente.");
        setAtencionSeleccionada(null); // Volver a la lista
        setObservaciones(''); setDiagnostico(''); setPlanTratamiento(''); setDecisionContinuidad('continuar'); setSesionesAdicionales(0); setDerivacionesAgregadas([]); setServicioDerivacionActual('');
        setBloqueDerivacionSeleccionado(null);
        setDisponibilidadDerivacion({});
        setModoDerivacion('ninguno');
        setAsistencia('presente');
        setEsCasoCritico(false);
        cargarAtenciones(); // Recargar la lista de pacientes
      } else {
        const data = await respuesta.json();
        alert("Error al guardar evolución: " + (data.detail || "Desconocido"));
      }
    } catch (error) {
      console.error(error);
      alert("Error de conexión al guardar evolución.");
    }
  };

  // Efecto para cargar los bloques cada vez que entramos a la pestaña 'agenda'
  useEffect(() => {
    if (pestañaActiva === 'agenda') {
      cargarAgenda();
    } else if (pestañaActiva === 'atencion') {
      cargarAtenciones();
      cargarServiciosTotales();
    } else if (pestañaActiva === 'buscador') {
      cargarEstudiantes();
    }
  }, [pestañaActiva]);

  // La eliminación de bloques ahora la gestiona el Coordinador (este modal quedó deshabilitado)
  const ejecutarEliminacion = async () => {
    try {
      alert("La eliminación de bloques ahora es gestionada por tu Coordinador de área.");
      setModalEliminar(false);
    } catch (error) {
      console.error("Error:", error);
    }
  };

  const cerrarSesion = async () => {
    await supabase.auth.signOut();
  };

  // Utilidades del Calendario
  const diasSemana = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'];
  const horasGrilla = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];
  
  // Colores dinámicos según disponibilidad/reserva
  const getColorEstado = (estado) => {
    if (estado === 'disponible') return 'bg-green-100 border-green-500 text-green-900 border-solid shadow-sm';
    if (estado === 'reservado') return 'bg-yellow-100 border-yellow-500 text-yellow-900 border-solid shadow-sm opacity-80';
    if (estado === 'confirmado') return 'bg-blue-100 border-blue-500 text-blue-900 border-solid shadow-md';
    if (estado === 'huerfano') return 'bg-gray-100 border-gray-400 text-gray-600 border-dashed opacity-70';
    if (estado === 'bloqueado') return 'bg-orange-50 border-orange-400 text-orange-800 border-dashed';
    return 'bg-gray-100 border-gray-400 text-gray-800 border-solid';
  };

  const cambiarSemana = (dias) => {
    const nueva = new Date(fechaBaseSemana);
    nueva.setDate(nueva.getDate() + dias);
    setFechaBaseSemana(nueva);
  };

  const getBloquesEnGrilla = (diaIndex, hora) => {
    const fechaDia = new Date(fechaBaseSemana);
    fechaDia.setDate(fechaBaseSemana.getDate() + diaIndex);
    
    // Formatear localmente para evitar desfases de zona horaria (UTC)
    const anio = fechaDia.getFullYear();
    const mes = String(fechaDia.getMonth() + 1).padStart(2, '0');
    const dia = String(fechaDia.getDate()).padStart(2, '0');
    const fechaStr = `${anio}-${mes}-${dia}`;
    
    const prefijoHora = hora.split(':')[0]; // "09"
    
    return bloques.filter(b => {
      if (!b.fecha_hora_inicio) return false;
      if (b.estado === 'cancelado') return false;
      // Extraer fecha y hora directamente del string de la BD para evitar conversiones erróneas
      const [bFechaStr, bHoraStr] = b.fecha_hora_inicio.replace(' ', 'T').split('T');
      const bHora = bHoraStr.split(':')[0];
      
      return bFechaStr === fechaStr && bHora === prefijoHora;
    }).sort((a, b) => a.fecha_hora_inicio.localeCompare(b.fecha_hora_inicio));
  };
  
  
  return (
    <div className="min-h-screen bg-gray-50 text-gray-800">
      {/* Navbar Superior */}
      <header className="text-white p-4 shadow-md flex justify-between items-center" style={{ backgroundColor: '#003366' }}>
        <h1 className="text-xl font-bold">Portal Profesional - UBE</h1>
        <div>
          <span className="mr-4 text-sm">{session?.user?.email}</span>
          <button 
            className="bg-red-600 hover:bg-red-700 px-3 py-1 rounded text-sm font-semibold transition"
            onClick={cerrarSesion}
          >
            Cerrar Sesión
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6">
        
        {/* Navegación por pestañas */}
        <div className="flex space-x-2 border-b-2 border-gray-200 mb-6 pb-2">
          <button 
            onClick={() => setPestañaActiva('agenda')}
            className={`px-4 py-2 rounded-t-lg font-medium ${pestañaActiva === 'agenda' ? 'bg-blue-100 text-blue-800 border-b-4 border-blue-600' : 'text-gray-500 hover:text-blue-600 hover:bg-gray-100'}`}
          >
            Mi Agenda y Bloques
          </button>
          <button 
            onClick={() => setPestañaActiva('atencion')}
            className={`px-4 py-2 rounded-t-lg font-medium ${pestañaActiva === 'atencion' ? 'bg-blue-100 text-blue-800 border-b-4 border-blue-600' : 'text-gray-500 hover:text-blue-600 hover:bg-gray-100'}`}
          >
            Atención de Pacientes
          </button>
          <button 
            onClick={() => setPestañaActiva('buscador')}
            className={`px-4 py-2 rounded-t-lg font-medium ${pestañaActiva === 'buscador' ? 'bg-blue-100 text-blue-800 border-b-4 border-blue-600' : 'text-gray-500 hover:text-blue-600 hover:bg-gray-100'}`}
          >
            Buscador de Pacientes
          </button>
        </div>

        {/* Contenido Dinámico según la Pestaña */}
        <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
          
          {pestañaActiva === 'agenda' && (
            <section>
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-2xl font-bold">Mi Agenda Semanal</h2>
                <div className="flex space-x-2">
                  <button onClick={() => cambiarSemana(-7)} className="px-3 py-1 bg-gray-200 rounded hover:bg-gray-300 font-bold">&larr; Ant</button>
                  <span className="px-4 py-1 font-semibold border rounded bg-white">
                    Semana del {fechaBaseSemana.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })}
                  </span>
                  <button onClick={() => cambiarSemana(7)} className="px-3 py-1 bg-gray-200 rounded hover:bg-gray-300 font-bold">Sig &rarr;</button>
                </div>
              </div>
              
              {cargando ? (
                <div className="text-center p-10 text-gray-500 font-medium">Cargando agenda...</div>
              ) : (
                <div className="overflow-x-auto pb-4">
                  {/* min-w-[1000px] evita que se estreche, border-2 marca bien la cuadrícula */}
                  <table className="w-full min-w-[1000px] table-fixed border-collapse border-2 border-gray-300 text-sm bg-white">
                    <thead>
                      <tr>
                        <th className="w-24 p-3 border-2 border-gray-300 bg-gray-100 text-gray-700 shadow-sm">Hora</th>
                        {diasSemana.map((dia, i) => {
                          const fechaHeader = new Date(fechaBaseSemana);
                          fechaHeader.setDate(fechaBaseSemana.getDate() + i);
                          return (
                            <th key={dia} className="w-1/5 p-3 border-2 border-gray-300 text-center font-bold text-gray-700 bg-gray-100 shadow-sm">
                              {dia} <br/> <span className="text-xs font-normal text-gray-500">{fechaHeader.toLocaleDateString('es-ES', {day: 'numeric', month: 'short'})}</span>
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {horasGrilla.map(hora => (
                        <tr key={hora}>
                          {/* h-32 asegura una altura estricta para formar el cuadrado */}
                          <td className="p-2 border-2 border-gray-300 text-center text-xs font-bold text-gray-500 bg-gray-50 align-top w-24 h-32">
                            {hora} - {String(parseInt(hora.split(':')[0]) + 1).padStart(2, '0')}:00
                          </td>
                          {diasSemana.map((_, i) => {
                            const bloquesCelda = getBloquesEnGrilla(i, hora);
                            return (
                              <td key={i} className="border-2 border-gray-300 hover:bg-gray-50 transition p-0 h-32 align-top relative">
                                <div className="w-full h-full relative">
                                  {bloquesCelda.map((bloque) => {
                                    const horaStr = bloque.fecha_hora_inicio.replace(' ', 'T').split('T')[1].substring(0, 5);
                                    const horaFinStr = bloque.fecha_hora_fin ? bloque.fecha_hora_fin.replace(' ', 'T').split('T')[1].substring(0, 5) : '';
                                    const minInicio = parseInt(horaStr.split(':')[1], 10);
                                    const bInicio = new Date(bloque.fecha_hora_inicio.replace(' ', 'T'));
                                    let duracionMin = 60;
                                    if (bloque.fecha_hora_fin) {
                                      const bFin = new Date(bloque.fecha_hora_fin.replace(' ', 'T'));
                                      duracionMin = (bFin - bInicio) / 60000;
                                    }
                                    if (isNaN(duracionMin) || duracionMin <= 0) duracionMin = 60;
                                    const topPct = (minInicio / 60) * 100;
                                    const altoPct = Math.max((duracionMin / 60) * 100, 8);
                                    const compacto = duracionMin < 45;
                                    return (
                                      <div
                                        key={bloque.id_bloque}
                                        onClick={() => { setBloqueDetalle(bloque); setModalDetalle(true); }}
                                        className={`absolute left-0 right-0 m-0.5 border rounded-md flex flex-col overflow-hidden transition-colors shadow-sm cursor-pointer hover:opacity-80 ${getColorEstado(bloque.estado)}`}
                                        style={{ top: `${topPct}%`, height: `calc(${altoPct}% - 4px)`, padding: compacto ? '2px 4px' : '4px' }}
                                      >
                                        {(() => {
                                          const nombrePaciente = bloque.estudiante_nombres
                                            ? `${bloque.estudiante_nombres} ${bloque.estudiante_apellidos || ''}`.trim()
                                            : null;
                                          const ocupado = bloque.estado === 'reservado' || bloque.estado === 'confirmado';
                                          return (
                                            <>
                                              <div className={`font-bold leading-tight flex justify-between items-start ${compacto ? 'text-[10px]' : 'text-xs'}`}>
                                                <span className="truncate">{horaStr}{horaFinStr ? ` - ${horaFinStr}` : ''}</span>
                                                <div className="ml-1 flex-shrink-0 flex flex-col items-end gap-0.5">
                                                  <span className="bg-white/60 text-gray-700 font-bold text-[9px] px-0.5 rounded leading-tight">
                                                    {(bloque.servicio?.acronimo || 'NN').toUpperCase()}
                                                  </span>
                                                  <span className="bg-sky-300/80 text-sky-900 font-bold text-[9px] px-0.5 rounded leading-tight">
                                                    {(bloque.ubicacion?.abreviatura || '--').toUpperCase()}
                                                  </span>
                                                </div>
                                              </div>
                                              <div className={`truncate leading-tight font-medium ${compacto ? 'text-[9px]' : 'text-[10px]'}`}>
                                                {ocupado ? (
                                                  <span className={bloque.estado === 'confirmado' ? 'text-blue-900 font-bold' : 'text-yellow-900'}>
                                                    {nombrePaciente
                                                      ? (compacto ? nombrePaciente : `${nombrePaciente} (${bloque.estado === 'confirmado' ? 'Confirmado' : 'Reservado'})`)
                                                      : (bloque.estado === 'confirmado' ? 'Ocupado' : 'Reservado')}
                                                  </span>
                                                ) : bloque.estado === 'disponible' ? 'Libre'
                                                  : bloque.estado === 'huerfano' ? 'Reservado (ciclo)'
                                                  : 'Ofertado'}
                                              </div>
                                            </>
                                          );
                                        })()}
                                      </div>
                                    );
                                  })}
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {pestañaActiva === 'atencion' && (
            <section>
              <h2 className="text-2xl font-bold mb-4">Atención de Pacientes (Evolución Clínica)</h2>
              <p className="text-gray-600 mb-4">
                Aquí aparecerán los estudiantes con reservas activas. Podrás registrar asistencia, evolución clínica, y decidir la continuidad o derivación.
              </p>
              
              {!atencionSeleccionada ? (
                // LISTA DE PACIENTES
                cargando ? (
                  <div className="text-center p-10 text-gray-500">Cargando pacientes...</div>
                ) : atenciones.length === 0 ? (
                  <div className="border-dashed border-2 border-gray-300 p-10 text-center text-gray-500 rounded-lg">
                    No tienes pacientes pendientes de atención en este momento.
                  </div>
                ) : (
                  <div className="grid gap-4 md:grid-cols-2">
                    {atenciones.map(a => (
                      <div key={a.id_reserva} className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm flex flex-col justify-between">
                        <div>
                          <h3 className="font-bold text-lg text-blue-900">{a.estudiante_nombres} {a.estudiante_apellidos}</h3>
                          <p className="text-sm text-gray-600">{a.servicio_nombre}</p>
                          <p className="text-sm text-gray-800 mt-2">
                            <strong>Fecha:</strong> {new Date(a.fecha).toLocaleString()}
                          </p>
                        </div>
                        <button
                          onClick={() => { setAtencionSeleccionada(a); setSesionesAdicionales(0); setDecisionContinuidad('continuar'); }}
                          className="mt-4 bg-blue-600 hover:bg-blue-700 text-white py-2 px-4 rounded transition"
                        >
                          Registrar Evolución
                        </button>
                      </div>
                    ))}
                  </div>
                )
              ) : (
                // FORMULARIO DE EVOLUCIÓN
                <form onSubmit={guardarEvolucion} className="bg-gray-50 p-6 rounded-lg border border-gray-200 shadow-sm">
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-xl font-bold text-blue-900">
                      Evolución: {atencionSeleccionada.estudiante_nombres} {atencionSeleccionada.estudiante_apellidos}
                    </h3>
                    <button type="button" onClick={() => { setAtencionSeleccionada(null); setAsistencia('presente'); }} className="text-gray-500 hover:text-gray-700">
                      Volver a la lista
                    </button>
                  </div>

                  <div className="mb-4 bg-white p-4 border border-gray-200 rounded shadow-sm">
                    <label className="block text-gray-700 font-bold mb-2">Asistencia del Paciente</label>
                    <div className="flex gap-4">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="radio" name="asistencia" value="presente" checked={asistencia === 'presente'} onChange={() => setAsistencia('presente')} className="w-4 h-4 text-blue-600" />
                        <span>Presente (Registrar Evolución)</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="radio" name="asistencia" value="ausente" checked={asistencia === 'ausente'} onChange={() => setAsistencia('ausente')} className="w-4 h-4 text-red-600" />
                        <span className="text-red-600 font-medium">Ausente / No se presentó</span>
                      </label>
                    </div>
                  </div>

                  {asistencia === 'presente' ? (
                    <>
                      <div className="mb-4">
                        <label className="block text-gray-700 font-medium mb-2">Observaciones de la Sesión *</label>
                    <textarea value={observaciones} onChange={(e) => setObservaciones(e.target.value)} required rows="4" className="w-full p-2 border border-gray-300 rounded text-sm outline-none"></textarea>
                  </div>

                  <div className="mb-4">
                    <label className="block text-gray-700 font-medium mb-2">Diagnóstico (Opcional)</label>
                    <input type="text" value={diagnostico} onChange={(e) => setDiagnostico(e.target.value)} className="w-full p-2 border border-gray-300 rounded text-sm outline-none" />
                  </div>

                  <div className="mb-4">
                    <label className="block text-gray-700 font-medium mb-2">Plan de Tratamiento (Opcional)</label>
                    <textarea value={planTratamiento} onChange={(e) => setPlanTratamiento(e.target.value)} rows="2" className="w-full p-2 border border-gray-300 rounded text-sm outline-none"></textarea>
                  </div>

                  <div className="mb-6">
                    <label className="block text-gray-700 font-medium mb-2">Derivar a Servicio (Opcional) - Flujo Secuencial</label>
                    
                    {/* Paso 1: Seleccionar servicio */}
                    <div className="mb-4">
                      <label className="text-sm text-gray-600 font-semibold">Paso 1: Selecciona un servicio</label>
                      <select 
                        value={servicioDerivacionActual} 
                        onChange={(e) => setServicioDerivacionActual(e.target.value)} 
                        className="w-full p-2 border border-gray-300 rounded text-sm outline-none mt-1"
                      >
                        <option value="">-- Seleccionar servicio --</option>
                        {serviciosTotales.map(s => (
                          <option key={s.id_servicio} value={s.id_servicio}>{s.nombre}</option>
                        ))}
                      </select>
                    </div>

                    {/* Paso 2: Elegir disponibilidad si servicio seleccionado */}
                    {servicioDerivacionActual && (
                      <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded">
                        <label className="text-sm text-gray-600 font-semibold block mb-2">Paso 2: Elige hora o lista de espera</label>
                        
                        {modoDerivacion === 'calendario' && (
                          <div>
                            <div className="flex justify-between items-center mb-3">
                              <h4 className="font-bold text-gray-700 text-sm">Horarios disponibles:</h4>
                              <button 
                                type="button"
                                onClick={() => { setDisponibilidadDerivacion({}); setModoDerivacion('lista'); }} 
                                className="bg-yellow-500 hover:bg-yellow-600 text-white px-3 py-1 rounded text-xs font-bold transition"
                              >
                                No hay hora → Lista Espera
                              </button>
                            </div>
                            
                            {bloqueDerivacionSeleccionado ? (
                               <div className="bg-green-100 border border-green-400 text-green-800 p-2 rounded mb-3 flex justify-between items-center">
                                 <div>
                                   <strong className="text-sm">Hora seleccionada:</strong> 
                                   <span className="ml-1">{bloqueDerivacionSeleccionado.fecha_hora_inicio.replace('T', ' ').substring(0, 16)}</span>
                                 </div>
                                 <button type="button" onClick={() => setBloqueDerivacionSeleccionado(null)} className="text-xs underline font-bold">Cambiar</button>
                               </div>
                            ) : (
                                <div>
                                  {bloquesDerivacion.length === 0 ? (
                                    <div className="text-center p-3 border-2 border-dashed border-gray-300 rounded">
                                      <p className="text-red-600 font-bold mb-2 text-sm">No hay horas disponibles.</p>
                                      <button type="button" onClick={() => { setDisponibilidadDerivacion({}); setModoDerivacion('lista'); }} className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded text-xs font-bold">Ir a Lista de Espera</button>
                                    </div>
                                  ) : (
                                    <>
                                      {campusDisponiblesDeriv.length > 1 && (
                                        <div className="mb-2 flex flex-wrap gap-1 items-center">
                                          <span className="text-[11px] font-semibold text-gray-600 mr-1">📍 Campus:</span>
                                          {campusDisponiblesDeriv.map(c => {
                                            const activo = campusSeleccionadosDeriv.includes(c.id);
                                            return (
                                              <button
                                                key={c.id}
                                                type="button"
                                                onClick={() => toggleCampusDeriv(c.id)}
                                                className={`px-2 py-0.5 rounded-full text-[10px] font-medium border transition ${activo ? 'bg-blue-600 text-white border-blue-700' : 'bg-white text-gray-600 border-gray-300 hover:bg-blue-50'}`}
                                              >
                                                {activo ? '✓ ' : ''}{c.nombre}
                                              </button>
                                            );
                                          })}
                                        </div>
                                      )}
                                      <div className="flex justify-between items-center mb-2">
                                        <div className="flex space-x-1">
                                          <button type="button" onClick={() => cambiarSemanaDerivacion(-7)} className="px-2 py-1 bg-gray-200 rounded hover:bg-gray-300 text-xs font-bold">&larr; Ant</button>
                                          <span className="px-2 py-1 font-semibold border rounded bg-white text-xs">
                                            Semana {fechaBaseSemanaDerivacion.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })}
                                          </span>
                                          <button type="button" onClick={() => cambiarSemanaDerivacion(7)} className="px-2 py-1 bg-gray-200 rounded hover:bg-gray-300 text-xs font-bold">Sig &rarr;</button>
                                        </div>
                                      </div>
                                      <div className="overflow-x-auto pb-2">
                                        <table className="w-full min-w-[600px] table-fixed border-collapse border border-gray-300 text-xs bg-white">
                                          <thead>
                                            <tr>
                                              <th className="w-16 p-1 border border-gray-300 bg-gray-100 text-xs">Hora</th>
                                              {diasSemana.map((dia, i) => {
                                                const f = new Date(fechaBaseSemanaDerivacion);
                                                f.setDate(fechaBaseSemanaDerivacion.getDate() + i);
                                                return <th key={dia} className="p-1 border border-gray-300 bg-gray-100 text-xs">{dia} <br/><span className="font-normal text-gray-500">{f.toLocaleDateString('es-ES', {day: 'numeric', month: 'short'})}</span></th>;
                                              })}
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {horasGrilla.map(hora => {
                                              const startMin = parseInt(hora.split(':')[0], 10) * 60;
                                              const subSlots = [];
                                              for (let m = startMin; m + duracionDerivacion <= startMin + 60; m += duracionDerivacion) {
                                                const hh = String(Math.floor(m / 60)).padStart(2, '0');
                                                const mm = String(m % 60).padStart(2, '0');
                                                const endMin = m + duracionDerivacion;
                                                subSlots.push({
                                                  inicio: `${hh}:${mm}`,
                                                  fin: `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`
                                                });
                                              }
                                              return (
                                                <tr key={hora}>
                                                  <td className="p-1 border border-gray-300 text-center font-bold text-gray-500 bg-gray-50 text-xs">{hora}</td>
                                                  {diasSemana.map((_, i) => {
                                                    const celdas = getBloquesDisponiblesEnGrillaDerivacion(i, hora);
                                                    return (
                                                      <td key={i} className="border border-gray-300 p-1 align-top bg-white">
                                                        <div className="flex flex-col gap-1">
                                                          {subSlots.map(({ inicio, fin }) => {
                                                            const bloquesSlot = celdas.filter(b => b.fecha_hora_inicio.replace(' ', 'T').split('T')[1].substring(0, 5) === inicio);
                                                            const estaElegido = bloqueDerivacionSeleccionado && bloquesSlot.some(b => b.id_bloque === bloqueDerivacionSeleccionado.id_bloque);
                                                            return bloquesSlot.length > 0 ? (
                                                              <button
                                                                key={inicio}
                                                                type="button"
                                                                onClick={() => abrirSeleccionSlotDeriv(bloquesSlot)}
                                                                className={`h-[40px] flex flex-col justify-center items-center rounded text-[10px] border transition cursor-pointer ${estaElegido ? 'bg-green-600 text-white border-green-700 shadow-inner' : 'bg-green-100 hover:bg-green-200 border-green-500 text-green-900'}`}
                                                              >
                                                                <span className="font-bold">{inicio} - {fin}</span>
                                                                <span className="text-[9px] font-semibold">{estaElegido ? '✓ Elegida' : 'Disponible'}</span>
                                                              </button>
                                                            ) : (
                                                              <div
                                                                key={inicio}
                                                                className="h-[40px] flex flex-col justify-center items-center rounded text-[10px] border border-gray-200 bg-gray-50 text-gray-300"
                                                              >
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
                                      {mostrarPickerCampusDeriv && (
                                        <div className="mt-2 p-2 bg-white border border-blue-200 rounded shadow-sm">
                                          <p className="text-xs font-semibold text-gray-700 mb-1.5">📍 Selecciona el campus:</p>
                                          <div className="flex flex-col gap-1">
                                            {opcionesCampusDerivacion.map(opt => (
                                              <button key={opt.id} type="button"
                                                onClick={() => { setBloqueDerivacionSeleccionado(opt.bloque); setMostrarPickerCampusDeriv(false); setOpcionesCampusDerivacion([]); }}
                                                className="text-left px-3 py-1.5 rounded text-xs bg-blue-50 hover:bg-blue-100 border border-blue-200 text-blue-800"
                                              >
                                                📍 {opt.nombre}
                                              </button>
                                            ))}
                                          </div>
                                          <button type="button" onClick={() => setMostrarPickerCampusDeriv(false)}
                                            className="mt-1.5 text-xs text-gray-400 hover:text-gray-600 w-full text-center">
                                            Cancelar
                                          </button>
                                        </div>
                                      )}
                                    </>
                                  )}
                                </div>
                            )}
                          </div>
                        )}

                        {modoDerivacion === 'lista' && (
                          <div>
                            <div className="flex justify-between items-center mb-2">
                              <h4 className="font-bold text-gray-700 text-sm">Disponibilidad para Lista de Espera:</h4>
                              <button 
                                type="button"
                                onClick={() => { setBloqueDerivacionSeleccionado(null); setModoDerivacion('calendario'); }} 
                                className="text-blue-600 hover:underline text-xs font-bold"
                              >
                                ← Volver al calendario
                              </button>
                            </div>
                            <p className="text-xs text-gray-600 mb-2">Marca los horarios en que el estudiante podría asistir.</p>
                            {ubicacionesDeriv.length > 0 && (
                              <div className="mb-3 bg-blue-50 border border-blue-200 rounded p-2">
                                <p className="text-[10px] font-semibold text-blue-900 mb-1.5">📍 Campus por día (predeterminado; personalizable por hora)</p>
                                <div className="grid grid-cols-5 gap-1">
                                  {['lunes', 'martes', 'miercoles', 'jueves', 'viernes'].map(dia => (
                                    <div key={dia}>
                                      <p className="text-[9px] font-medium text-gray-600 mb-0.5 capitalize">{dia}</p>
                                      <div className="flex flex-wrap gap-0.5">
                                        {ubicacionesDeriv.map(u => {
                                          const activo = (campusPorDiaDeriv[dia] || []).includes(u.id_ubicacion);
                                          return (
                                            <button key={u.id_ubicacion} type="button"
                                              onClick={() => setCampusPorDiaDeriv(prev => {
                                                const act = prev[dia] || [];
                                                return { ...prev, [dia]: activo ? act.filter(id => id !== u.id_ubicacion) : [...act, u.id_ubicacion] };
                                              })}
                                              className={`px-1 py-0.5 text-[8px] rounded border transition ${activo ? 'bg-blue-600 text-white border-blue-700' : 'bg-white text-gray-500 border-gray-300 hover:border-blue-400'}`}
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
                            <div className="overflow-x-auto mb-2">
                              <table className="w-full min-w-[600px] table-fixed border-collapse border border-gray-300 text-xs">
                                <thead>
                                  <tr>
                                    <th className="w-16 p-1 border border-gray-300 bg-gray-100 text-xs">Hora</th>
                                    {['lunes', 'martes', 'miercoles', 'jueves', 'viernes'].map(dia => (
                                      <th key={dia} className="p-1 border border-gray-300 bg-gray-100 capitalize text-xs">{dia}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {horasGrilla.map(hora => {
                                    const startMin = parseInt(hora.split(':')[0], 10) * 60;
                                    const subSlots = [];
                                    for (let m = startMin; m + duracionDerivacion <= startMin + 60; m += duracionDerivacion) {
                                      const hh = String(Math.floor(m / 60)).padStart(2, '0');
                                      const mm = String(m % 60).padStart(2, '0');
                                      const endMin = m + duracionDerivacion;
                                      subSlots.push({
                                        inicio: `${hh}:${mm}`,
                                        fin: `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`
                                      });
                                    }
                                    return (
                                      <tr key={hora}>
                                        <td className="p-1 border border-gray-300 text-center font-bold text-gray-500 bg-gray-50 text-xs">{hora}</td>
                                        {['lunes', 'martes', 'miercoles', 'jueves', 'viernes'].map(dia => (
                                          <td key={`${dia}-${hora}`} className="border border-gray-300 p-1 align-top bg-white">
                                            <div className="flex flex-col gap-1">
                                              {subSlots.map(({ inicio, fin }) => {
                                                const hayDisponible = slotsConDisponibilidadDeriv.has(`${dia}|${inicio}`);
                                                const seleccionado = (disponibilidadDerivacion[dia] || []).includes(inicio);
                                                const campusSlot = campusPorSlotDeriv[`${dia}|${inicio}`] || [];
                                                const campusNombres = campusSlot.map(id => ubicacionesDeriv.find(u => u.id_ubicacion === id)?.abreviatura || '').filter(Boolean);
                                                if (hayDisponible && !seleccionado) {
                                                  return (
                                                    <div key={inicio}
                                                      title="Hay hora disponible. Vuelve al calendario para agendarla directamente."
                                                      className="h-[40px] flex flex-col justify-center items-center rounded text-[10px] border border-green-300 bg-green-50 text-green-700 cursor-not-allowed"
                                                    >
                                                      <span className="font-bold">{inicio} - {fin}</span>
                                                      <span className="text-[9px]">Hay hora</span>
                                                    </div>
                                                  );
                                                }
                                                return (
                                                  <div key={inicio}
                                                    onClick={() => handleSlotClickEsperaDeriv(dia, inicio, fin)}
                                                    className={`h-[40px] flex flex-col justify-center items-center rounded text-[10px] border transition cursor-pointer ${seleccionado ? 'bg-blue-600 text-white border-blue-700 shadow-inner' : 'hover:bg-blue-50 text-gray-300 border-gray-200 hover:border-blue-300 hover:text-blue-500'}`}
                                                  >
                                                    <span className="font-bold">{inicio} - {fin}</span>
                                                    {seleccionado && campusNombres.length > 0 && <span className="text-[8px] mt-0.5 opacity-90">{campusNombres.join(', ')}</span>}
                                                    {seleccionado && campusNombres.length === 0 && <span className="text-[8px] mt-0.5 opacity-75">cualquier sede</span>}
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
                            {Object.keys(disponibilidadDerivacion).length > 0 ? (
                               <p className="text-xs text-green-600 font-bold">✓ Disponibilidad registrada</p>
                            ) : (
                               <p className="text-xs text-red-500">Selecciona al menos un horario</p>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Cuestionario de ingreso si el servicio es Entrevista de Ingreso */}
                    {servicioDerivacionActual && esEntrevistaDerivacion && (
                      <div className="mt-4">
                        <FormularioMotivo
                          esEntrevista={true}
                          respuestas={encuestaDerivacion}
                          setRespuestas={setEncuestaDerivacion}
                          motivo={motiDeriv}
                          setMotivo={setMotiDeriv}
                          obligatorio={false}
                        />
                      </div>
                    )}

                    {/* Paso 3: Botón para agregar derivación */}
                    {servicioDerivacionActual && (
                      <button
                        type="button"
                        onClick={() => {
                          if (!bloqueDerivacionSeleccionado && Object.keys(disponibilidadDerivacion).length === 0) {
                            alert('Debes elegir una hora o una disponibilidad.');
                            return;
                          }
                          const servicioNombre = serviciosTotales.find(s => s.id_servicio === servicioDerivacionActual)?.nombre;
                          const motivoDer = esEntrevistaDerivacion
                            ? buildMotivoFinal(true, encuestaDerivacion, motiDeriv)
                            : null;
                          const nuevaDerivacion = {
                            id_servicio: servicioDerivacionActual,
                            nombre_servicio: servicioNombre,
                            id_bloque: bloqueDerivacionSeleccionado?.id_bloque || null,
                            hora_bloque: bloqueDerivacionSeleccionado?.fecha_hora_inicio || null,
                            disponibilidad: Object.keys(disponibilidadDerivacion).length > 0 ? disponibilidadDerivacion : null,
                            campus_indicados: (() => {
                              const todos = new Set();
                              Object.values(campusPorSlotDeriv).forEach(arr => (arr || []).forEach(id => todos.add(id)));
                              if (todos.size === 0) campusSeleccionadosDeriv.filter(c => c !== '__none__').forEach(id => todos.add(id));
                              return todos.size > 0 ? [...todos] : null;
                            })(),
                            motivo_consulta: motivoDer
                          };
                          setDerivacionesAgregadas([...derivacionesAgregadas, nuevaDerivacion]);

                          // Limpiar
                          setServicioDerivacionActual('');
                          setBloqueDerivacionSeleccionado(null);
                          setDisponibilidadDerivacion({});
                          setModoDerivacion('ninguno');
                          setEncuestaDerivacion({ q1: "0", q2: "0", q3: "0" });
                          setMotiDeriv('');
                          setCampusPorDiaDeriv({}); setCampusPorSlotDeriv({}); setSlotModalDeriv(null);
                          setMostrarPickerCampusDeriv(false); setOpcionesCampusDerivacion([]);
                        }}
                        className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-3 rounded transition mt-2 text-sm"
                      >
                        ✓ Agregar esta Derivación
                      </button>
                    )}

                    {/* Derivaciones ya agregadas */}
                    {derivacionesAgregadas.length > 0 && (
                      <div className="mt-4 p-3 bg-green-50 border border-green-300 rounded">
                        <h4 className="font-bold text-green-800 mb-2 text-sm">Derivaciones a realizar ({derivacionesAgregadas.length}):</h4>
                        <div className="space-y-2">
                          {derivacionesAgregadas.map((der, idx) => (
                            <div key={idx} className="flex justify-between items-start bg-white p-2 rounded border border-green-200">
                              <div className="text-sm">
                                <p className="font-semibold text-gray-800">{der.nombre_servicio}</p>
                                {der.hora_bloque ? (
                                  <p className="text-xs text-green-700">📅 Hora: {der.hora_bloque.replace('T', ' ').substring(0, 16)}</p>
                                ) : (
                                  <p className="text-xs text-orange-700">⏳ Lista de Espera - Disponible: {Object.keys(der.disponibilidad || {}).join(', ')}</p>
                                )}
                              </div>
                              <button
                                type="button"
                                onClick={() => setDerivacionesAgregadas(derivacionesAgregadas.filter((_, i) => i !== idx))}
                                className="text-red-600 hover:text-red-800 font-bold text-lg"
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="mb-6">
                    {atencionSeleccionada?.es_ciclico ? (
                      atencionSeleccionada?.es_ultima_sesion ? (
                        <div className="p-4 bg-amber-50 border border-amber-300 rounded">
                          <p className="text-amber-900 font-bold mb-1">🏁 Última sesión del ciclo</p>
                          <p className="text-amber-800 text-sm mb-3">
                            Este estudiante completó las sesiones de su ciclo
                            {atencionSeleccionada?.tope_sesiones ? ` (${atencionSeleccionada.tope_sesiones} sesiones)` : ''}.
                            Puedes otorgarle sesiones adicionales o cerrar el proceso (alta).
                          </p>
                          <label className="block text-gray-700 font-medium mb-2">¿Agregar más sesiones para este estudiante?</label>
                          <select
                            value={sesionesAdicionales}
                            onChange={(e) => setSesionesAdicionales(Number(e.target.value))}
                            className="w-full p-2 border border-gray-300 rounded text-sm outline-none"
                          >
                            <option value={0}>No agregar — Alta Médica / Cerrar Proceso</option>
                            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                              <option key={n} value={n}>Agregar {n} sesión{n > 1 ? 'es' : ''} más</option>
                            ))}
                          </select>
                          {sesionesAdicionales > 0 && (
                            <p className="text-green-700 text-xs mt-2">
                              Se agendarán {sesionesAdicionales} sesión{sesionesAdicionales > 1 ? 'es' : ''} adicional{sesionesAdicionales > 1 ? 'es' : ''} en el mismo horario semanal (según disponibilidad hasta fin de año).
                            </p>
                          )}
                        </div>
                      ) : (
                        <>
                          <label className="block text-gray-700 font-medium mb-2">Decisión de Continuidad *</label>
                          <select value={decisionContinuidad} onChange={(e) => setDecisionContinuidad(e.target.value)} required className="w-full p-2 border border-gray-300 rounded text-sm outline-none">
                            <option value="continuar">Continuar Proceso Clínico (Siguiente Sesión)</option>
                            <option value="cerrar_proceso">Alta Médica / Cerrar Proceso Clínico</option>
                          </select>
                        </>
                      )
                    ) : (
                      <div className="p-3 bg-blue-50 border border-blue-200 rounded text-blue-700 text-sm">
                        <strong>Nota:</strong> Este es un servicio de ingreso único. El proceso se cerrará automáticamente al guardar.
                      </div>
                    )}
                  </div>

                  <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded">
                    <label className="flex items-center space-x-2 cursor-pointer">
                      <input type="checkbox" checked={esCasoCritico} onChange={(e) => setEsCasoCritico(e.target.checked)} className="w-5 h-5 text-red-600 cursor-pointer" />
                      <span className="text-red-800 font-bold">Marcar como Caso Crítico (Activa protocolo de emergencia y cancela futuras horas)</span>
                    </label>
                  </div>

                  <button type="submit" className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded transition">
                    Guardar Evolución y Cerrar Sesión Clínica
                  </button>
                    </>
                  ) : (
                    <button type="submit" className="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-3 px-4 rounded transition mt-2">
                      Registrar Inasistencia y Cerrar Bloque
                    </button>
                  )}
                </form>
              )}
            </section>
          )}

          {pestañaActiva === 'buscador' && (
            <section className="flex flex-col md:flex-row gap-6">
              {/* Panel Izquierdo: Buscador */}
              <div className="md:w-1/3 md:border-r border-gray-200 md:pr-6">
                <h2 className="text-xl font-bold text-gray-800 mb-4">Buscar Paciente</h2>
                <input 
                  type="text" 
                  placeholder="Buscar por nombre o RUT..." 
                  value={busqueda}
                  onChange={(e) => setBusqueda(e.target.value)}
                  className="w-full p-2 border border-gray-300 rounded mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <div className="h-96 overflow-y-auto">
                  {cargandoEstudiantes ? (
                    <p className="text-gray-500 text-sm">Cargando pacientes...</p>
                  ) : (
                    estudiantesGlobal.filter(e => e.nombres.toLowerCase().includes(busqueda.toLowerCase()) || e.rut.includes(busqueda)).map(est => (
                      <div 
                        key={est.id_estudiante} 
                        onClick={() => seleccionarEstudiante(est)}
                        className={`p-3 border-b border-gray-100 cursor-pointer hover:bg-blue-50 transition ${estudianteSeleccionado?.id_estudiante === est.id_estudiante ? 'bg-blue-100 border-l-4 border-blue-600' : ''}`}
                      >
                        <p className="font-bold text-gray-800">{est.nombres} {est.apellidos}</p>
                        <p className="text-xs text-gray-500">RUT: {est.rut}</p>
                      </div>
                    ))
                  )}
                </div>
              </div>
              
              {/* Panel Derecho: Detalles e Historial */}
              <div className="md:w-2/3 mt-6 md:mt-0">
                {!estudianteSeleccionado ? (
                  <div className="flex items-center justify-center h-full text-gray-400">
                    Selecciona un paciente de la lista para ver su historial clínico completo.
                  </div>
                ) : (
                  <div>
                    <h2 className="text-2xl font-bold text-blue-900 mb-2">{estudianteSeleccionado.nombres} {estudianteSeleccionado.apellidos}</h2>
                    <p className="text-gray-600 mb-6">Carrera: {estudianteSeleccionado.carrera} | RUT: {estudianteSeleccionado.rut}</p>

                    <h3 className="text-lg font-bold text-gray-800 border-b pb-2 mb-4">Historial de Servicios Clínicos</h3>
                    <HistorialEstudiante
                      procesos={reservasEstudiante}
                      procesoExpandido={procesoExpandido}
                      onToggleProceso={setProcesoExpandido}
                    />
                  </div>
                )}
              </div>
            </section>
          )}
        </div>
      </main>

      {slotModalDeriv && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg p-4 max-w-xs w-full shadow-xl">
            <h4 className="font-bold text-gray-800 mb-1 text-sm capitalize">📍 Campus para {slotModalDeriv.dia} {slotModalDeriv.inicio}</h4>
            <p className="text-xs text-gray-500 mb-3">¿En qué campus podría asistir el estudiante en este horario?</p>
            <div className="flex flex-wrap gap-1.5 mb-4">
              {ubicacionesDeriv.map(u => {
                const activo = campusSlotTempDeriv.includes(u.id_ubicacion);
                return (
                  <button key={u.id_ubicacion} type="button"
                    onClick={() => setCampusSlotTempDeriv(prev => activo ? prev.filter(id => id !== u.id_ubicacion) : [...prev, u.id_ubicacion])}
                    className={`px-2 py-1 rounded-full text-xs font-medium border transition ${activo ? 'bg-blue-600 text-white border-blue-700' : 'bg-white text-gray-600 border-gray-300 hover:bg-blue-50'}`}
                  >
                    {activo ? '✓ ' : ''}{u.nombre}
                  </button>
                );
              })}
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={confirmarSlotEsperaDeriv}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-bold py-1.5 rounded text-sm transition">
                Confirmar
              </button>
              <button type="button" onClick={() => setSlotModalDeriv(null)}
                className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-1.5 rounded text-sm transition">
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {modalDetalle && bloqueDetalle && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg p-6 max-w-sm w-full shadow-xl">
            <h3 className="text-lg font-bold text-gray-900 mb-4">Detalle del Bloque</h3>
            <div className="space-y-2 text-sm text-gray-700">
              <div>
                <span className="font-semibold text-gray-500">Fecha:</span>{' '}
                {new Date(bloqueDetalle.fecha_hora_inicio.replace(' ', 'T')).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
              </div>
              <div>
                <span className="font-semibold text-gray-500">Hora:</span>{' '}
                {bloqueDetalle.fecha_hora_inicio.replace(' ', 'T').split('T')[1].substring(0, 5)}
                {bloqueDetalle.fecha_hora_fin ? ` — ${bloqueDetalle.fecha_hora_fin.replace(' ', 'T').split('T')[1].substring(0, 5)}` : ''}
              </div>
              <div>
                <span className="font-semibold text-gray-500">Servicio:</span>{' '}
                {bloqueDetalle.servicio?.nombre || '—'}
              </div>
              <div>
                <span className="font-semibold text-gray-500">Campus:</span>{' '}
                {bloqueDetalle.ubicacion?.nombre || 'Sin ubicación'}
              </div>
              <div>
                <span className="font-semibold text-gray-500">Estado:</span>{' '}
                <span className="capitalize">{bloqueDetalle.estado}</span>
              </div>
              {(bloqueDetalle.estudiante_nombres || bloqueDetalle.estudiante_apellidos) && (
                <div>
                  <span className="font-semibold text-gray-500">Paciente:</span>{' '}
                  {`${bloqueDetalle.estudiante_nombres || ''} ${bloqueDetalle.estudiante_apellidos || ''}`.trim()}
                </div>
              )}
            </div>
            <button
              onClick={() => { setModalDetalle(false); setBloqueDetalle(null); }}
              className="mt-6 w-full bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-2 px-4 rounded transition"
            >
              Cerrar
            </button>
          </div>
        </div>
      )}

      {modalEliminar && bloqueAEliminar && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg p-6 max-w-sm w-full shadow-xl">
            <h3 className="text-lg font-bold text-gray-900 mb-2">Eliminar Disponibilidad</h3>
            <p className="text-gray-600 mb-6 text-sm">
        Has seleccionado el bloque del <strong>{new Date(bloqueAEliminar.fecha_hora_inicio).toLocaleDateString()}</strong> a las <strong>{bloqueAEliminar.fecha_hora_inicio.replace(' ', 'T').split('T')[1].substring(0, 5)}</strong>.
              <br/><br/>
              ¿Deseas eliminar solo esta hora, o también las de las semanas siguientes en este mismo horario?
            </p>
            
            <div className="flex flex-col gap-3">
              <button 
                onClick={() => ejecutarEliminacion(false)}
                className="bg-blue-100 hover:bg-blue-200 text-blue-800 font-bold py-2 px-4 rounded transition"
              >
                Eliminar solo este bloque
              </button>
              <button 
                onClick={() => ejecutarEliminacion(true)}
                className="bg-red-100 hover:bg-red-200 text-red-800 font-bold py-2 px-4 rounded transition"
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
    </div>
  );
}