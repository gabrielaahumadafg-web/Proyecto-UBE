from datetime import datetime, timedelta
from fastapi import APIRouter, HTTPException, Depends
from database import supabase
from dependencies import obtener_usuario_actual
from schemas import SolicitudReserva, SolicitudListaEspera, SolicitudActualizarDisponibilidad, CancelacionReserva, SolicitudRespuestaOferta
from services.asignacion import _procesar_reserva_bloques, _attempt_automatic_assignment, _attempt_automatic_assignment_for_student, _seleccionar_mejor_bloque
from services.notificaciones import notificar_reserva_directa, notificar_inasistencia_registrada
from services.inasistencias import registrar_inasistencia, procesar_suspensiones_cumplidas
from schemas import SolicitudJustificarInasistencia
from utils_tiempo import ahora_chile, parse_utc_naive

router = APIRouter()


@router.post("/reservar")
async def reservar_bloque(solicitud: SolicitudReserva, usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "estudiante" or not usuario_actual["id_estudiante"]:
        raise HTTPException(status_code=403, detail="Solo estudiantes pueden reservar.")
    id_estudiante = usuario_actual["id_estudiante"]
    try:
        bloque_req = supabase.table("bloque_horario").select("id_servicio, estado, fecha_hora_inicio, id_ubicacion, servicio(nombre)").eq("id_bloque", solicitud.id_bloque).execute()
        if not bloque_req.data or bloque_req.data[0]["estado"] != "disponible":
            raise HTTPException(status_code=400, detail="Bloque no disponible.")

        if datetime.fromisoformat(bloque_req.data[0]["fecha_hora_inicio"].replace("Z", "")) < ahora_chile():
            raise HTTPException(status_code=400, detail="No puedes reservar un bloque que ya pasó.")

        id_servicio = bloque_req.data[0]["id_servicio"]
        nombre_servicio = bloque_req.data[0].get("servicio", {}).get("nombre", "").lower()
        if "psicolog" in nombre_servicio:
            raise HTTPException(status_code=403, detail="Psicología requiere derivación de un profesional.")

        candidatos_q = supabase.table("bloque_horario").select("id_bloque, id_profesional").eq("id_servicio", id_servicio).eq("fecha_hora_inicio", bloque_req.data[0]["fecha_hora_inicio"]).eq("estado", "disponible")
        id_ubicacion_bloque = bloque_req.data[0].get("id_ubicacion")
        candidatos_q = candidatos_q.eq("id_ubicacion", id_ubicacion_bloque) if id_ubicacion_bloque else candidatos_q.is_("id_ubicacion", "null")
        candidatos_req = candidatos_q.execute()
        id_bloque_final = _seleccionar_mejor_bloque(candidatos_req.data) if candidatos_req.data else solicitud.id_bloque

        suspension_req = supabase.table("suspension_servicio").select("id_suspension").eq("id_estudiante", id_estudiante).eq("id_servicio", id_servicio).gt("fecha_fin", datetime.utcnow().isoformat()).execute()
        if suspension_req.data:
            raise HTTPException(status_code=403, detail="Operación denegada. Suspensión activa.")

        proceso_existente = supabase.table("proceso_clinico").select("id_proceso").eq("id_estudiante", id_estudiante).eq("id_servicio", id_servicio).eq("estado", "activo").execute()
        if proceso_existente.data:
            id_proceso = proceso_existente.data[0]["id_proceso"]
            if supabase.table("reserva").select("id_reserva").eq("id_proceso", id_proceso).eq("estado", "pendiente").execute().data:
                raise HTTPException(status_code=400, detail="Ya tienes una reserva activa para este servicio.")
            supabase.table("proceso_clinico").update({
                "motivo_consulta": solicitud.motivo_consulta,
                "puntaje_triage": getattr(solicitud, "puntaje_triage", None),
                "estado_revision": "pendiente"
            }).eq("id_proceso", id_proceso).execute()
        else:
            proceso_ins = supabase.table("proceso_clinico").insert({
                "id_estudiante": id_estudiante,
                "id_servicio": id_servicio,
                "motivo_consulta": solicitud.motivo_consulta,
                "puntaje_triage": getattr(solicitud, "puntaje_triage", None)
            }).execute()
            id_proceso = proceso_ins.data[0]["id_proceso"]

        reserva_retorno = await _procesar_reserva_bloques(id_proceso, id_bloque_final)
        supabase.table("lista_espera").delete().eq("id_estudiante", id_estudiante).eq("id_servicio", id_servicio).execute()
        await notificar_reserva_directa(id_estudiante, id_bloque_final)
        return {"mensaje": "Reserva procesada.", "reserva": reserva_retorno}
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/mis_reservas")
async def obtener_mis_reservas(usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "estudiante" or not usuario_actual["id_estudiante"]:
        raise HTTPException(status_code=403, detail="Exclusivo para estudiantes.")
    try:
        procesos_req = supabase.table("proceso_clinico").select("id_proceso").eq("id_estudiante", usuario_actual["id_estudiante"]).execute()
        if not procesos_req.data:
            return []
        id_procesos = [p["id_proceso"] for p in procesos_req.data]
        reservas_req = supabase.table("reserva").select(
            "id_reserva, id_proceso, estado, fecha_creacion, bloque_horario(fecha_hora_inicio, estado, servicio(id_servicio, nombre), profesional(nombres, apellidos), ubicacion(id_ubicacion, nombre))"
        ).in_("id_proceso", id_procesos).execute()

        mis_reservas = []
        for r in reservas_req.data:
            b = r.get("bloque_horario") or {}
            servicio = b.get("servicio") or {}
            ubicacion = b.get("ubicacion") or {}
            mis_reservas.append({
                "id_reserva": r["id_reserva"],
                "id_proceso": r.get("id_proceso"),
                "fecha_creacion": r.get("fecha_creacion"),
                "estado": r["estado"],
                "estado_bloque": b.get("estado"),
                "fecha": b.get("fecha_hora_inicio"),
                "id_servicio": servicio.get("id_servicio"),
                "servicio_nombre": servicio.get("nombre", "Desconocido"),
                "profesional_nombres": (b.get("profesional") or {}).get("nombres", "Desconocido"),
                "profesional_apellidos": (b.get("profesional") or {}).get("apellidos", "Desconocido"),
                "ubicacion_nombre": ubicacion.get("nombre"),
                "ubicacion_id": ubicacion.get("id_ubicacion"),
            })
        mis_reservas.sort(key=lambda x: x["fecha"] if x["fecha"] else "")
        return mis_reservas
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/cancelar")
async def cancelar_reserva(datos: CancelacionReserva, usuario_actual: dict = Depends(obtener_usuario_actual)):
    rol_actor = usuario_actual["rol"]
    if rol_actor not in ["estudiante", "administrativo", "profesional"]:
        raise HTTPException(status_code=403, detail="Rol no autorizado.")
    try:
        reserva_req = supabase.table("reserva").select(
            "id_bloque, estado, id_proceso, bloque_horario(fecha_hora_inicio), proceso_clinico(id_estudiante, id_servicio, inasistencias_acumuladas)"
        ).eq("id_reserva", datos.id_reserva).execute()
        if not reserva_req.data:
            raise HTTPException(status_code=404, detail="Reserva no encontrada.")

        info = reserva_req.data[0]
        id_bloque = info["id_bloque"]
        id_proceso = info["id_proceso"]
        estado_cancelacion = "cancelado_estudiante" if rol_actor == "estudiante" else "cancelado_profesional"
        mensaje_extra = ""
        id_inasistencia = None

        if rol_actor == "estudiante":
            fecha_hora_inicio_str = info.get("bloque_horario", {}).get("fecha_hora_inicio")
            if fecha_hora_inicio_str:
                fecha_hora_inicio = datetime.fromisoformat(fecha_hora_inicio_str.replace("Z", "").replace(" ", "T"))
                if fecha_hora_inicio - ahora_chile() < timedelta(hours=48):
                    estado_cancelacion = "cancelado_estudiante_tarde"
                    proc_info = info.get("proceso_clinico", {})
                    faltas_actuales = proc_info.get("inasistencias_acumuladas", 0)
                    supabase.table("proceso_clinico").update({"inasistencias_acumuladas": faltas_actuales + 1}).eq("id_proceso", id_proceso).execute()
                    id_inasistencia = registrar_inasistencia(
                        id_reserva=datos.id_reserva,
                        id_proceso=id_proceso,
                        id_estudiante=proc_info.get("id_estudiante"),
                        id_servicio=proc_info.get("id_servicio"),
                        tipo="cancelacion_tardia",
                        fecha_inasistencia_iso=fecha_hora_inicio_str,
                    )
                    await notificar_inasistencia_registrada(
                        proc_info.get("id_estudiante"), proc_info.get("id_servicio"),
                        "cancelacion_tardia", fecha_hora_inicio_str
                    )
                    mensaje_extra = " Cancelar con menos de 48h cuenta como inasistencia: puedes justificarla en 'Mis Inasistencias'."

        supabase.table("reserva").update({"estado": estado_cancelacion}).eq("id_reserva", datos.id_reserva).execute()
        bloques_liberados = supabase.table("bloque_horario").update({"estado": "disponible"}).eq("id_bloque", id_bloque).execute()
        for bl in bloques_liberados.data:
            await _attempt_automatic_assignment(bl["id_bloque"])
        return {
            "mensaje": "Reserva cancelada." + mensaje_extra,
            "requiere_justificacion": id_inasistencia is not None,
            "id_inasistencia": id_inasistencia,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/lista_espera")
async def registrar_lista_espera(solicitud: SolicitudListaEspera, usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "estudiante" or not usuario_actual["id_estudiante"]:
        raise HTTPException(status_code=403, detail="Solo estudiantes pueden inscribirse.")
    id_estudiante = usuario_actual["id_estudiante"]
    try:
        servicio_req = supabase.table("servicio").select("nombre").eq("id_servicio", solicitud.id_servicio).execute()
        if servicio_req.data and "psicolog" in servicio_req.data[0]["nombre"].lower():
            raise HTTPException(status_code=403, detail="Psicología requiere derivación de un profesional.")

        if supabase.table("suspension_servicio").select("id_suspension").eq("id_estudiante", id_estudiante).eq("id_servicio", solicitud.id_servicio).gt("fecha_fin", datetime.utcnow().isoformat()).execute().data:
            raise HTTPException(status_code=403, detail="Operación denegada. Suspensión activa.")

        respuesta = supabase.table("lista_espera").insert({
            "id_estudiante": id_estudiante,
            "id_servicio": solicitud.id_servicio,
            "disponibilidad_indicada": solicitud.disponibilidad_indicada,
            "campus_indicados": solicitud.campus_indicados,
            "campus_por_slot": solicitud.campus_por_slot,
            "motivo_consulta": solicitud.motivo_consulta,
            "es_prioritario": False,
            "puntaje_triage": getattr(solicitud, "puntaje_triage", None)
        }).execute()

        await _attempt_automatic_assignment_for_student(respuesta.data[0]["id_lista"])
        return {"mensaje": "Registrado en lista de espera.", "datos": respuesta.data}
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/mis_esperas")
async def obtener_mis_esperas(usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "estudiante" or not usuario_actual["id_estudiante"]:
        raise HTTPException(status_code=403, detail="Exclusivo para estudiantes.")
    try:
        req = supabase.table("lista_espera").select(
            "id_lista, id_servicio, fecha_ingreso, disponibilidad_indicada, campus_indicados, campus_por_slot, estado_oferta, motivo_consulta, servicio(nombre, duracion_minutos)"
        ).eq("id_estudiante", usuario_actual["id_estudiante"]).order("fecha_ingreso", desc=False).execute()
        return req.data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/lista_espera/{id_lista}")
async def actualizar_disponibilidad_espera(id_lista: str, datos: SolicitudActualizarDisponibilidad, usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "estudiante" or not usuario_actual["id_estudiante"]:
        raise HTTPException(status_code=403, detail="Exclusivo para estudiantes.")
    try:
        actualizacion = {"disponibilidad_indicada": datos.disponibilidad_indicada}
        if datos.campus_indicados is not None:
            actualizacion["campus_indicados"] = datos.campus_indicados if datos.campus_indicados else None
        if datos.campus_por_slot is not None:
            actualizacion["campus_por_slot"] = datos.campus_por_slot if datos.campus_por_slot else None
        supabase.table("lista_espera").update(actualizacion).eq("id_lista", id_lista).eq("id_estudiante", usuario_actual["id_estudiante"]).execute()
        await _attempt_automatic_assignment_for_student(id_lista)
        return {"mensaje": "Horarios actualizados exitosamente."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/lista_espera/{id_lista}")
async def salir_lista_espera(id_lista: str, usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "estudiante" or not usuario_actual["id_estudiante"]:
        raise HTTPException(status_code=403, detail="Exclusivo para estudiantes.")
    try:
        supabase.table("lista_espera").delete().eq("id_lista", id_lista).eq("id_estudiante", usuario_actual["id_estudiante"]).execute()
        return {"mensaje": "Te has retirado de la lista de espera."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/responder_oferta")
async def responder_oferta(datos: SolicitudRespuestaOferta, usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "estudiante" or not usuario_actual["id_estudiante"]:
        raise HTTPException(status_code=403, detail="Solo estudiantes pueden responder ofertas.")
    id_estudiante = usuario_actual["id_estudiante"]
    try:
        lista_req = supabase.table("lista_espera").select("*").eq("id_lista", datos.id_lista).eq("id_estudiante", id_estudiante).execute()
        if not lista_req.data:
            raise HTTPException(status_code=404, detail="Oferta no encontrada.")

        oferta = lista_req.data[0]
        if oferta["estado_oferta"] != "ofertado":
            raise HTTPException(status_code=400, detail="La solicitud no tiene una oferta activa.")

        vencimiento_str = oferta["vencimiento_oferta"]
        if vencimiento_str and datetime.utcnow() > datetime.fromisoformat(vencimiento_str.replace("Z", "").replace(" ", "T")):
            raise HTTPException(status_code=400, detail="La oferta ha caducado.")

        disponibilidad = oferta["disponibilidad_indicada"]
        id_bloque = disponibilidad.get("bloque_ofertado")
        if not id_bloque:
            raise HTTPException(status_code=400, detail="No se encontró el bloque ofertado.")

        if datos.aceptada:
            proceso_existente = supabase.table("proceso_clinico").select("id_proceso").eq("id_estudiante", id_estudiante).eq("id_servicio", oferta["id_servicio"]).eq("estado", "activo").execute()
            if proceso_existente.data:
                id_proceso = proceso_existente.data[0]["id_proceso"]
                supabase.table("proceso_clinico").update({"motivo_consulta": oferta["motivo_consulta"], "puntaje_triage": oferta.get("puntaje_triage"), "estado_revision": "pendiente"}).eq("id_proceso", id_proceso).execute()
            else:
                proceso_ins = supabase.table("proceso_clinico").insert({"id_estudiante": id_estudiante, "id_servicio": oferta["id_servicio"], "motivo_consulta": oferta["motivo_consulta"], "puntaje_triage": oferta.get("puntaje_triage")}).execute()
                id_proceso = proceso_ins.data[0]["id_proceso"]
            await _procesar_reserva_bloques(id_proceso, id_bloque)
            supabase.table("lista_espera").delete().eq("id_lista", datos.id_lista).execute()
            await notificar_reserva_directa(id_estudiante, id_bloque)
            return {"mensaje": "Oferta aceptada. Reserva generada exitosamente."}
        else:
            supabase.table("bloque_horario").update({"estado": "disponible"}).eq("id_bloque", id_bloque).execute()
            disponibilidad.pop("bloque_ofertado", None)
            supabase.table("lista_espera").update({"estado_oferta": "esperando", "vencimiento_oferta": None, "disponibilidad_indicada": disponibilidad}).eq("id_lista", datos.id_lista).execute()
            return {"mensaje": "Oferta rechazada. Has vuelto a la lista de espera."}
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/mis_inasistencias")
async def obtener_mis_inasistencias(usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "estudiante" or not usuario_actual["id_estudiante"]:
        raise HTTPException(status_code=403, detail="Exclusivo para estudiantes.")
    try:
        # Reiniciar faltas de suspensiones ya cumplidas para que no aparezcan tras servirse.
        procesar_suspensiones_cumplidas()
        req = supabase.table("inasistencia").select(
            "id_inasistencia, tipo, estado, motivo_estudiante, fecha_inasistencia, "
            "fecha_limite_justificacion, fecha_resolucion, servicio(nombre)"
        ).eq("id_estudiante", usuario_actual["id_estudiante"]).order("fecha_inasistencia", desc=True).execute()
        ahora = datetime.utcnow()
        resultados = []
        for it in (req.data or []):
            limite_str = it.get("fecha_limite_justificacion")
            limite_dt = parse_utc_naive(limite_str)
            dentro_plazo = limite_dt is None or limite_dt >= ahora
            puede_justificar = it["estado"] == "pendiente_justificacion" and not it.get("motivo_estudiante") and dentro_plazo
            resultados.append({
                "id_inasistencia": it["id_inasistencia"],
                "tipo": it["tipo"],
                "estado": it["estado"],
                "motivo_estudiante": it.get("motivo_estudiante"),
                "fecha_inasistencia": it.get("fecha_inasistencia"),
                "fecha_limite_justificacion": limite_str,
                "fecha_resolucion": it.get("fecha_resolucion"),
                "servicio_nombre": (it.get("servicio") or {}).get("nombre", "Desconocido"),
                "puede_justificar": puede_justificar,
            })
        return resultados
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/mis_suspensiones")
async def obtener_mis_suspensiones(usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "estudiante" or not usuario_actual["id_estudiante"]:
        raise HTTPException(status_code=403, detail="Exclusivo para estudiantes.")
    try:
        req = supabase.table("suspension_servicio").select(
            "id_suspension, id_servicio, fecha_fin, servicio(nombre)"
        ).eq("id_estudiante", usuario_actual["id_estudiante"]).gt("fecha_fin", datetime.utcnow().isoformat()).execute()
        return [
            {
                "id_suspension": s["id_suspension"],
                "id_servicio": s["id_servicio"],
                "fecha_fin": s["fecha_fin"],
                "servicio_nombre": (s.get("servicio") or {}).get("nombre", "Desconocido"),
            }
            for s in (req.data or [])
        ]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/justificar_inasistencia")
async def justificar_inasistencia(datos: SolicitudJustificarInasistencia, usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "estudiante" or not usuario_actual["id_estudiante"]:
        raise HTTPException(status_code=403, detail="Exclusivo para estudiantes.")
    if not datos.motivo or not datos.motivo.strip():
        raise HTTPException(status_code=400, detail="Debes escribir un motivo.")
    try:
        req = supabase.table("inasistencia").select(
            "id_inasistencia, estado, fecha_limite_justificacion"
        ).eq("id_inasistencia", datos.id_inasistencia).eq("id_estudiante", usuario_actual["id_estudiante"]).execute()
        if not req.data:
            raise HTTPException(status_code=404, detail="Inasistencia no encontrada.")
        fila = req.data[0]
        if fila["estado"] != "pendiente_justificacion":
            raise HTTPException(status_code=400, detail="Esta inasistencia ya fue resuelta o no admite justificación.")
        limite = parse_utc_naive(fila.get("fecha_limite_justificacion"))
        if limite and datetime.utcnow() > limite:
            raise HTTPException(status_code=400, detail="El plazo para justificar ya venció.")
        supabase.table("inasistencia").update({
            "motivo_estudiante": datos.motivo.strip(),
            "fecha_justificacion": datetime.utcnow().isoformat(),
        }).eq("id_inasistencia", datos.id_inasistencia).execute()
        return {"mensaje": "Justificación enviada. Quedará a revisión de la administración."}
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
