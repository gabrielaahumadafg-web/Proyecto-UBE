import { useState, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { API_URL } from './config';
import { supabase } from './supabaseClient';
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend
} from 'recharts';

// Paleta consistente con los badges de % del resto del dashboard.
const COLOR_PRESENTE = '#22c55e';
const COLOR_ATRASO = '#facc15';
const COLOR_AUSENTE = '#ef4444';
const COLOR_BARRA = '#2563eb';
const COLORES_CARRERA = ['#2563eb', '#0ea5e9', '#6366f1', '#8b5cf6', '#14b8a6', '#f59e0b', '#ef4444', '#10b981'];

const fmtFecha = (d) => d.toISOString().split('T')[0];

export default function DashboardProfesionalApoyo({ session }) {
  const [pestañaActiva, setPestañaActiva] = useState('inicio');

  // Estados para el Reporte de Ocupación
  const [fechaInicio, setFechaInicio] = useState('');
  const [fechaFin, setFechaFin] = useState('');
  const [filtroServicio, setFiltroServicio] = useState('');
  const [filtroProfesional, setFiltroProfesional] = useState('');

  const [serviciosTotales, setServiciosTotales] = useState([]);
  const [profesionalesTotales, setProfesionalesTotales] = useState([]);
  const [reporteOcupacion, setReporteOcupacion] = useState([]);
  const [cargandoReporte, setCargandoReporte] = useState(false);
  const [exportando, setExportando] = useState(false);

  // Estados para el Resumen Global
  const [resumen, setResumen] = useState({ activos: 0, espera: 0, criticos: 0 });
  const [atencionesEspecialidad, setAtencionesEspecialidad] = useState([]);

  // Estados para Ocupación Actual
  const [ocupacionActual, setOcupacionActual] = useState([]);
  const [cargandoOcupacionActual, setCargandoOcupacionActual] = useState(false);

  // Estados para Estadísticas y Demanda
  const [asistencias, setAsistencias] = useState({ presente: 0, ausente: 0, atraso: 0 });
  const [carreras, setCarreras] = useState([]);
  const [ocupacionSemanal, setOcupacionSemanal] = useState([]);
  const [cargandoEstadisticas, setCargandoEstadisticas] = useState(false);

  // Estados para Ocupación / Espera (pestaña nueva)
  const inicioAnio = `${new Date().getFullYear()}-01-01`;
  const hoyISO = fmtFecha(new Date());
  const [fechaOcupIni, setFechaOcupIni] = useState(inicioAnio);
  const [fechaOcupFin, setFechaOcupFin] = useState(hoyISO);
  const [ocupacionEspecialidad, setOcupacionEspecialidad] = useState([]);
  const [ocupacionGeneral, setOcupacionGeneral] = useState({ total: 0, ocupados: 0, porcentaje: 0 });
  const [esperaComparativa, setEsperaComparativa] = useState(null);
  const [cargandoOcupEspera, setCargandoOcupEspera] = useState(false);

  const authHeaders = { Authorization: `Bearer ${session.access_token}` };

  // Cargar datos base al iniciar
  useEffect(() => {
    const fetchDatosBase = async () => {
      try {
        const res = await fetch(`${API_URL}/servicios`);
        if (res.ok) setServiciosTotales(await res.json());

        const resResumen = await fetch(`${API_URL}/reportes/resumen_global`, { headers: authHeaders });
        if (resResumen.ok) setResumen(await resResumen.json());

        const resProf = await fetch(`${API_URL}/profesionales_activos`, { headers: authHeaders });
        if (resProf.ok) setProfesionalesTotales(await resProf.json());
      } catch (e) {
        console.error("Error al cargar datos base", e);
      }
    };
    fetchDatosBase();
  }, [session.access_token]);

  const generarReporte = async () => {
    if (!fechaInicio || !fechaFin) return alert("Selecciona fecha de inicio y fin para el reporte.");
    setCargandoReporte(true);
    try {
      let url = `${API_URL}/reportes/ocupacion?fecha_inicio=${fechaInicio}T00:00:00&fecha_fin=${fechaFin}T23:59:59`;
      if (filtroServicio) url += `&id_servicio=${filtroServicio}`;
      if (filtroProfesional) url += `&id_profesional=${filtroProfesional}`;

      const res = await fetch(url, { headers: authHeaders });
      if (res.ok) setReporteOcupacion(await res.json());
      else alert("Error al generar el reporte.");
    } catch (e) { console.error(e); } finally { setCargandoReporte(false); }
  };

  // Separa una fecha/hora ISO ("2026-06-22T08:20:00") en { fecha, hora } sin desfase de zona horaria.
  const splitFechaHora = (iso) => {
    if (!iso) return { fecha: '', hora: '' };
    const [f, h = ''] = String(iso).replace('Z', '').split('T');
    return { fecha: f, hora: h.slice(0, 5) };
  };

  // Aplana disponibilidad_indicada { "lunes": ["08:20","08:40"] } -> "lunes: 08:20, 08:40 | martes: ..."
  const fmtDisponibilidad = (disp) => {
    if (!disp || typeof disp !== 'object') return '';
    return Object.entries(disp)
      .map(([dia, horas]) => `${dia}: ${(Array.isArray(horas) ? horas : []).join(', ')}`)
      .join(' | ');
  };

  // Exporta una base de datos completa como Excel multi-hoja:
  //  - "Reservas": 1 fila por reserva (pasadas, futuras y canceladas).
  //  - "Lista de Espera": 1 fila por estudiante esperando oferta (sin reserva asignada).
  //  - "Cuestionarios": anexo enlazado desde cada Entrevista de Ingreso (de ambas hojas).
  const exportarReservasExcel = async () => {
    setExportando(true);
    try {
      const params = [];
      if (fechaInicio) params.push(`fecha_inicio=${fechaInicio}T00:00:00`);
      if (fechaFin) params.push(`fecha_fin=${fechaFin}T23:59:59`);
      if (filtroServicio) params.push(`id_servicio=${filtroServicio}`);
      const qsEspera = params.join('&'); // la lista de espera no usa filtro de profesional
      if (filtroProfesional) params.push(`id_profesional=${filtroProfesional}`);
      const qsReservas = params.join('&');

      const [resRes, resEsp] = await Promise.all([
        fetch(`${API_URL}/reportes/reservas_detalle${qsReservas ? `?${qsReservas}` : ''}`, { headers: authHeaders }),
        fetch(`${API_URL}/reportes/lista_espera_detalle${qsEspera ? `?${qsEspera}` : ''}`, { headers: authHeaders }),
      ]);

      if (!resRes.ok) { alert('Error al generar la base de reservas.'); return; }
      const datos = await resRes.json();
      const espera = resEsp.ok ? await resEsp.json() : [];

      if (!datos.length && !espera.length) {
        alert('No hay reservas ni lista de espera para los filtros seleccionados.');
        return;
      }

      // Anexo de cuestionarios compartido entre Reservas y Lista de Espera.
      const cuestionariosAoa = [['Anexo ID', 'Origen', 'Estudiante', 'RUT', 'Especialidad', 'Fecha', 'Puntaje Triage', 'Cuestionario Completo']];
      let anexoSeq = 0;
      const addAnexo = (origen, r, fechaStr) => {
        anexoSeq += 1;
        const anexoId = `C${String(anexoSeq).padStart(3, '0')}`;
        cuestionariosAoa.push([anexoId, origen, r.estudiante, r.rut, r.servicio, fechaStr, r.puntaje_triage ?? '', r.motivo_consulta]);
        return cuestionariosAoa.length; // fila Excel (1-based) del anexo recién agregado
      };

      const wb = XLSX.utils.book_new();

      // --- Hoja "Reservas" ---
      const headersRes = [
        'ID Reserva', 'Fecha Reserva', 'Fecha Atención', 'Hora Atención', 'Profesional',
        'Especialidad', 'Ubicación', 'Estudiante', 'RUT', 'Carrera', 'Asistencia', 'Estado',
        'Registro Atención', 'Caso Crítico', 'Puntaje Triage', 'Sesiones', 'Inasistencias',
        'Motivo de Consulta', 'Diagnóstico', 'Observaciones', 'Plan de Tratamiento',
        'Derivación', 'ID Reserva Derivada', 'Anexo Cuestionario',
      ];
      const ANEXO_COL_RES = headersRes.length - 1;
      const reservasAoa = [headersRes];
      const linksRes = [];

      datos.forEach((r) => {
        const { fecha, hora } = splitFechaHora(r.fecha_hora_inicio);
        const { fecha: fechaReserva } = splitFechaHora(r.fecha_creacion);
        const motivo = r.motivo_consulta || '';
        let motivoCol = motivo;
        let anexoCol = '';
        let anexoRow = null;
        if (r.es_entrevista_ingreso && motivo) {
          motivoCol = motivo.split('\n')[0] || 'Cuestionario de Ingreso';
          anexoCol = 'Ver cuestionario →';
          anexoRow = addAnexo('Reserva', r, fecha);
        }
        reservasAoa.push([
          r.id_reserva, fechaReserva, fecha, hora, r.profesional, r.servicio, r.ubicacion, r.estudiante,
          r.rut, r.carrera, r.asistencia, r.estado_reserva, r.registro_atencion,
          r.es_caso_critico, r.puntaje_triage ?? '', r.sesiones_realizadas, r.inasistencias_acumuladas,
          motivoCol, r.diagnostico, r.observaciones, r.plan_tratamiento,
          r.derivacion_servicio, r.derivacion_destino, anexoCol,
        ]);
        if (anexoRow) linksRes.push({ dataRow: reservasAoa.length, anexoRow });
      });

      const wsReservas = XLSX.utils.aoa_to_sheet(reservasAoa);
      linksRes.forEach(({ dataRow, anexoRow }) => {
        const addr = XLSX.utils.encode_cell({ c: ANEXO_COL_RES, r: dataRow - 1 });
        if (wsReservas[addr]) wsReservas[addr].l = { Target: `#Cuestionarios!A${anexoRow}`, Tooltip: 'Ver cuestionario en anexo' };
      });
      wsReservas['!cols'] = [14, 12, 12, 7, 22, 22, 22, 12, 22, 11, 24, 18, 11, 8, 8, 11, 40, 30, 30, 30, 20, 16, 18].map((wch) => ({ wch }));
      XLSX.utils.book_append_sheet(wb, wsReservas, 'Reservas');

      // --- Hoja "Lista de Espera" ---
      if (espera.length) {
        const headersEsp = [
          'Fecha Ingreso', 'Estudiante', 'RUT', 'Carrera', 'Especialidad', 'Prioritario',
          'Estado Oferta', 'Estado Revisión', 'Puntaje Triage', 'Disponibilidad Indicada',
          'Motivo de Consulta', 'Anexo Cuestionario',
        ];
        const ANEXO_COL_ESP = headersEsp.length - 1;
        const esperaAoa = [headersEsp];
        const linksEsp = [];

        espera.forEach((r) => {
          const { fecha } = splitFechaHora(r.fecha_ingreso);
          const motivo = r.motivo_consulta || '';
          let motivoCol = motivo;
          let anexoCol = '';
          let anexoRow = null;
          if (r.es_entrevista_ingreso && motivo) {
            motivoCol = motivo.split('\n')[0] || 'Cuestionario de Ingreso';
            anexoCol = 'Ver cuestionario →';
            anexoRow = addAnexo('Lista de Espera', r, fecha);
          }
          esperaAoa.push([
            fecha, r.estudiante, r.rut, r.carrera, r.servicio, r.es_prioritario,
            r.estado_oferta, r.estado_revision, r.puntaje_triage ?? '',
            fmtDisponibilidad(r.disponibilidad_indicada), motivoCol, anexoCol,
          ]);
          if (anexoRow) linksEsp.push({ dataRow: esperaAoa.length, anexoRow });
        });

        const wsEspera = XLSX.utils.aoa_to_sheet(esperaAoa);
        linksEsp.forEach(({ dataRow, anexoRow }) => {
          const addr = XLSX.utils.encode_cell({ c: ANEXO_COL_ESP, r: dataRow - 1 });
          if (wsEspera[addr]) wsEspera[addr].l = { Target: `#Cuestionarios!A${anexoRow}`, Tooltip: 'Ver cuestionario en anexo' };
        });
        wsEspera['!cols'] = [13, 22, 12, 22, 22, 11, 14, 14, 8, 32, 40, 18].map((wch) => ({ wch }));
        XLSX.utils.book_append_sheet(wb, wsEspera, 'Lista de Espera');
      }

      // --- Hoja "Cuestionarios" (anexo) ---
      if (cuestionariosAoa.length > 1) {
        const wsCuest = XLSX.utils.aoa_to_sheet(cuestionariosAoa);
        wsCuest['!cols'] = [10, 16, 22, 12, 22, 12, 12, 90].map((wch) => ({ wch }));
        XLSX.utils.book_append_sheet(wb, wsCuest, 'Cuestionarios');
      }

      const hoy = new Date().toISOString().split('T')[0];
      const rango = fechaInicio && fechaFin ? `${fechaInicio}_a_${fechaFin}` : `al_${hoy}`;
      XLSX.writeFile(wb, `Reservas_UBE_${rango}.xlsx`);
    } catch (e) {
      console.error('Error al exportar reservas', e);
      alert('Error al exportar la base de reservas.');
    } finally {
      setExportando(false);
    }
  };

  // --- Resumen Global: atenciones por especialidad (deriva de /reportes/ocupacion) ---
  const fetchAtencionesEspecialidad = async () => {
    try {
      const hoy = new Date();
      const fin = new Date();
      fin.setDate(fin.getDate() + 30);
      const url = `${API_URL}/reportes/ocupacion?fecha_inicio=${fmtFecha(hoy)}T00:00:00&fecha_fin=${fmtFecha(fin)}T23:59:59`;
      const res = await fetch(url, { headers: authHeaders });
      if (!res.ok) return;
      const datos = await res.json();
      // Agrupar por id_servicio (evita colisiones entre servicios homónimos).
      const porServicio = {};
      datos.forEach(({ id_servicio, servicio, bloques_ocupados }) => {
        if (!porServicio[id_servicio]) porServicio[id_servicio] = { servicio, atenciones: 0 };
        porServicio[id_servicio].atenciones += bloques_ocupados;
      });
      setAtencionesEspecialidad(Object.values(porServicio));
    } catch (e) {
      console.error('Error al cargar atenciones por especialidad', e);
    }
  };

  const fetchOcupacionActual = async () => {
    setCargandoOcupacionActual(true);
    try {
      const hoy = new Date();
      const fin = new Date();
      fin.setDate(fin.getDate() + 6); // +6 => 7 días de calendario, sin repetir el día de la semana actual
      const url = `${API_URL}/reportes/ocupacion?fecha_inicio=${fmtFecha(hoy)}T00:00:00&fecha_fin=${fmtFecha(fin)}T23:59:59`;
      const res = await fetch(url, { headers: authHeaders });
      if (!res.ok) return;
      const datos = await res.json();
      // Agrupar por id_profesional (dos profesionales pueden compartir el mismo nombre).
      const porProfesional = {};
      datos.forEach(({ id_profesional, profesional, total_bloques, bloques_ocupados }) => {
        if (!porProfesional[id_profesional]) porProfesional[id_profesional] = { id: id_profesional, nombre: profesional, total: 0, ocupados: 0 };
        porProfesional[id_profesional].total += total_bloques;
        porProfesional[id_profesional].ocupados += bloques_ocupados;
      });
      const lista = Object.values(porProfesional).map((d) => ({
        id: d.id,
        nombre: d.nombre,
        total: d.total,
        ocupados: d.ocupados,
        porcentaje: d.total > 0 ? Math.round((d.ocupados / d.total) * 100) : 0,
      })).sort((a, b) => a.porcentaje - b.porcentaje);
      setOcupacionActual(lista);
    } catch (e) {
      console.error('Error al cargar ocupación actual', e);
    } finally {
      setCargandoOcupacionActual(false);
    }
  };

  // --- Estadísticas: asistencias, carreras y ocupación semanal ---
  const fetchEstadisticas = async () => {
    setCargandoEstadisticas(true);
    try {
      // Ventana de 8 semanas centrada en hoy (recientes + próximas).
      const ini = new Date(); ini.setDate(ini.getDate() - 28);
      const fin = new Date(); fin.setDate(fin.getDate() + 28);
      const rango = `fecha_inicio=${fmtFecha(ini)}T00:00:00&fecha_fin=${fmtFecha(fin)}T23:59:59`;
      const filtros = `${filtroServicio ? `&id_servicio=${filtroServicio}` : ''}${filtroProfesional ? `&id_profesional=${filtroProfesional}` : ''}`;

      const [resSem, resAsist, resCarr] = await Promise.all([
        fetch(`${API_URL}/reportes/ocupacion_semanal?${rango}${filtros}`, { headers: authHeaders }),
        fetch(`${API_URL}/reportes/asistencias?${rango}${filtros}`, { headers: authHeaders }),
        fetch(`${API_URL}/reportes/distribucion_carreras${filtroServicio ? `?id_servicio=${filtroServicio}` : ''}`, { headers: authHeaders }),
      ]);

      if (resSem.ok) setOcupacionSemanal(await resSem.json());
      if (resAsist.ok) setAsistencias(await resAsist.json());
      if (resCarr.ok) setCarreras(await resCarr.json());
    } catch (e) {
      console.error('Error al cargar estadísticas', e);
    } finally {
      setCargandoEstadisticas(false);
    }
  };

  // --- Ocupación / Espera: % ocupación por especialidad + comparación de días de espera ---
  const fetchOcupacionEspera = async () => {
    setCargandoOcupEspera(true);
    try {
      const rango = `fecha_inicio=${fechaOcupIni}T00:00:00&fecha_fin=${fechaOcupFin}T23:59:59`;

      const [resOcup, resEspera] = await Promise.all([
        fetch(`${API_URL}/reportes/ocupacion?${rango}`, { headers: authHeaders }),
        fetch(`${API_URL}/reportes/espera_comparativa?${rango}`, { headers: authHeaders }),
      ]);

      // Métrica 1: agrupar la ocupación (por profesional+servicio) en % por especialidad.
      if (resOcup.ok) {
        const datos = await resOcup.json();
        const porServicio = {};
        datos.forEach(({ id_servicio, servicio, total_bloques, bloques_ocupados }) => {
          if (!porServicio[id_servicio]) porServicio[id_servicio] = { servicio, total: 0, ocupados: 0 };
          porServicio[id_servicio].total += total_bloques;
          porServicio[id_servicio].ocupados += bloques_ocupados;
        });
        const lista = Object.values(porServicio).map((d) => ({
          servicio: d.servicio,
          total: d.total,
          ocupados: d.ocupados,
          porcentaje: d.total > 0 ? Math.round((d.ocupados / d.total) * 100) : 0,
        })).sort((a, b) => b.porcentaje - a.porcentaje);
        setOcupacionEspecialidad(lista);

        const totalGen = lista.reduce((s, d) => s + d.total, 0);
        const ocupGen = lista.reduce((s, d) => s + d.ocupados, 0);
        setOcupacionGeneral({
          total: totalGen,
          ocupados: ocupGen,
          porcentaje: totalGen > 0 ? Math.round((ocupGen / totalGen) * 100) : 0,
        });
      }

      // Métrica 2: días de espera por reserva vs por lista de espera.
      if (resEspera.ok) setEsperaComparativa(await resEspera.json());
    } catch (e) {
      console.error('Error al cargar ocupación / espera', e);
    } finally {
      setCargandoOcupEspera(false);
    }
  };

  useEffect(() => {
    if (pestañaActiva === 'inicio') fetchAtencionesEspecialidad();
    if (pestañaActiva === 'ocupacion_actual') fetchOcupacionActual();
    if (pestañaActiva === 'estadisticas') fetchEstadisticas();
    if (pestañaActiva === 'ocupacion_espera') fetchOcupacionEspera();
  }, [pestañaActiva]);

  const cerrarSesion = async () => {
    await supabase.auth.signOut();
  };

  const tabClass = (v) =>
    `px-4 py-2 rounded-t-lg font-medium whitespace-nowrap flex-shrink-0 ${
      pestañaActiva === v
        ? 'bg-blue-100 text-blue-800 border-b-4 border-blue-600'
        : 'text-gray-500 hover:text-blue-600 hover:bg-gray-100'
    }`;

  const datosAsistencia = [
    { name: 'Presentes', value: asistencias.presente, color: COLOR_PRESENTE },
    { name: 'Atrasos', value: asistencias.atraso, color: COLOR_ATRASO },
    { name: 'Ausentes', value: asistencias.ausente, color: COLOR_AUSENTE },
  ].filter(d => d.value > 0);

  return (
    <div className="min-h-screen bg-gray-100 text-gray-800">
      {/* Navbar Superior */}
      <header className="text-white p-4 shadow-md flex justify-between items-center" style={{ backgroundColor: '#003366' }}>
        <h1 className="text-lg md:text-xl font-bold">Portal de Apoyo UBE</h1>
        <div className="flex items-center gap-4">
          <span className="text-sm hidden sm:inline">{session?.user?.email}</span>
          <button onClick={cerrarSesion} className="bg-red-600 hover:bg-red-700 text-white text-sm font-bold py-2 px-3 rounded">
            Cerrar Sesión
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4 md:p-6">
        {/* Navegación por pestañas */}
        <div className="flex space-x-2 border-b-2 border-gray-200 mb-6 pb-2 overflow-x-auto">
          <button onClick={() => setPestañaActiva('inicio')} className={tabClass('inicio')}>Resumen Global</button>
          <button onClick={() => setPestañaActiva('ocupacion_actual')} className={tabClass('ocupacion_actual')}>Ocupación Actual</button>
          <button onClick={() => setPestañaActiva('ocupacion_espera')} className={tabClass('ocupacion_espera')}>Ocupación / Espera</button>
          <button onClick={() => setPestañaActiva('reportes_clinicos')} className={tabClass('reportes_clinicos')}>Reportes Clínicos</button>
          <button onClick={() => setPestañaActiva('estadisticas')} className={tabClass('estadisticas')}>Estadísticas y Demanda</button>
        </div>

        {pestañaActiva === 'inicio' && (
          <div>
            <h1 className="text-2xl md:text-3xl font-bold text-blue-900 mb-2">Bienvenido, Profesional de Apoyo</h1>
            <p className="text-gray-600 mb-8">Desde este panel podrás visualizar los datos y generar reportes para la toma de decisiones.</p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
              <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200 border-l-4 border-l-blue-500">
                <h3 className="text-gray-500 font-semibold mb-1">Pacientes Activos Totales</h3>
                <p className="text-3xl font-bold text-gray-800">{resumen.activos}</p>
                <p className="text-xs text-gray-500 mt-2 font-medium">Con tratamiento en curso</p>
              </div>
              <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200 border-l-4 border-l-yellow-500">
                <h3 className="text-gray-500 font-semibold mb-1">En Lista de Espera</h3>
                <p className="text-3xl font-bold text-gray-800">{resumen.espera}</p>
                <p className="text-xs text-orange-600 mt-2 font-medium">Esperando oferta de hora</p>
              </div>
              <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200 border-l-4 border-l-red-500">
                <h3 className="text-gray-500 font-semibold mb-1">Casos Críticos / Triage</h3>
                <p className="text-3xl font-bold text-gray-800">{resumen.criticos}</p>
                <p className="text-xs text-red-600 mt-2 font-medium">Marcados en histórico</p>
              </div>
            </div>

            {/* Gráfico: Atenciones por especialidad (próximos 30 días) */}
            <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200 mb-6">
              <h3 className="font-bold text-gray-800 mb-1">Atenciones por Especialidad</h3>
              <p className="text-xs text-gray-500 mb-4">Horas ocupadas en los próximos 30 días</p>
              {atencionesEspecialidad.length === 0 ? (
                <div className="h-64 flex items-center justify-center text-gray-400 italic">Sin datos para mostrar.</div>
              ) : (
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={atencionesEspecialidad} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="servicio" tick={{ fontSize: 12 }} interval={0} angle={-15} textAnchor="end" height={60} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                    <Tooltip />
                    <Bar dataKey="atenciones" name="Atenciones" fill={COLOR_BARRA} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        )}

        {pestañaActiva === 'ocupacion_actual' && (() => {
          const hoy = new Date();
          const fin = new Date();
          fin.setDate(fin.getDate() + 6); // coincide con la ventana de fetchOcupacionActual (7 días de calendario)
          const fmtLabel = (d) => d.toLocaleDateString('es-CL', { day: 'numeric', month: 'short' });
          return (
            <div className="max-w-4xl mx-auto">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h1 className="text-2xl md:text-3xl font-bold text-blue-900">Ocupación Actual</h1>
                  <p className="text-gray-500 text-sm mt-1">Del {fmtLabel(hoy)} al {fmtLabel(fin)} · próximos 7 días</p>
                </div>
                <button
                  onClick={fetchOcupacionActual}
                  disabled={cargandoOcupacionActual}
                  className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded transition text-sm"
                >
                  {cargandoOcupacionActual ? 'Actualizando...' : '↻ Actualizar'}
                </button>
              </div>

              {cargandoOcupacionActual ? (
                <div className="flex justify-center py-20 text-gray-400">Cargando...</div>
              ) : ocupacionActual.length === 0 ? (
                <div className="bg-white rounded-lg border border-dashed border-gray-300 p-12 text-center text-gray-500">
                  No hay bloques publicados para los próximos 7 días.
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  {ocupacionActual.map((prof) => {
                    const colorClass = prof.porcentaje >= 80 ? 'bg-green-500' : prof.porcentaje >= 50 ? 'bg-yellow-400' : 'bg-red-500';
                    const badgeClass = prof.porcentaje >= 80 ? 'bg-green-100 text-green-800' : prof.porcentaje >= 50 ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800';
                    return (
                      <div key={prof.id} className="bg-white rounded-lg border border-gray-200 shadow-sm p-5">
                        <div className="flex items-center justify-between mb-3">
                          <span className="font-semibold text-gray-800 text-lg">{prof.nombre}</span>
                          <span className={`px-3 py-1 rounded-full font-bold text-sm ${badgeClass}`}>{prof.porcentaje}%</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="flex-1 bg-gray-100 rounded-full h-4 overflow-hidden">
                            <div className={`h-4 rounded-full transition-all ${colorClass}`} style={{ width: `${prof.porcentaje}%` }} />
                          </div>
                          <span className="text-sm text-gray-600 whitespace-nowrap font-medium">
                            {prof.ocupados} / {prof.total} horas reservadas
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })()}

        {pestañaActiva === 'ocupacion_espera' && (
          <div>
            <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3 mb-6">
              <div>
                <h1 className="text-2xl md:text-3xl font-bold text-blue-900">Ocupación y Espera</h1>
                <p className="text-gray-500 text-sm mt-1">% de horas ocupadas por especialidad y días de espera según el camino de reserva</p>
              </div>
              <div className="flex flex-wrap gap-2 items-end">
                <div>
                  <label className="block text-xs font-bold text-gray-600 mb-1">Desde</label>
                  <input type="date" value={fechaOcupIni} onChange={(e) => setFechaOcupIni(e.target.value)} className="p-2 border border-gray-300 rounded text-sm outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-600 mb-1">Hasta</label>
                  <input type="date" value={fechaOcupFin} onChange={(e) => setFechaOcupFin(e.target.value)} className="p-2 border border-gray-300 rounded text-sm outline-none" />
                </div>
                <button onClick={fetchOcupacionEspera} disabled={cargandoOcupEspera} className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded text-sm">
                  {cargandoOcupEspera ? 'Cargando...' : 'Aplicar'}
                </button>
              </div>
            </div>

            {/* Métrica 1: % ocupación por especialidad + general */}
            <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200 mb-6">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-4 gap-2">
                <div>
                  <h3 className="font-bold text-gray-800">% de Ocupación por Especialidad</h3>
                  <p className="text-xs text-gray-500">De las horas publicadas en el rango, cuántas se ocuparon (reservadas/confirmadas)</p>
                </div>
                <div className="flex items-center gap-3 bg-blue-50 border border-blue-100 rounded-lg px-4 py-2">
                  <div className="text-right">
                    <p className="text-xs text-gray-500 font-medium">Ocupación general</p>
                    <p className="text-xs text-gray-400">{ocupacionGeneral.ocupados} / {ocupacionGeneral.total} horas</p>
                  </div>
                  <span className={`px-3 py-1 rounded-full font-bold text-lg ${ocupacionGeneral.porcentaje >= 80 ? 'bg-green-100 text-green-800' : ocupacionGeneral.porcentaje >= 50 ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800'}`}>
                    {ocupacionGeneral.porcentaje}%
                  </span>
                </div>
              </div>
              {cargandoOcupEspera ? (
                <div className="h-72 flex items-center justify-center text-gray-400">Cargando...</div>
              ) : ocupacionEspecialidad.length === 0 ? (
                <div className="h-72 flex items-center justify-center text-gray-400 italic">Sin horas publicadas en el rango seleccionado.</div>
              ) : (
                <ResponsiveContainer width="100%" height={Math.max(288, ocupacionEspecialidad.length * 46)}>
                  <BarChart data={ocupacionEspecialidad} layout="vertical" margin={{ top: 5, right: 40, bottom: 5, left: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" domain={[0, 100]} unit="%" tick={{ fontSize: 12 }} />
                    <YAxis type="category" dataKey="servicio" width={130} tick={{ fontSize: 11 }} interval={0} />
                    <Tooltip formatter={(v, _n, p) => [`${v}%  (${p.payload.ocupados}/${p.payload.total} horas)`, 'Ocupación']} />
                    <Bar dataKey="porcentaje" name="Ocupación" radius={[0, 4, 4, 0]}>
                      {ocupacionEspecialidad.map((d) => (
                        <Cell key={d.servicio} fill={d.porcentaje >= 80 ? COLOR_PRESENTE : d.porcentaje >= 50 ? COLOR_ATRASO : COLOR_AUSENTE} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Métrica 2: días de espera por reserva vs lista de espera */}
            <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
              <h3 className="font-bold text-gray-800 mb-1">Días de Espera: Reserva vs Lista de Espera</h3>
              <p className="text-xs text-gray-500 mb-4">
                <strong>Por reserva:</strong> días entre reservar y la cita. <strong>Por lista de espera:</strong> días acumulados de quienes siguen esperando una hora.
              </p>
              {cargandoOcupEspera ? (
                <div className="h-72 flex items-center justify-center text-gray-400">Cargando...</div>
              ) : !esperaComparativa ? (
                <div className="h-72 flex items-center justify-center text-gray-400 italic">Sin datos de espera.</div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  <div className="lg:col-span-2">
                    <ResponsiveContainer width="100%" height={288}>
                      <BarChart
                        data={[
                          { nombre: 'Por Reserva', dias: esperaComparativa.reserva.total_dias, color: COLOR_BARRA },
                          { nombre: 'Por Lista de Espera', dias: esperaComparativa.lista_espera.total_dias, color: COLOR_ATRASO },
                        ]}
                        margin={{ top: 5, right: 20, bottom: 5, left: 0 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="nombre" tick={{ fontSize: 12 }} />
                        <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                        <Tooltip formatter={(v) => [`${v} días`, 'Total acumulado']} />
                        <Bar dataKey="dias" name="Días acumulados" radius={[4, 4, 0, 0]}>
                          <Cell fill={COLOR_BARRA} />
                          <Cell fill={COLOR_ATRASO} />
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="flex flex-col gap-4 justify-center">
                    <div className="bg-blue-50 border border-blue-100 rounded-lg p-4">
                      <p className="text-sm font-bold text-blue-900 mb-1">Por Reserva</p>
                      <p className="text-2xl font-bold text-gray-800">{esperaComparativa.reserva.total_dias} <span className="text-sm font-medium text-gray-500">días</span></p>
                      <p className="text-xs text-gray-500 mt-1">{esperaComparativa.reserva.cantidad} reservas · {esperaComparativa.reserva.promedio} días promedio</p>
                    </div>
                    <div className="bg-yellow-50 border border-yellow-100 rounded-lg p-4">
                      <p className="text-sm font-bold text-yellow-800 mb-1">Por Lista de Espera</p>
                      <p className="text-2xl font-bold text-gray-800">{esperaComparativa.lista_espera.total_dias} <span className="text-sm font-medium text-gray-500">días</span></p>
                      <p className="text-xs text-gray-500 mt-1">{esperaComparativa.lista_espera.cantidad} esperando · {esperaComparativa.lista_espera.promedio} días promedio</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {pestañaActiva === 'reportes_clinicos' && (
          <div>
            <h1 className="text-2xl md:text-3xl font-bold text-blue-900 mb-6">Generación de Reportes Clínicos</h1>

            <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
              <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-6">
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-1">Profesional</label>
                  <select value={filtroProfesional} onChange={(e) => setFiltroProfesional(e.target.value)} className="w-full p-2 border border-gray-300 rounded text-sm outline-none">
                    <option value="">Todos</option>
                    {profesionalesTotales.map(p => <option key={p.id_profesional} value={p.id_profesional}>{p.nombres} {p.apellidos}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-1">Especialidad</label>
                  <select value={filtroServicio} onChange={(e) => setFiltroServicio(e.target.value)} className="w-full p-2 border border-gray-300 rounded text-sm outline-none">
                    <option value="">Todas</option>
                    {serviciosTotales.map(s => <option key={s.id_servicio} value={s.id_servicio}>{s.nombre}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-1">Fecha Inicio</label>
                  <input type="date" value={fechaInicio} onChange={e => setFechaInicio(e.target.value)} className="w-full p-2 border border-gray-300 rounded text-sm outline-none" />
                </div>
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-1">Fecha Fin</label>
                  <input type="date" value={fechaFin} onChange={e => setFechaFin(e.target.value)} className="w-full p-2 border border-gray-300 rounded text-sm outline-none" />
                </div>
                <div className="flex items-end">
                  <button onClick={generarReporte} disabled={cargandoReporte} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 rounded transition">
                    {cargandoReporte ? 'Consultando...' : 'Generar Reporte'}
                  </button>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-6 bg-blue-50 border border-blue-100 rounded-lg p-4">
                <div>
                  <p className="font-bold text-blue-900">Base de datos completa</p>
                  <p className="text-xs text-gray-600">Excel con hoja "Reservas" (pasadas, futuras y canceladas), hoja "Lista de Espera" y hoja "Cuestionarios" (anexo enlazado desde cada Entrevista de Ingreso). Respeta los filtros de arriba; el rango de fechas filtra por <strong>fecha de atención (la cita)</strong>.</p>
                </div>
                <button
                  onClick={exportarReservasExcel}
                  disabled={exportando}
                  className="bg-green-600 hover:bg-green-700 disabled:opacity-60 text-white font-bold py-2 px-4 rounded shadow whitespace-nowrap flex-shrink-0"
                >
                  {exportando ? 'Generando...' : '↓ Descargar Base de Reservas (Excel)'}
                </button>
              </div>

              {reporteOcupacion.length > 0 ? (
                <div>
                  <div className="overflow-x-auto border rounded-lg">
                    <table className="w-full text-left bg-white text-sm">
                      <thead className="bg-gray-100 border-b">
                        <tr>
                          <th className="p-3">Profesional</th>
                          <th className="p-3">Especialidad</th>
                          <th className="p-3">Total Agendado</th>
                          <th className="p-3">Horas Ocupadas</th>
                          <th className="p-3">% Ocupación</th>
                        </tr>
                      </thead>
                      <tbody>
                        {reporteOcupacion.map((fila, i) => (
                          <tr key={i} className="border-b hover:bg-gray-50">
                            <td className="p-3 font-semibold text-gray-800">{fila.profesional}</td>
                            <td className="p-3 text-gray-600">{fila.servicio}</td>
                            <td className="p-3">{fila.total_bloques} bloques</td>
                            <td className="p-3 font-medium text-blue-800">{fila.bloques_ocupados} atenciones</td>
                            <td className="p-3">
                              <span className={`px-2 py-1 rounded font-bold ${fila.porcentaje_ocupacion >= 80 ? 'bg-green-100 text-green-800' : fila.porcentaje_ocupacion >= 50 ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800'}`}>
                                {fila.porcentaje_ocupacion}%
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="h-80 bg-gray-50 rounded flex items-center justify-center border border-dashed border-gray-300">
                  <div className="text-center">
                    <svg className="w-12 h-12 text-gray-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                    <p className="text-gray-500 font-medium">Configura los filtros y presiona generar reporte.</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {pestañaActiva === 'estadisticas' && (
          <div>
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-6">
              <h1 className="text-2xl md:text-3xl font-bold text-blue-900">Métricas y Demanda</h1>
              <div className="flex flex-wrap gap-2 items-end">
                <div>
                  <label className="block text-xs font-bold text-gray-600 mb-1">Profesional</label>
                  <select value={filtroProfesional} onChange={(e) => setFiltroProfesional(e.target.value)} className="p-2 border border-gray-300 rounded text-sm outline-none">
                    <option value="">Todos</option>
                    {profesionalesTotales.map(p => <option key={p.id_profesional} value={p.id_profesional}>{p.nombres} {p.apellidos}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-600 mb-1">Especialidad</label>
                  <select value={filtroServicio} onChange={(e) => setFiltroServicio(e.target.value)} className="p-2 border border-gray-300 rounded text-sm outline-none">
                    <option value="">Todas</option>
                    {serviciosTotales.map(s => <option key={s.id_servicio} value={s.id_servicio}>{s.nombre}</option>)}
                  </select>
                </div>
                <button onClick={fetchEstadisticas} disabled={cargandoEstadisticas} className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded text-sm">
                  {cargandoEstadisticas ? 'Cargando...' : 'Aplicar filtros'}
                </button>
              </div>
            </div>

            {/* Ocupación por semana (8 semanas centradas en hoy) */}
            <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200 mb-6">
              <h3 className="font-bold text-gray-800 mb-1">Ocupación por Semana</h3>
              <p className="text-xs text-gray-500 mb-4">% de ocupación a lo largo de las semanas (ventana de 8 semanas)</p>
              {ocupacionSemanal.length === 0 ? (
                <div className="h-64 flex items-center justify-center text-gray-400 italic">Sin datos para mostrar.</div>
              ) : (
                <ResponsiveContainer width="100%" height={280}>
                  <LineChart data={ocupacionSemanal} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="inicio" tick={{ fontSize: 12 }} />
                    <YAxis domain={[0, 100]} unit="%" tick={{ fontSize: 12 }} />
                    <Tooltip formatter={(v) => `${v}%`} />
                    <Line type="monotone" dataKey="porcentaje" name="Ocupación" stroke={COLOR_BARRA} strokeWidth={2} dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
                <h3 className="font-bold text-gray-800 mb-4">Inasistencias vs Asistencias</h3>
                {datosAsistencia.length === 0 ? (
                  <div className="h-64 flex items-center justify-center text-gray-400 italic">Sin registros de asistencia.</div>
                ) : (
                  <ResponsiveContainer width="100%" height={256}>
                    <PieChart>
                      <Pie data={datosAsistencia} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label>
                        {datosAsistencia.map((d) => <Cell key={d.name} fill={d.color} />)}
                      </Pie>
                      <Tooltip />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </div>

              <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
                <h3 className="font-bold text-gray-800 mb-4">Distribución por Carreras</h3>
                {carreras.length === 0 ? (
                  <div className="h-64 flex items-center justify-center text-gray-400 italic">Sin pacientes activos.</div>
                ) : (
                  <ResponsiveContainer width="100%" height={Math.max(256, carreras.length * 36)}>
                    <BarChart data={carreras} layout="vertical" margin={{ top: 5, right: 20, bottom: 5, left: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                      <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12 }} />
                      <YAxis type="category" dataKey="carrera" width={120} tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Bar dataKey="cantidad" name="Pacientes">
                        {carreras.map((c, i) => <Cell key={c.carrera} fill={COLORES_CARRERA[i % COLORES_CARRERA.length]} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
