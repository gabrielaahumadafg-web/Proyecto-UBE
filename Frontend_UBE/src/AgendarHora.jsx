import { useState, useEffect, useMemo } from 'react';
import { API_URL } from './config';
import { getLunes, getBlocksForCell, deduplicateCyclicBlocks, getSlotsConDisponibilidad } from './utils/calendarUtils';

export default function AgendarHora({ session }) {
  const [paso, setPaso] = useState(1);
  const [servicios, setServicios] = useState([]);
  const [servicioSeleccionado, setServicioSeleccionado] = useState(null);
  const [bloques, setBloques] = useState([]);
  const [reservasPendientes, setReservasPendientes] = useState([]);
  const [esperasPendientes, setEsperasPendientes] = useState([]);
  const [suspensionesActivas, setSuspensionesActivas] = useState([]); // [{ id_servicio, fecha_fin, servicio_nombre }]
  
  // Estados para Lista de Espera y Reservas
  const [bloqueSeleccionado, setBloqueSeleccionado] = useState(null);
  const [motivoReserva, setMotivoReserva] = useState('');
  const [motivo, setMotivo] = useState('');
  const [disponibilidad, setDisponibilidad] = useState({}); // Formato: { lunes: ["09:00", "10:00"], martes: ["15:00"] }
  const [campusSeleccionados, setCampusSeleccionados] = useState([]); // ids de ubicación que le sirven al beneficiario (+ '__none__' para sin ubicación)
  const [opcionesCampusSlot, setOpcionesCampusSlot] = useState([]); // campus disponibles en el slot que el beneficiario presionó en la grilla

  // Estados para campus por slot (paso 3 lista de espera)
  const [campusPorDiaEspera, setCampusPorDiaEspera] = useState({});  // { "lunes": ["uuid1"], ... }
  const [campusPorSlotEspera, setCampusPorSlotEspera] = useState({}); // { "lunes|09:00": ["uuid1"], ... }
  const [slotModalEspera, setSlotModalEspera] = useState(null);       // { dia, inicio, fin } | null
  const [campusSlotTempEspera, setCampusSlotTempEspera] = useState([]);
  const [ubicacionesTodas, setUbicacionesTodas] = useState([]);

  // Estado para la encuesta de Triage (Solo para Entrevista de Ingreso)
  const [respuestasEncuesta, setRespuestasEncuesta] = useState({ q1: "0", q2: "0", q3: "0" });
  const esEntrevistaIngreso = useMemo(() => {
    return servicioSeleccionado?.nombre?.toLowerCase().includes('entrevista de ingreso');
  }, [servicioSeleccionado]);

  const diasSemana = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'];
  const horasOpciones = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];

  const duracionMin = servicioSeleccionado?.duracion_minutos || 60;

  // Utilidades del Calendario
  // getLunes importado de utils/calendarUtils

  const [fechaBaseSemana, setFechaBaseSemana] = useState(getLunes(new Date()));

  const cambiarSemana = (dias) => {
    const nueva = new Date(fechaBaseSemana);
    nueva.setDate(nueva.getDate() + dias);
    setFechaBaseSemana(nueva);
  };

  useEffect(() => {
    // Al cargar el componente, traemos los servicios
    fetch(`${API_URL}/servicios`) // Sin headers para evitar error CORS
      .then(res => res.ok ? res.json() : [])
      .then(data => {
        const arrValido = Array.isArray(data) ? data : (data?.data || []);
        // Ocultar Psicología del agendamiento directo por estudiante (solo por derivación)
        const serviciosPermitidos = arrValido.filter(srv => !srv.nombre.toLowerCase().includes('psicolog'));
        setServicios(serviciosPermitidos);
      })
      .catch(err => console.error(err));

    // Traemos las reservas actuales del estudiante para bloquear servicios que ya tienen reserva pendiente
    if (session?.access_token) {
      fetch(`${API_URL}/mis_reservas`, {
        headers: { "Authorization": `Bearer ${session.access_token}` }
      })
        .then(res => res.json())
        .then(data => {
          if (Array.isArray(data)) {
            const pendientes = data
              .filter(r => r.estado === 'pendiente')
              .map(r => r.servicio_nombre);
            setReservasPendientes(pendientes);
          }
        })
        .catch(err => console.error(err));

      // Traemos las listas de espera actuales del estudiante para bloquear esos servicios también
      fetch(`${API_URL}/mis_esperas`, {
        headers: { "Authorization": `Bearer ${session.access_token}` }
      })
        .then(res => res.json())
        .then(data => {
          if (Array.isArray(data)) {
            const esperas = data.map(e => e.servicio.nombre);
            setEsperasPendientes(esperas);
          }
        })
        .catch(err => console.error(err));

      // Suspensiones activas del estudiante
      fetch(`${API_URL}/mis_suspensiones`, {
        headers: { "Authorization": `Bearer ${session.access_token}` }
      })
        .then(res => res.ok ? res.json() : [])
        .then(data => { if (Array.isArray(data)) setSuspensionesActivas(data); })
        .catch(err => console.error(err));
    }
  }, []);

  // Cargar todas las ubicaciones activas al entrar al paso 3 (lista de espera)
  useEffect(() => {
    if (paso === 3 && ubicacionesTodas.length === 0) {
      fetch(`${API_URL}/ubicaciones?activo=true`)
        .then(r => r.ok ? r.json() : [])
        .then(setUbicacionesTodas)
        .catch(console.error);
    }
  }, [paso]);

  const seleccionarServicio = async (servicio) => {
    setServicioSeleccionado(servicio);
    setPaso(2);
    setFechaBaseSemana(getLunes(new Date())); // Resetea el calendario a la semana actual
    
    // Buscar disponibilidad para este servicio
    try {
      const respuesta = await fetch(`${API_URL}/disponibilidad?id_servicio=${servicio.id_servicio}`, {
        headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      if (respuesta.ok) {
        const data = await respuesta.json();
        const arrValido = Array.isArray(data) ? data : (data?.data || []);
        setBloques(arrValido);
        // Por defecto, todos los campus con disponibilidad quedan seleccionados.
        const campusIds = [...new Set(arrValido.map(b => b.ubicacion?.id_ubicacion || '__none__'))];
        setCampusSeleccionados(campusIds);
      } else {
        setBloques([]);
        setCampusSeleccionados([]);
      }
    } catch (error) {
      console.error("Error obteniendo disponibilidad:", error);
      setBloques([]);
    }
  };

  // Campus distintos con disponibilidad para el servicio elegido.
  const campusDisponibles = useMemo(() => {
    const map = new Map();
    (Array.isArray(bloques) ? bloques : []).forEach(b => {
      const id = b.ubicacion?.id_ubicacion || '__none__';
      if (!map.has(id)) map.set(id, b.ubicacion?.nombre || 'Sin ubicación');
    });
    return Array.from(map, ([id, nombre]) => ({ id, nombre }));
  }, [bloques]);

  const toggleCampus = (id) => {
    setCampusSeleccionados(prev =>
      prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]
    );
  };

  // Filtra por campus elegido y luego colapsa los bloques cíclicos (solo el primero de cada serie).
  const bloquesFiltrados = useMemo(() => {
    const base = (Array.isArray(bloques) ? bloques : [])
      .filter(b => campusSeleccionados.includes(b.ubicacion?.id_ubicacion || '__none__'));
    return deduplicateCyclicBlocks(base, servicioSeleccionado?.es_ciclico);
  }, [bloques, campusSeleccionados, servicioSeleccionado]);

  const getBloquesDisponiblesEnGrilla = (diaIndex, hora) =>
    getBlocksForCell(bloquesFiltrados, fechaBaseSemana, diaIndex, hora);

  // Slots (día+hora) que YA tienen una hora disponible para los campus elegidos:
  // se deshabilitan en la grilla de lista de espera (hay que reservarlos directo).
  const slotsConDisponibilidad = useMemo(
    () => getSlotsConDisponibilidad(bloquesFiltrados),
    [bloquesFiltrados]
  );

  // Al presionar un slot de la grilla: agrupa los bloques de ese horario por campus
  // (un representante por campus). Si hay un solo campus, lo deja preseleccionado;
  // si hay varios, el beneficiario elige el campus en el paso de confirmación.
  const abrirSeleccionSlot = (bloquesEnSlot) => {
    const map = new Map();
    bloquesEnSlot.forEach(b => {
      const id = b.ubicacion?.id_ubicacion || '__none__';
      if (!map.has(id)) {
        map.set(id, { id, nombre: b.ubicacion?.nombre || 'Sin ubicación', bloque: b });
      }
    });
    const opciones = Array.from(map.values());
    setOpcionesCampusSlot(opciones);
    setBloqueSeleccionado(opciones.length === 1 ? opciones[0].bloque : null);
    setPaso(4);
  };

  const handleSlotClickEspera = (dia, inicio, fin) => {
    const yaSeleccionado = (disponibilidad[dia] || []).includes(inicio);
    if (yaSeleccionado) {
      setDisponibilidad(prev => {
        const nueva = { ...prev };
        nueva[dia] = nueva[dia].filter(h => h !== inicio);
        if (nueva[dia].length === 0) delete nueva[dia];
        return nueva;
      });
      setCampusPorSlotEspera(prev => { const n = { ...prev }; delete n[`${dia}|${inicio}`]; return n; });
    } else {
      setSlotModalEspera({ dia, inicio, fin });
      setCampusSlotTempEspera([...(campusPorDiaEspera[dia] || [])]);
    }
  };

  const confirmarSlotEspera = () => {
    if (!slotModalEspera) return;
    const { dia, inicio } = slotModalEspera;
    setDisponibilidad(prev => {
      const nueva = { ...prev };
      if (!nueva[dia]) nueva[dia] = [];
      if (!nueva[dia].includes(inicio)) nueva[dia] = [...nueva[dia], inicio];
      return nueva;
    });
    setCampusPorSlotEspera(prev => ({ ...prev, [`${dia}|${inicio}`]: campusSlotTempEspera }));
    setSlotModalEspera(null);
  };

  const unirseListaEspera = async () => {
    const diasSeleccionados = Object.keys(disponibilidad);
    if (diasSeleccionados.length === 0) {
      alert("Por favor, selecciona al menos un horario en el que tengas disponibilidad.");
      return;
    }

    let motivoFinal = motivo;
    let puntajeTriage = null;

    if (esEntrevistaIngreso) {
      puntajeTriage = parseInt(respuestasEncuesta.q1) + parseInt(respuestasEncuesta.q2) + parseInt(respuestasEncuesta.q3);
      motivoFinal = `[Encuesta Triage - Puntaje: ${puntajeTriage}/9]\n1. Decaimiento/Tristeza: Nivel ${respuestasEncuesta.q1}\n2. Afectación Académica: Nivel ${respuestasEncuesta.q2}\n3. Estrés/Ansiedad: Nivel ${respuestasEncuesta.q3}\nExtras: ${motivo}`;
    }

    try {
      const respuesta = await fetch(`${API_URL}/lista_espera`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`
        },
        body: JSON.stringify({
          id_servicio: servicioSeleccionado.id_servicio,
          disponibilidad_indicada: disponibilidad,
          // campus_indicados = unión de todos los campus elegidos por slot
          campus_indicados: (() => {
            const todos = new Set();
            Object.values(campusPorSlotEspera).forEach(arr => (arr || []).forEach(id => todos.add(id)));
            // fallback: si no hay campus_por_slot, usar los campus globales del paso 2
            if (todos.size === 0) campusSeleccionados.filter(c => c !== '__none__').forEach(id => todos.add(id));
            return todos.size > 0 ? [...todos] : null;
          })(),
          campus_por_slot: Object.keys(campusPorSlotEspera).length > 0 ? campusPorSlotEspera : null,
          motivo_consulta: motivoFinal,
          puntaje_triage: puntajeTriage
        })
      });

      const data = await respuesta.json();
      if (respuesta.ok) {
        alert("¡Anotado exitosamente en la lista de espera!");
        // Actualizamos las esperas pendientes localmente para deshabilitar la tarjeta
        setEsperasPendientes(prev => [...prev, servicioSeleccionado.nombre]);
        setPaso(1); // Volver al inicio
        setDisponibilidad({}); setMotivo('');
        setCampusPorSlotEspera({}); setCampusPorDiaEspera({}); setSlotModalEspera(null);
      } else {
        alert("Error: " + data.detail);
      }
    } catch (error) {
      console.error(error);
    }
  };

  const confirmarReserva = async () => {
    if (!motivoReserva.trim()) {
      alert("Por favor, ingresa la observación adicional.");
      return;
    }

    let motivoFinal = motivoReserva;
    let puntajeTriage = null;

    if (esEntrevistaIngreso) {
      puntajeTriage = parseInt(respuestasEncuesta.q1) + parseInt(respuestasEncuesta.q2) + parseInt(respuestasEncuesta.q3);
      motivoFinal = `[Encuesta Triage - Puntaje: ${puntajeTriage}/9]\n1. Decaimiento/Tristeza: Nivel ${respuestasEncuesta.q1}\n2. Afectación Académica: Nivel ${respuestasEncuesta.q2}\n3. Estrés/Ansiedad: Nivel ${respuestasEncuesta.q3}\nExtras: ${motivoReserva}`;
    }

    try {
      const respuesta = await fetch(`${API_URL}/reservar`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`
        },
        body: JSON.stringify({
          id_bloque: bloqueSeleccionado.id_bloque,
          motivo_consulta: motivoFinal,
          puntaje_triage: puntajeTriage
        })
      });
      const data = await respuesta.json();
      if (respuesta.ok) {
        alert("¡Reserva confirmada exitosamente!");
        // Actualizamos las reservas pendientes localmente para deshabilitar la tarjeta
        setReservasPendientes(prev => [...prev, servicioSeleccionado.nombre]);
        setPaso(1); setBloqueSeleccionado(null); setMotivoReserva(''); setOpcionesCampusSlot([]);
      } else {
        alert("Error al reservar: " + data.detail);
      }
    } catch (error) {
      console.error(error);
    }
  };

  const renderFormularioMotivo = (valorTextarea, setterTextarea, esObligatorio) => {
    if (esEntrevistaIngreso) {
      return (
        <div className="mb-6 space-y-4 bg-gray-50 p-4 rounded border border-gray-200">
          <h4 className="font-bold text-gray-800">Breve Cuestionario de Ingreso</h4>
          <p className="text-sm text-gray-600 mb-2">Por favor, responde estas 3 breves preguntas para entender mejor tu situación antes de la cita.</p>
          
          <div>
            <label className="block text-sm font-semibold mb-1">1. ¿En las últimas 2 semanas, con qué frecuencia te has sentido decaído, triste o sin esperanza?</label>
            <select value={respuestasEncuesta.q1} onChange={(e) => setRespuestasEncuesta({...respuestasEncuesta, q1: e.target.value})} className="w-full p-2 border rounded text-sm bg-white">
              <option value="0">Nunca o casi nunca</option>
              <option value="1">Varios días</option>
              <option value="2">Más de la mitad de los días</option>
              <option value="3">Casi todos los días</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-semibold mb-1">2. ¿Sientes que tus dificultades actuales están afectando tu rendimiento académico (notas, asistencia)?</label>
            <select value={respuestasEncuesta.q2} onChange={(e) => setRespuestasEncuesta({...respuestasEncuesta, q2: e.target.value})} className="w-full p-2 border rounded text-sm bg-white">
              <option value="0">No me afecta mayormente</option>
              <option value="1">Me afecta un poco</option>
              <option value="2">Me afecta bastante</option>
              <option value="3">Siento que voy a reprobar / No puedo asistir a clases</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-semibold mb-1">3. ¿Cómo evaluarías tu nivel de ansiedad o estrés en el último mes?</label>
            <select value={respuestasEncuesta.q3} onChange={(e) => setRespuestasEncuesta({...respuestasEncuesta, q3: e.target.value})} className="w-full p-2 border rounded text-sm bg-white">
              <option value="0">Bajo / Normal</option>
              <option value="1">Moderado (generalmente controlable)</option>
              <option value="2">Alto (difícil de controlar)</option>
              <option value="3">Crítico / Constante angustia inmanejable</option>
            </select>
          </div>
          <div className="mt-4">
            <label className="block text-sm font-semibold mb-1">¿Algo más que desees agregar? (Opcional)</label>
            <textarea value={valorTextarea} onChange={(e) => setterTextarea(e.target.value)} rows="2" className="w-full p-2 border rounded text-sm"></textarea>
          </div>
        </div>
      );
    }
    return (
      <div className="mb-6">
        <label className="block font-bold text-gray-700 mb-2">{esObligatorio ? "Motivo de Consulta *" : "Breve motivo de consulta (opcional)"}</label>
        <textarea value={valorTextarea} onChange={(e) => setterTextarea(e.target.value)} rows="3" placeholder="Ej: Problemas de ansiedad, control de rutina..." className="w-full p-3 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 outline-none" />
      </div>
    );
  };

  return (
    <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
      <h2 className="text-2xl font-bold text-blue-900 mb-4">Agendar Nueva Hora</h2>
      <hr className="mb-6 opacity-20" />

      {/* PASO 1: Seleccionar Servicio */}
      {paso === 1 && (
        <div>
          <p className="text-gray-700 mb-4 font-medium">Selecciona la especialidad en la que buscas atención:</p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {servicios.map(srv => {
              const tieneReserva = reservasPendientes.includes(srv.nombre);
              const tieneEspera = esperasPendientes.includes(srv.nombre);
              const suspension = suspensionesActivas.find(s => s.id_servicio === srv.id_servicio);
              const estaBloqueado = tieneReserva || tieneEspera || !!suspension;
              const titleAttr = suspension
                ? `Estás suspendido de este servicio hasta ${new Date(suspension.fecha_fin).toLocaleDateString('es-CL')}`
                : tieneReserva ? "Ya tienes una reserva activa para este servicio."
                : tieneEspera ? "Ya estás en lista de espera para este servicio." : "";
              return (
                <div
                  key={srv.id_servicio}
                  onClick={() => !estaBloqueado && seleccionarServicio(srv)}
                  className={`p-5 bg-white border rounded-lg shadow-sm transition transform ${
                    estaBloqueado
                      ? "border-red-200 bg-red-50 opacity-75 cursor-not-allowed"
                      : "border-gray-200 hover:shadow-md cursor-pointer hover:-translate-y-1"
                  }`}
                  title={titleAttr}
                >
                  <h3 className={`text-lg font-bold mb-2 ${estaBloqueado ? "text-red-700" : "text-blue-800"}`}>{srv.nombre}</h3>
                  <span className="text-xs font-semibold bg-gray-100 text-gray-600 px-2 py-1 rounded">
                    {srv.es_ciclico ? "Tratamiento / Cíclico" : "Atención Única"}
                  </span>
                  {suspension && (
                    <div className="mt-3 bg-red-100 border border-red-300 rounded p-2">
                      <p className="text-xs text-red-700 font-bold">🚫 Acceso suspendido</p>
                      <p className="text-xs text-red-600 mt-0.5">
                        No puedes agendar ni inscribirte en lista de espera hasta el{' '}
                        <strong>{new Date(suspension.fecha_fin).toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' })}</strong>.
                      </p>
                    </div>
                  )}
                  {!suspension && tieneReserva && (
                    <p className="text-xs text-red-600 font-semibold mt-3">Ya tienes una cita pendiente para este servicio</p>
                  )}
                  {!suspension && tieneEspera && (
                    <p className="text-xs text-orange-600 font-semibold mt-3">Ya estás en la lista de espera para este servicio</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* PASO 2: Ver Calendario y Disponibilidad */}
      {paso === 2 && (
        <div>
          <button onClick={() => setPaso(1)} className="text-blue-600 font-semibold mb-4 hover:underline">← Volver a especialidades</button>
          
          <div className="bg-blue-50 p-4 rounded-lg mb-6 flex flex-col md:flex-row justify-between items-center gap-4">
            <div>
              <h3 className="text-lg font-bold text-blue-900">Horarios para {servicioSeleccionado.nombre}</h3>
              <p className="text-sm text-gray-600">Presiona la fecha y el bloque en el calendario para reservar.</p>
            </div>
            <button
              onClick={() => { setDisponibilidad({}); setPaso(3); }}
              className="bg-yellow-500 hover:bg-yellow-600 text-white px-4 py-2 rounded font-bold shadow transition"
            >
              No me sirven estas horas (Lista de Espera)
            </button>
          </div>

          {campusDisponibles.length > 1 && (
            <div className="mb-6 bg-white border border-gray-200 rounded-lg p-4">
              <p className="text-sm font-semibold text-gray-700 mb-2">📍 ¿Qué campus te sirven? (selecciona uno o más)</p>
              <div className="flex flex-wrap gap-2">
                {campusDisponibles.map(c => {
                  const activo = campusSeleccionados.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      onClick={() => toggleCampus(c.id)}
                      className={`px-3 py-1.5 rounded-full text-sm font-medium border transition ${
                        activo
                          ? 'bg-blue-600 text-white border-blue-700'
                          : 'bg-white text-gray-600 border-gray-300 hover:bg-blue-50'
                      }`}
                    >
                      {activo ? '✓ ' : ''}{c.nombre}
                    </button>
                  );
                })}
              </div>
              {campusSeleccionados.length === 0 && (
                <p className="text-xs text-red-500 mt-2">Selecciona al menos un campus para ver horarios.</p>
              )}
            </div>
          )}

          {bloques.length === 0 ? (
            <div className="p-10 text-center border-2 border-dashed border-gray-300 rounded-lg">
              <h3 className="text-lg font-bold text-red-600 mb-2">No hay horas disponibles en este momento</h3>
              <p className="text-gray-600 mb-4">Te recomendamos anotarte en la lista de espera para ser notificado cuando se libere un espacio.</p>
              <button onClick={() => { setDisponibilidad({}); setPaso(3); }} className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded transition">
                Anotarme en Lista de Espera
              </button>
            </div>
          ) : (
            <div>
              <div className="flex justify-between items-center mb-4">
                <h4 className="font-bold text-gray-700">Selecciona tu hora:</h4>
                <div className="flex space-x-2">
                  <button onClick={() => cambiarSemana(-7)} className="px-3 py-1 bg-gray-200 rounded hover:bg-gray-300 font-bold">&larr; Ant</button>
                  <span className="px-4 py-1 font-semibold border rounded bg-white">
                    Semana del {fechaBaseSemana.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })}
                  </span>
                  <button onClick={() => cambiarSemana(7)} className="px-3 py-1 bg-gray-200 rounded hover:bg-gray-300 font-bold">Sig &rarr;</button>
                </div>
              </div>

              <div className="overflow-x-auto pb-4">
                <table className="w-full min-w-[800px] table-fixed border-collapse border-2 border-gray-300 text-sm bg-white">
                  <thead>
                    <tr>
                      <th className="w-20 p-2 border-2 border-gray-300 bg-gray-100 text-gray-700">Hora</th>
                      {diasSemana.map((dia, i) => {
                        const fechaHeader = new Date(fechaBaseSemana);
                        fechaHeader.setDate(fechaBaseSemana.getDate() + i);
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
                            const bloquesCelda = getBloquesDisponiblesEnGrilla(i, hora);
                            return (
                              <td key={i} className="border-2 border-gray-300 p-1 align-top bg-white">
                                <div className="flex flex-col gap-1">
                                  {subSlots.map(({ inicio, fin }) => {
                                    const bloquesEnSlot = bloquesCelda.filter(b => b.fecha_hora_inicio.replace(' ', 'T').split('T')[1].substring(0, 5) === inicio);
                                    return bloquesEnSlot.length > 0 ? (
                                      <button
                                        key={inicio}
                                        onClick={() => abrirSeleccionSlot(bloquesEnSlot)}
                                        className="h-[40px] flex flex-col justify-center items-center bg-green-100 hover:bg-green-200 border border-green-500 text-green-900 rounded text-[10px] text-center shadow-sm transition cursor-pointer"
                                      >
                                        <span className="font-bold">{inicio} - {fin}</span>
                                        <span className="font-semibold text-[9px]">Disponible</span>
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
            </div>
          )}
        </div>
      )}

      {/* PASO 3: Formulario Lista de Espera */}
      {paso === 3 && (
        <div>
          <button onClick={() => setPaso(2)} className="text-blue-600 font-semibold mb-4 hover:underline">← Volver a horarios</button>
          
          <h3 className="text-xl font-bold text-blue-900 mb-2">Inscripción a Lista de Espera</h3>
          <p className="text-gray-600 mb-2">Marca en la grilla todas las horas en las que podrías asistir para publicarlas. El sistema te emparejará automáticamente cuando se libere un cupo.</p>
          <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded p-3 mb-6">Los horarios marcados como <strong>"Hay hora"</strong> (en verde) ya tienen cupo disponible: no puedes anotarlos en la lista de espera, vuelve atrás para reservarlos directamente.</p>

          {/* Barra de campus por día */}
          {ubicacionesTodas.length > 0 && (
            <div className="mb-4 bg-blue-50 border border-blue-200 rounded-lg p-3">
              <p className="text-xs font-semibold text-blue-900 mb-2">📍 Campus por día — define el predeterminado; al presionar cada hora podrás personalizar</p>
              <div className="grid grid-cols-5 gap-2">
                {diasSemana.map(dia => (
                  <div key={dia}>
                    <p className="text-[10px] font-medium text-gray-600 mb-1 capitalize">{dia}</p>
                    <div className="flex flex-wrap gap-1">
                      {ubicacionesTodas.map(u => {
                        const activo = (campusPorDiaEspera[dia] || []).includes(u.id_ubicacion);
                        return (
                          <button key={u.id_ubicacion} type="button"
                            onClick={() => setCampusPorDiaEspera(prev => {
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

          <div className="overflow-x-auto mb-6">
            <table className="w-full min-w-[800px] table-fixed border-collapse border-2 border-gray-300 text-sm">
              <thead>
                <tr>
                  <th className="w-20 p-2 border-2 border-gray-300 bg-gray-100">Hora</th>
                  {diasSemana.map(dia => (
                    <th key={dia} className="p-2 border-2 border-gray-300 bg-gray-100 font-bold capitalize text-gray-700">{dia}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {['08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00'].map(hora => {
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
                      <td className="p-2 border-2 border-gray-300 text-center font-bold text-gray-500 bg-gray-50 text-xs w-20">
                        {hora}
                      </td>
                      {diasSemana.map(dia => (
                        <td key={`${dia}-${hora}`} className="border-2 border-gray-300 p-1 align-top bg-white">
                          <div className="flex flex-col gap-1">
                            {subSlots.map(({ inicio, fin }) => {
                              const hayDisponible = slotsConDisponibilidad.has(`${dia}|${inicio}`);
                              const seleccionado = (disponibilidad[dia] || []).includes(inicio);
                              const campusSlot = campusPorSlotEspera[`${dia}|${inicio}`] || [];
                              const campusNombres = campusSlot.map(id => ubicacionesTodas.find(u => u.id_ubicacion === id)?.abreviatura || ubicacionesTodas.find(u => u.id_ubicacion === id)?.nombre?.substring(0, 4) || '').filter(Boolean);
                              if (hayDisponible && !seleccionado) {
                                return (
                                  <div key={inicio}
                                    title="Hay una hora disponible. Vuelve atrás para reservarla directamente."
                                    className="h-[40px] flex flex-col justify-center items-center rounded text-[10px] border border-green-300 bg-green-50 text-green-700 cursor-not-allowed"
                                  >
                                    <span className="font-bold">{inicio} - {fin}</span>
                                    <span className="text-[9px]">Hay hora</span>
                                  </div>
                                );
                              }
                              return (
                                <div key={inicio} onClick={() => handleSlotClickEspera(dia, inicio, fin)}
                                  className={`h-[40px] flex flex-col justify-center items-center rounded text-[10px] border transition cursor-pointer ${
                                    seleccionado
                                      ? 'bg-blue-600 text-white border-blue-700 shadow-inner'
                                      : 'hover:bg-blue-50 text-gray-300 border-gray-200 hover:border-blue-300 hover:text-blue-500'
                                  }`}
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

          {renderFormularioMotivo(motivo, setMotivo, false)}

          <button 
            onClick={unirseListaEspera} 
            disabled={Object.keys(disponibilidad).length === 0}
            className={`w-full font-bold py-3 rounded transition text-lg shadow-md ${Object.keys(disponibilidad).length > 0 ? 'bg-blue-600 hover:bg-blue-700 text-white' : 'bg-gray-300 text-gray-500 cursor-not-allowed'}`}
          >
            {Object.keys(disponibilidad).length > 0 ? `Publicar y Unirme a la Lista de Espera` : 'Selecciona horarios en la grilla para continuar'}
          </button>
        </div>
      )}

      {/* PASO 4: Selección / Confirmación de Campus */}
      {paso === 4 && opcionesCampusSlot.length > 0 && (
        <div className="max-w-lg mx-auto bg-white p-6 border border-gray-200 rounded-lg shadow-sm">
          <button onClick={() => setPaso(2)} className="text-blue-600 font-semibold mb-4 hover:underline">← Cambiar Hora</button>

          <h3 className="text-xl font-bold text-blue-900 mb-4">
            {opcionesCampusSlot.length === 1 ? 'Confirmar Campus' : 'Seleccionar Campus'}
          </h3>

          <div className="bg-blue-50 p-4 rounded-lg mb-6 border border-blue-100">
            <p className="mb-2"><strong className="text-blue-800">Especialidad:</strong> {servicioSeleccionado.nombre}</p>
            <p className="mb-0">
              <strong className="text-blue-800">Fecha y Hora:</strong>{' '}
              <span className="capitalize">
                {new Date(opcionesCampusSlot[0].bloque.fecha_hora_inicio).toLocaleString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
            </p>
          </div>

          {opcionesCampusSlot.length === 1 ? (
            <div className="mb-6 bg-green-50 border border-green-200 rounded-lg p-4 flex items-center gap-3">
              <span className="text-2xl">📍</span>
              <div>
                <p className="text-sm text-gray-500 mb-0.5">Campus de atención</p>
                <p className="font-bold text-green-800 text-lg">{opcionesCampusSlot[0].nombre}</p>
              </div>
            </div>
          ) : (
            <div className="mb-6">
              <label className="block font-bold text-gray-700 mb-2">📍 ¿En qué campus prefieres atenderte?</label>
              <p className="text-sm text-gray-500 mb-3">Esta hora está disponible en más de un campus. Elige dónde prefieres asistir.</p>
              <div className="flex flex-wrap gap-2">
                {opcionesCampusSlot.map(opt => {
                  const activo = bloqueSeleccionado?.id_bloque === opt.bloque.id_bloque;
                  return (
                    <button
                      key={opt.id}
                      onClick={() => setBloqueSeleccionado(opt.bloque)}
                      className={`px-4 py-2 rounded-full text-sm font-medium border transition ${
                        activo
                          ? 'bg-blue-600 text-white border-blue-700'
                          : 'bg-white text-gray-700 border-gray-300 hover:bg-blue-50'
                      }`}
                    >
                      {activo ? '✓ ' : ''}{opt.nombre}
                    </button>
                  );
                })}
              </div>
              {!bloqueSeleccionado && (
                <p className="text-xs text-red-500 mt-2">Selecciona un campus para continuar.</p>
              )}
            </div>
          )}

          <button
            onClick={() => setPaso(5)}
            disabled={!bloqueSeleccionado}
            className={`w-full font-bold py-3 px-4 rounded text-lg shadow transition ${bloqueSeleccionado ? 'bg-blue-600 hover:bg-blue-700 text-white' : 'bg-gray-300 text-gray-500 cursor-not-allowed'}`}
          >
            {bloqueSeleccionado ? 'Continuar' : 'Selecciona un campus para continuar'}
          </button>
        </div>
      )}

      {/* PASO 5: Motivo de Consulta y Confirmación Final */}
      {paso === 5 && bloqueSeleccionado && (
        <div className="max-w-lg mx-auto bg-white p-6 border border-gray-200 rounded-lg shadow-sm">
          <button onClick={() => setPaso(4)} className="text-blue-600 font-semibold mb-4 hover:underline">← Cambiar Campus</button>

          <h3 className="text-xl font-bold text-blue-900 mb-4">Confirmar Reserva</h3>

          <div className="bg-blue-50 p-4 rounded-lg mb-6 border border-blue-100">
            <p className="mb-2"><strong className="text-blue-800">Especialidad:</strong> {servicioSeleccionado.nombre}</p>
            <p className="mb-2"><strong className="text-blue-800">Profesional:</strong> Asignación automática por disponibilidad</p>
            <p className="mb-2">
              <strong className="text-blue-800">Fecha y Hora:</strong>{' '}
              <span className="capitalize">
                {new Date(bloqueSeleccionado.fecha_hora_inicio).toLocaleString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
            </p>
            <p className="mb-0"><strong className="text-blue-800">Campus:</strong> {bloqueSeleccionado.ubicacion?.nombre || 'Sin ubicación'}</p>
          </div>

          {renderFormularioMotivo(motivoReserva, setMotivoReserva, true)}

          <button
            onClick={confirmarReserva}
            className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-3 px-4 rounded text-lg shadow transition"
          >
            Confirmar Cita
          </button>
        </div>
      )}

      {/* Modal de selección de campus al agregar un slot en paso 3 (lista de espera) */}
      {slotModalEspera && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-sm w-full mx-4">
            <h3 className="font-bold text-gray-800 mb-1">¿Qué campus te sirven?</h3>
            <p className="text-sm text-gray-500 mb-4 capitalize">{slotModalEspera.dia} · {slotModalEspera.inicio} – {slotModalEspera.fin}</p>
            <div className="flex flex-wrap gap-2 mb-3">
              {ubicacionesTodas.map(u => {
                const activo = campusSlotTempEspera.includes(u.id_ubicacion);
                return (
                  <button key={u.id_ubicacion} type="button"
                    onClick={() => setCampusSlotTempEspera(prev => activo ? prev.filter(id => id !== u.id_ubicacion) : [...prev, u.id_ubicacion])}
                    className={`px-3 py-1.5 rounded-full text-sm font-semibold border transition ${activo ? 'bg-blue-600 text-white border-blue-700' : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400'}`}
                  >
                    {u.nombre}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-gray-500 mb-3">
              {campusSlotTempEspera.length === 0 ? 'Sin selección = cualquier campus puede asignarte en este horario.' : ''}
            </p>
            {(campusPorDiaEspera[slotModalEspera.dia] || []).length > 0 && (
              <button type="button"
                onClick={() => setCampusSlotTempEspera([...(campusPorDiaEspera[slotModalEspera.dia] || [])])}
                className="text-xs text-blue-600 hover:underline mb-4 block"
              >
                ← Usar campus del día ({(campusPorDiaEspera[slotModalEspera.dia] || []).map(id => ubicacionesTodas.find(u => u.id_ubicacion === id)?.nombre).filter(Boolean).join(', ')})
              </button>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={confirmarSlotEspera} className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 rounded">Añadir</button>
              <button type="button" onClick={() => setSlotModalEspera(null)} className="flex-1 bg-gray-200 hover:bg-gray-300 text-gray-700 font-bold py-2 rounded">Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}