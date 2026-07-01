from fastapi import APIRouter, HTTPException, Depends, Query
from typing import Optional
from datetime import datetime, timedelta
from database import supabase
from dependencies import obtener_usuario_actual
from utils_tiempo import ahora_chile

router = APIRouter(prefix="/reportes")

ROLES_REPORTES = ["profesional_apoyo", "coordinador", "administrativo"]

# Un bloque se considera "ocupado" si su estado NO está en esta lista.
ESTADOS_NO_OCUPADOS = ["disponible", "huerfano", "cancelado"]


@router.get("/ocupacion")
async def reporte_ocupacion(
    fecha_inicio: str = Query(...),
    fecha_fin: str = Query(...),
    id_servicio: Optional[str] = None,
    id_profesional: Optional[str] = None,
    usuario_actual: dict = Depends(obtener_usuario_actual)
):
    if usuario_actual["rol"] not in ROLES_REPORTES:
        raise HTTPException(status_code=403, detail="Acceso denegado.")
    try:
        query = supabase.table("bloque_horario").select(
            "id_bloque, estado, id_profesional, id_servicio, profesional(nombres, apellidos), servicio(nombre)"
        ).gte("fecha_hora_inicio", fecha_inicio).lte("fecha_hora_inicio", fecha_fin)

        if id_servicio:
            query = query.eq("id_servicio", id_servicio)
        if id_profesional:
            query = query.eq("id_profesional", id_profesional)

        req = query.execute()
        stats = {}
        for b in req.data:
            prof_name = f"{b['profesional']['nombres']} {b['profesional']['apellidos']}" if b.get("profesional") else "Desconocido"
            serv_name = b["servicio"]["nombre"] if b.get("servicio") else "Desconocido"
            key = f"{b['id_profesional']}_{b['id_servicio']}"
            if key not in stats:
                stats[key] = {
                    "id_profesional": b["id_profesional"],
                    "id_servicio": b["id_servicio"],
                    "profesional": prof_name,
                    "servicio": serv_name,
                    "total": 0,
                    "ocupados": 0,
                }
            stats[key]["total"] += 1
            if b["estado"] not in ESTADOS_NO_OCUPADOS:
                stats[key]["ocupados"] += 1

        resultados = [
            {
                "id_profesional": v["id_profesional"],
                "id_servicio": v["id_servicio"],
                "profesional": v["profesional"],
                "servicio": v["servicio"],
                "total_bloques": v["total"],
                "bloques_ocupados": v["ocupados"],
                "porcentaje_ocupacion": round((v["ocupados"] / v["total"] * 100) if v["total"] > 0 else 0, 2)
            }
            for v in stats.values()
        ]
        resultados.sort(key=lambda x: x["porcentaje_ocupacion"], reverse=True)
        return resultados
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/resumen_global")
async def reporte_resumen_global(usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] not in ROLES_REPORTES:
        raise HTTPException(status_code=403, detail="Acceso denegado.")
    try:
        activos_req = supabase.table("proceso_clinico").select("id_estudiante").eq("estado", "activo").execute()
        activos_count = len(set(p["id_estudiante"] for p in activos_req.data)) if activos_req.data else 0

        espera_req = supabase.table("lista_espera").select("id_estudiante").eq("estado_oferta", "esperando").execute()
        espera_count = len(set(e["id_estudiante"] for e in espera_req.data)) if espera_req.data else 0

        criticos_req = supabase.table("proceso_clinico").select("id_proceso").eq("es_caso_critico", True).execute()
        criticos_count = len(criticos_req.data) if criticos_req.data else 0

        return {"activos": activos_count, "espera": espera_count, "criticos": criticos_count}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/ocupacion_semanal")
async def reporte_ocupacion_semanal(
    fecha_inicio: str = Query(...),
    fecha_fin: str = Query(...),
    id_servicio: Optional[str] = None,
    id_profesional: Optional[str] = None,
    usuario_actual: dict = Depends(obtener_usuario_actual)
):
    """Serie temporal de ocupación agrupada por semana ISO."""
    if usuario_actual["rol"] not in ROLES_REPORTES:
        raise HTTPException(status_code=403, detail="Acceso denegado.")
    try:
        query = supabase.table("bloque_horario").select(
            "id_bloque, estado, fecha_hora_inicio"
        ).gte("fecha_hora_inicio", fecha_inicio).lte("fecha_hora_inicio", fecha_fin)

        if id_servicio:
            query = query.eq("id_servicio", id_servicio)
        if id_profesional:
            query = query.eq("id_profesional", id_profesional)

        req = query.execute()
        semanas = {}
        for b in req.data:
            fh = b.get("fecha_hora_inicio")
            if not fh:
                continue
            dt = datetime.fromisoformat(fh.replace("Z", "").replace(" ", "T")[:19])
            iso_year, iso_week, _ = dt.isocalendar()
            clave = f"{iso_year}-W{iso_week:02d}"
            if clave not in semanas:
                lunes = dt - timedelta(days=dt.weekday())
                semanas[clave] = {"semana": clave, "inicio": lunes.strftime("%Y-%m-%d"), "total": 0, "ocupados": 0}
            semanas[clave]["total"] += 1
            if b["estado"] not in ESTADOS_NO_OCUPADOS:
                semanas[clave]["ocupados"] += 1

        resultados = [
            {
                **v,
                "porcentaje": round((v["ocupados"] / v["total"] * 100) if v["total"] > 0 else 0, 2)
            }
            for v in semanas.values()
        ]
        resultados.sort(key=lambda x: x["semana"])
        return resultados
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/asistencias")
async def reporte_asistencias(
    fecha_inicio: str = Query(...),
    fecha_fin: str = Query(...),
    id_servicio: Optional[str] = None,
    id_profesional: Optional[str] = None,
    usuario_actual: dict = Depends(obtener_usuario_actual)
):
    """Conteo de estados de asistencia (presente/ausente/atraso) en un rango."""
    if usuario_actual["rol"] not in ROLES_REPORTES:
        raise HTTPException(status_code=403, detail="Acceso denegado.")
    try:
        req = supabase.table("reserva").select(
            "estado, bloque_horario(fecha_hora_inicio, id_servicio, id_profesional)"
        ).in_("estado", ["presente", "ausente", "atraso"]).execute()

        conteo = {"presente": 0, "ausente": 0, "atraso": 0}
        for r in req.data:
            bh = r.get("bloque_horario") or {}
            fh = bh.get("fecha_hora_inicio")
            if not fh or fh < fecha_inicio or fh > fecha_fin:
                continue
            if id_servicio and bh.get("id_servicio") != id_servicio:
                continue
            if id_profesional and bh.get("id_profesional") != id_profesional:
                continue
            estado = r.get("estado")
            if estado in conteo:
                conteo[estado] += 1
        return conteo
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/reservas_detalle")
async def reporte_reservas_detalle(
    fecha_inicio: Optional[str] = None,
    fecha_fin: Optional[str] = None,
    id_servicio: Optional[str] = None,
    id_profesional: Optional[str] = None,
    usuario_actual: dict = Depends(obtener_usuario_actual)
):
    """Base de datos de reservas: una fila por reserva con toda la info para exportar a Excel.

    Filtros (todos opcionales): rango de fechas, servicio y profesional. El filtrado se hace en
    Python sobre los campos embebidos de bloque_horario (igual que /reportes/asistencias).
    """
    if usuario_actual["rol"] not in ROLES_REPORTES:
        raise HTTPException(status_code=403, detail="Acceso denegado.")
    try:
        # Mapa id_servicio -> nombre, para resolver el servicio de derivación.
        serv_req = supabase.table("servicio").select("id_servicio, nombre").execute()
        serv_map = {s["id_servicio"]: s["nombre"] for s in (serv_req.data or [])}

        req = supabase.table("reserva").select(
            "id_reserva, id_proceso, estado, fecha_creacion, "
            "bloque_horario(fecha_hora_inicio, fecha_hora_fin, id_servicio, id_profesional, "
                "profesional(nombres, apellidos), servicio(nombre, es_ciclico), ubicacion(nombre)), "
            "proceso_clinico(motivo_consulta, puntaje_triage, estado, sesiones_realizadas, "
                "inasistencias_acumuladas, es_caso_critico, fecha_inicio, "
                "estudiante(nombres, apellidos, rut, carrera, es_caso_critico_activo)), "
            "evolucion_clinica(id_evolucion, observaciones, diagnostico, plan_tratamiento, "
                "fecha_atencion, id_servicio_derivacion, id_reserva_derivacion, id_lista_derivacion)"
        ).execute()

        ahora_iso = ahora_chile().isoformat()

        etiquetas_asistencia = {
            "presente": "Presente",
            "ausente": "Ausente",
            "atraso": "Atraso",
            "pendiente": "Pendiente",
            "confirmado": "Confirmada",
            "reservado": "Reservada",
        }

        resultados = []
        for r in (req.data or []):
            bh = r.get("bloque_horario") or {}
            fh = bh.get("fecha_hora_inicio")

            # Filtros (en Python, sobre campos embebidos).
            if fecha_inicio and (not fh or fh < fecha_inicio):
                continue
            if fecha_fin and (not fh or fh > fecha_fin):
                continue
            if id_servicio and bh.get("id_servicio") != id_servicio:
                continue
            if id_profesional and bh.get("id_profesional") != id_profesional:
                continue

            prof = bh.get("profesional") or {}
            serv = bh.get("servicio") or {}
            proc = r.get("proceso_clinico") or {}
            est = proc.get("estudiante") or {}

            evo = r.get("evolucion_clinica")
            if isinstance(evo, list):
                evo = evo[0] if evo else None
            evo = evo or {}

            estado_reserva = r.get("estado") or ""
            if estado_reserva.startswith("cancelado"):
                asistencia = "Cancelada"
            else:
                asistencia = etiquetas_asistencia.get(estado_reserva, estado_reserva)

            es_critico = bool(proc.get("es_caso_critico") or est.get("es_caso_critico_activo"))

            motivo = proc.get("motivo_consulta") or ""
            serv_nombre = serv.get("nombre") or ""
            es_entrevista = ("entrevista" in serv_nombre.lower()) or motivo.startswith("[Encuesta Triage")

            id_deriv = evo.get("id_servicio_derivacion")

            # Estado de registro de la atención.
            if evo.get("id_evolucion"):
                registro_atencion = "Registrada"
            elif estado_reserva.startswith("cancelado"):
                registro_atencion = "Cancelada"
            elif fh and fh < ahora_iso:
                registro_atencion = "Sesión sin registrar"
            else:
                registro_atencion = "Pendiente (futura)"

            # Identificador legible de la reserva/lista a la que se derivó.
            id_reserva_deriv = evo.get("id_reserva_derivacion")
            if id_reserva_deriv:
                derivacion_destino = id_reserva_deriv
            elif evo.get("id_lista_derivacion"):
                derivacion_destino = "En lista de espera"
            else:
                derivacion_destino = ""

            resultados.append({
                "id_reserva": r.get("id_reserva"),
                "fecha_creacion": r.get("fecha_creacion"),
                "fecha_hora_inicio": fh,
                "fecha_hora_fin": bh.get("fecha_hora_fin"),
                "profesional": f"{prof.get('nombres', '')} {prof.get('apellidos', '')}".strip() or "Desconocido",
                "servicio": serv_nombre or "Desconocido",
                "ubicacion": (bh.get("ubicacion") or {}).get("nombre") or "Sin ubicación",
                "estudiante": f"{est.get('nombres', '')} {est.get('apellidos', '')}".strip() or "Desconocido",
                "rut": est.get("rut") or "",
                "carrera": est.get("carrera") or "",
                "estado_reserva": estado_reserva,
                "asistencia": asistencia,
                "registro_atencion": registro_atencion,
                "es_caso_critico": "Sí" if es_critico else "No",
                "puntaje_triage": proc.get("puntaje_triage"),
                "sesiones_realizadas": proc.get("sesiones_realizadas") or 0,
                "inasistencias_acumuladas": proc.get("inasistencias_acumuladas") or 0,
                "motivo_consulta": motivo,
                "es_entrevista_ingreso": es_entrevista,
                "diagnostico": evo.get("diagnostico") or "",
                "observaciones": evo.get("observaciones") or "",
                "plan_tratamiento": evo.get("plan_tratamiento") or "",
                "derivacion_servicio": serv_map.get(id_deriv, "") if id_deriv else "",
                "derivacion_destino": derivacion_destino,
            })

        resultados.sort(key=lambda x: x["fecha_hora_inicio"] or "", reverse=True)
        return resultados
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/lista_espera_detalle")
async def reporte_lista_espera_detalle(
    fecha_inicio: Optional[str] = None,
    fecha_fin: Optional[str] = None,
    id_servicio: Optional[str] = None,
    usuario_actual: dict = Depends(obtener_usuario_actual)
):
    """Lista de espera completa (estudiantes esperando oferta, sin reserva asignada todavía).

    Para exportar como hoja anexa del Excel de reservas. El filtro de profesional NO aplica
    (la lista de espera no tiene profesional asignado). `fecha_inicio`/`fecha_fin` filtran por
    `fecha_ingreso`.
    """
    if usuario_actual["rol"] not in ROLES_REPORTES:
        raise HTTPException(status_code=403, detail="Acceso denegado.")
    try:
        query = supabase.table("lista_espera").select(
            "id_lista, id_servicio, fecha_ingreso, es_prioritario, disponibilidad_indicada, "
            "motivo_consulta, puntaje_triage, estado_oferta, estado_revision, "
            "estudiante(nombres, apellidos, rut, carrera), servicio(nombre)"
        )
        if id_servicio:
            query = query.eq("id_servicio", id_servicio)
        req = query.execute()

        resultados = []
        for item in (req.data or []):
            fi = item.get("fecha_ingreso")
            if fecha_inicio and (not fi or fi < fecha_inicio):
                continue
            if fecha_fin and (not fi or fi > fecha_fin):
                continue
            est = item.get("estudiante") or {}
            serv = item.get("servicio") or {}
            motivo = item.get("motivo_consulta") or ""
            serv_nombre = serv.get("nombre") or ""
            es_entrevista = ("entrevista" in serv_nombre.lower()) or motivo.startswith("[Encuesta Triage")
            resultados.append({
                "id_lista": item.get("id_lista"),
                "fecha_ingreso": fi,
                "estudiante": f"{est.get('nombres', '')} {est.get('apellidos', '')}".strip() or "Desconocido",
                "rut": est.get("rut") or "",
                "carrera": est.get("carrera") or "",
                "servicio": serv_nombre or "Desconocido",
                "es_prioritario": "Sí" if item.get("es_prioritario") else "No",
                "estado_oferta": item.get("estado_oferta") or "",
                "estado_revision": item.get("estado_revision") or "",
                "puntaje_triage": item.get("puntaje_triage"),
                "disponibilidad_indicada": item.get("disponibilidad_indicada"),
                "motivo_consulta": motivo,
                "es_entrevista_ingreso": es_entrevista,
            })
        resultados.sort(key=lambda x: x["fecha_ingreso"] or "")
        return resultados
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/distribucion_carreras")
async def reporte_distribucion_carreras(
    id_servicio: Optional[str] = None,
    usuario_actual: dict = Depends(obtener_usuario_actual)
):
    """Pacientes activos únicos agrupados por carrera."""
    if usuario_actual["rol"] not in ROLES_REPORTES:
        raise HTTPException(status_code=403, detail="Acceso denegado.")
    try:
        query = supabase.table("proceso_clinico").select(
            "id_estudiante, estudiante(carrera)"
        ).eq("estado", "activo")
        if id_servicio:
            query = query.eq("id_servicio", id_servicio)

        req = query.execute()
        carreras = {}
        for p in req.data:
            est = p.get("estudiante") or {}
            carrera = est.get("carrera") or "Sin especificar"
            carreras.setdefault(carrera, set()).add(p["id_estudiante"])

        resultados = [{"carrera": c, "cantidad": len(ids)} for c, ids in carreras.items()]
        resultados.sort(key=lambda x: x["cantidad"], reverse=True)
        return resultados
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
