/**
 * Panel de historial clínico reutilizable.
 * Usado en DashboardAdministrativo, DashboardCoordinador y DashboardProfesional.
 *
 * Props:
 *   procesos         – Array de procesos clínicos con sus reservas anidadas
 *   procesoExpandido – ID del proceso actualmente expandido (o null)
 *   onToggleProceso  – (id_proceso) => void  para expandir/colapsar
 *   renderAcciones        – (reserva) => JSX | null  render-prop para botones por rol (opcional)
 *   renderAccionesProceso – (proceso) => JSX | null  render-prop para botones a nivel de proceso (opcional)
 *   colorAccent           – 'blue' | 'indigo'  — cambia el color del encabezado y botón Ver Detalle
 */
export default function HistorialEstudiante({
  procesos = [],
  procesoExpandido,
  onToggleProceso,
  renderAcciones = null,
  renderAccionesProceso = null,
  colorAccent = 'blue',
}) {
  const headingColor = colorAccent === 'indigo' ? 'text-indigo-900' : 'text-blue-900';
  const btnClass     = colorAccent === 'indigo'
    ? 'bg-indigo-100 hover:bg-indigo-200 text-indigo-800'
    : 'bg-blue-100 hover:bg-blue-200 text-blue-800';

  if (procesos.length === 0) {
    return <p className="text-gray-500 italic">No tiene historial clínico registrado.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {procesos.map(proceso => (
        <div key={proceso.id_proceso} className="border rounded-lg bg-white shadow-sm overflow-hidden">
          {/* Encabezado del proceso */}
          <div className="p-4 bg-gray-50 flex justify-between items-center border-b">
            <div>
              <h4 className={`font-bold ${headingColor} text-lg`}>
                {proceso.servicio_nombre} {proceso.es_ciclico ? '(Cíclico)' : ''}
              </h4>
              {renderAccionesProceso && renderAccionesProceso(proceso)}
              <p className="text-sm text-gray-600 mt-1">
                <strong>Estado:</strong> <span className="uppercase">{proceso.estado}</span> |{' '}
                <strong>Asistencias:</strong> {proceso.sesiones_realizadas} |{' '}
                <strong>Inasistencias:</strong> {proceso.inasistencias_acumuladas}
                {typeof proceso.faltas_acumuladas === 'number' && (
                  <> {' '}|{' '}<strong>Faltas:</strong> <span className={proceso.faltas_acumuladas >= 2 ? 'text-red-600 font-bold' : ''}>{proceso.faltas_acumuladas}</span></>
                )}
              </p>
              <p className="text-sm text-gray-600">
                <strong>Origen:</strong>{' '}
                {proceso.es_derivacion
                  ? proceso.servicio_origen
                    ? `Derivado desde ${proceso.servicio_origen}`
                    : 'Derivado por otro profesional'
                  : 'Agendamiento directo'}
              </p>
              {proceso.es_derivacion && !proceso.servicio_origen && (
                <p className="text-sm italic text-gray-500">"{proceso.motivo_consulta}"</p>
              )}
            </div>
            <button
              onClick={() => onToggleProceso(procesoExpandido === proceso.id_proceso ? null : proceso.id_proceso)}
              className={`${btnClass} font-bold py-2 px-4 rounded text-sm transition ml-4`}
            >
              {procesoExpandido === proceso.id_proceso ? 'Ocultar Detalle' : 'Ver Detalle'}
            </button>
          </div>

          {/* Detalle de sesiones */}
          {procesoExpandido === proceso.id_proceso && (
            <div className="p-4 bg-white">
              <h5 className="font-bold text-gray-800 mb-3">Registro de Sesiones</h5>
              {proceso.reservas.length === 0 ? (
                <p className="text-sm text-gray-500 italic">No hay sesiones agendadas para este servicio.</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {proceso.reservas.map(res => (
                    <div key={res.id_reserva} className="border border-gray-200 rounded p-3 bg-gray-50">
                      <div className="flex justify-between items-start">
                        <div>
                          <p className="font-semibold text-gray-800">
                            {new Date(res.fecha).toLocaleString()} con {res.profesional_nombres} {res.profesional_apellidos}
                          </p>
                          <span className={`inline-block mt-1 px-2 py-1 text-xs font-bold rounded ${
                            res.estado === 'presente'  ? 'bg-green-100 text-green-800' :
                            res.estado === 'pendiente' ? 'bg-blue-100  text-blue-800'  :
                                                         'bg-red-100   text-red-800'
                          }`}>
                            {res.estado.toUpperCase().replace('_', ' ')}
                          </span>
                        </div>
                        {renderAcciones && renderAcciones(res)}
                      </div>

                      {res.evolucion && (
                        <div className="mt-3 p-3 bg-white border border-gray-200 rounded text-sm text-gray-700 shadow-sm">
                          <p className="font-bold text-blue-900 mb-1 border-b pb-1">Ficha Clínica:</p>
                          {res.evolucion.observaciones  && <p className="mb-1"><strong>Observaciones:</strong> {res.evolucion.observaciones}</p>}
                          {res.evolucion.diagnostico    && <p className="mb-1"><strong>Diagnóstico:</strong> {res.evolucion.diagnostico}</p>}
                          {res.evolucion.plan_tratamiento && <p><strong>Plan de Tratamiento:</strong> {res.evolucion.plan_tratamiento}</p>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
