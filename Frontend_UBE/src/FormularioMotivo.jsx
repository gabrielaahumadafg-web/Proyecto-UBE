/**
 * Componente reutilizable para el campo de motivo de consulta.
 * Cuando el servicio es "Entrevista de Ingreso", muestra el cuestionario de triage
 * en lugar de un simple textarea.
 */
export function buildMotivoFinal(esEntrevista, respuestas, extras) {
  if (!esEntrevista) return extras;
  const puntaje = parseInt(respuestas.q1) + parseInt(respuestas.q2) + parseInt(respuestas.q3);
  return `[Encuesta Triage - Puntaje: ${puntaje}/9]\n1. Decaimiento/Tristeza: Nivel ${respuestas.q1}\n2. Afectación Académica: Nivel ${respuestas.q2}\n3. Estrés/Ansiedad: Nivel ${respuestas.q3}\nExtras: ${extras}`;
}

export default function FormularioMotivo({ esEntrevista, respuestas, setRespuestas, motivo, setMotivo, obligatorio = true }) {
  if (esEntrevista) {
    return (
      <div className="mb-6 space-y-4 bg-gray-50 p-4 rounded border border-gray-200">
        <h4 className="font-bold text-gray-800">Cuestionario de Ingreso (Triage)</h4>
        <p className="text-sm text-gray-600">Responde según la situación del/la estudiante.</p>
        <div>
          <label className="block text-sm font-semibold mb-1">1. ¿Con qué frecuencia se ha sentido decaído/a, triste o sin esperanza en las últimas 2 semanas?</label>
          <select value={respuestas.q1} onChange={e => setRespuestas({...respuestas, q1: e.target.value})} className="w-full p-2 border rounded text-sm bg-white">
            <option value="0">Nunca o casi nunca</option>
            <option value="1">Varios días</option>
            <option value="2">Más de la mitad de los días</option>
            <option value="3">Casi todos los días</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-semibold mb-1">2. ¿Sus dificultades actuales están afectando su rendimiento académico?</label>
          <select value={respuestas.q2} onChange={e => setRespuestas({...respuestas, q2: e.target.value})} className="w-full p-2 border rounded text-sm bg-white">
            <option value="0">No afecta mayormente</option>
            <option value="1">Afecta un poco</option>
            <option value="2">Afecta bastante</option>
            <option value="3">En riesgo de reprobar / No puede asistir a clases</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-semibold mb-1">3. ¿Cómo evalúas su nivel de ansiedad o estrés en el último mes?</label>
          <select value={respuestas.q3} onChange={e => setRespuestas({...respuestas, q3: e.target.value})} className="w-full p-2 border rounded text-sm bg-white">
            <option value="0">Bajo / Normal</option>
            <option value="1">Moderado (generalmente controlable)</option>
            <option value="2">Alto (difícil de controlar)</option>
            <option value="3">Crítico / Constante angustia inmanejable</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-semibold mb-1">Observación adicional *</label>
          <textarea value={motivo} onChange={e => setMotivo(e.target.value)} rows="2" required className="w-full p-2 border rounded text-sm" placeholder="Describe brevemente tu situación..." />
        </div>
      </div>
    );
  }
  return (
    <div className="mb-4">
      <label className="font-bold mb-1 block text-gray-700">Motivo de Consulta{obligatorio ? ' *' : ''}:</label>
      <textarea
        value={motivo}
        onChange={e => setMotivo(e.target.value)}
        className="w-full p-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
        rows="3"
        placeholder="Indique el motivo por el cual se agenda esta hora..."
      />
    </div>
  );
}
