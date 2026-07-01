from typing import Optional
from database import supabase


def _origen_triage_legible(origen: str) -> str:
    if origen == "lista_espera":
        return "lista de espera"
    if origen == "proceso_clinico":
        return "proceso clinico"
    return origen.replace("_", " ")


def _detalles_derivacion_interna(motivo_consulta: Optional[str]) -> dict:
    if not motivo_consulta or "Derivación interna" not in motivo_consulta or "Ref. Evolución: " not in motivo_consulta:
        return {}
    try:
        id_evolucion = motivo_consulta.split("Ref. Evolución: ", 1)[1].strip()
        evo_req = supabase.table("evolucion_clinica").select(
            "reserva(id_proceso, proceso_clinico(motivo_consulta, servicio(nombre)))"
        ).eq("id_evolucion", id_evolucion).execute()

        if not evo_req.data:
            return {}

        reserva = evo_req.data[0].get("reserva") or {}
        proceso_origen = reserva.get("proceso_clinico") or {}
        motivo_origen = proceso_origen.get("motivo_consulta")
        servicio_origen = (proceso_origen.get("servicio") or {}).get("nombre")

        detalles = {}
        if motivo_origen and "Derivación interna" not in motivo_origen:
            detalles["motivo_origen"] = motivo_origen
        if servicio_origen:
            detalles["servicio_origen"] = servicio_origen
        return detalles
    except Exception:
        return {}


def _construir_motivo_caso_critico(origen: str, motivo_consulta: Optional[str] = None, servicio_nombre: Optional[str] = None) -> str:
    detalles_derivacion = _detalles_derivacion_interna(motivo_consulta)
    motivo_mostrar = detalles_derivacion.get("motivo_origen") or motivo_consulta
    origen_mostrar = _origen_triage_legible(origen)
    if detalles_derivacion.get("servicio_origen"):
        origen_mostrar = f"{detalles_derivacion['servicio_origen']} ({origen_mostrar})"

    detalles = []
    if motivo_mostrar:
        detalles.append(f"Motivo del alumno: {motivo_mostrar}")
    if servicio_nombre:
        detalles.append(f"Servicio: {servicio_nombre}")
    detalles.append(f"Derivado desde: {origen_mostrar}")
    return " | ".join(detalles)


def _puntaje_item_triage(item: dict) -> tuple:
    motivo = (item.get("motivo_consulta") or "").lower()
    servicio_nombre = ((item.get("servicio") or {}).get("nombre") or "").lower()
    puntaje = 0
    if "encuesta" in motivo or "puntaje" in motivo:
        puntaje += 100
    if "entrevista" in servicio_nombre and "ingreso" in servicio_nombre:
        puntaje += 50
    if item.get("estado_revision") == "revisado":
        puntaje += 10
    fecha = item.get("fecha_inicio") or item.get("fecha_ingreso") or ""
    return (puntaje, fecha)


def _motivo_caso_critico_desde_origen(id_estudiante: str, origen: str) -> Optional[str]:
    try:
        if origen == "lista_espera":
            req = supabase.table("lista_espera").select(
                "motivo_consulta, fecha_ingreso, estado_revision, servicio:id_servicio(nombre)"
            ).eq("id_estudiante", id_estudiante).execute()
        elif origen == "proceso_clinico":
            req = supabase.table("proceso_clinico").select(
                "motivo_consulta, fecha_inicio, estado_revision, servicio:id_servicio(nombre)"
            ).eq("id_estudiante", id_estudiante).execute()
        else:
            return None

        if not req.data:
            return None

        item = sorted(req.data, key=_puntaje_item_triage, reverse=True)[0]
        servicio = item.get("servicio") or {}
        return _construir_motivo_caso_critico(origen, item.get("motivo_consulta"), servicio.get("nombre"))
    except Exception:
        return None
