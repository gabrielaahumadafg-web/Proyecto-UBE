from datetime import datetime, timedelta
from fastapi import APIRouter, HTTPException, Depends
from database import supabase, fetch_all, in_chunks
from dependencies import obtener_usuario_actual
from schemas import (SolicitudAsignacionManual, SolicitudSuspension,
                     SolicitudCritico, SolicitudReagendamiento, SolicitudCambiarSerie,
                     SolicitudListaEsperaSerie,
                     SolicitudCancelarReservaAdmin, SolicitudAgendarHoraAdmin,
                     SolicitudResolverJustificacion, SolicitudJustificarDirecto,
                     SolicitudLevantarSuspension)
from services.asignacion import _procesar_reserva_bloques, _attempt_automatic_assignment, _attempt_automatic_assignment_for_student, _seleccionar_mejor_bloque, _tiene_conflicto_horario, reagendar_serie_ciclica, cancelar_serie_a_lista_espera
from services.notificaciones import notificar_reserva_directa, notificar_suspension
from services.inasistencias import (procesar_inasistencias_vencidas, resolver_inasistencia,
                                    procesar_suspensiones_cumplidas, reiniciar_faltas_servicio)
from services.triage import _construir_motivo_caso_critico, _motivo_caso_critico_desde_origen
from utils_tiempo import ahora_chile

router = APIRouter()

ROLES_ADMIN = ["administrativo", "coordinador"]


# ---- Utilidades de admin legacy ----

@router.get("/lista_espera_admin")
async def obtener_lista_espera_admin(usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "administrativo":
        raise HTTPException(status_code=403, detail="Exclusivo administrativo.")
    try:
        filas = fetch_all(lambda: supabase.table("lista_espera").select(
            "id_lista, id_servicio, fecha_ingreso, es_prioritario, disponibilidad_indicada, "
            "motivo_consulta, estado_oferta, estado_revision, estudiante(nombres, apellidos, rut, carrera), servicio(nombre)"
        ).eq("estado_revision", "pendiente"))
        resultados = []
        for item in filas:
            est = item.get("estudiante") or {}
            resultados.append({
                "id_lista": item["id_lista"],
                "id_servicio": item["id_servicio"],
                "estado_oferta": item.get("estado_oferta"),
                "estado_revision": item["estado_revision"],
                "fecha_ingreso": item["fecha_ingreso"],
                "es_prioritario": item["es_prioritario"],
                "disponibilidad_indicada": item["disponibilidad_indicada"],
                "motivo_consulta": item["motivo_consulta"],
                "estudiante_nombres": est.get("nombres", "Desconocido"),
                "estudiante_apellidos": est.get("apellidos", "Desconocido"),
                "estudiante_rut": est.get("rut", "Desconocido"),
                "estudiante_carrera": est.get("carrera", "Desconocido"),
                "servicio_nombre": (item.get("servicio") or {}).get("nombre", "Desconocido")
            })
        resultados.sort(key=lambda x: (not x["es_prioritario"], x["fecha_ingreso"]))
        return resultados
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/asignar_hora_manual")
async def asignar_hora_manual(datos: SolicitudAsignacionManual, usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "administrativo":
        raise HTTPException(status_code=403, detail="Exclusivo administrativo.")
    try:
        lista_req = supabase.table("lista_espera").select("*").eq("id_lista", datos.id_lista).execute()
        if not lista_req.data:
            raise HTTPException(status_code=404, detail="Registro en lista de espera no encontrado.")
        espera = lista_req.data[0]

        bloque_req = supabase.table("bloque_horario").select("estado, id_servicio, fecha_hora_inicio").eq("id_bloque", datos.id_bloque).execute()
        if not bloque_req.data or bloque_req.data[0]["estado"] != "disponible":
            raise HTTPException(status_code=400, detail="Bloque no disponible.")
        if bloque_req.data[0]["id_servicio"] != espera["id_servicio"]:
            raise HTTPException(status_code=400, detail="El bloque no corresponde al servicio.")
        if _tiene_conflicto_horario(espera["id_estudiante"], bloque_req.data[0]["fecha_hora_inicio"]):
            raise HTTPException(status_code=409, detail="El estudiante ya tiene otra hora agendada a esa misma fecha y hora.")

        proceso_existente = supabase.table("proceso_clinico").select("id_proceso").eq("id_estudiante", espera["id_estudiante"]).eq("id_servicio", espera["id_servicio"]).eq("estado", "activo").execute()
        if proceso_existente.data:
            id_proceso = proceso_existente.data[0]["id_proceso"]
            supabase.table("proceso_clinico").update({"motivo_consulta": espera["motivo_consulta"], "puntaje_triage": espera.get("puntaje_triage"), "estado_revision": "pendiente"}).eq("id_proceso", id_proceso).execute()
        else:
            proceso_ins = supabase.table("proceso_clinico").insert({"id_estudiante": espera["id_estudiante"], "id_servicio": espera["id_servicio"], "motivo_consulta": espera["motivo_consulta"], "puntaje_triage": espera.get("puntaje_triage")}).execute()
            id_proceso = proceso_ins.data[0]["id_proceso"]

        await _procesar_reserva_bloques(id_proceso, datos.id_bloque, espera.get("fecha_ingreso"))
        supabase.table("lista_espera").delete().eq("id_lista", datos.id_lista).execute()
        await notificar_reserva_directa(espera["id_estudiante"], datos.id_bloque)
        return {"mensaje": "Hora asignada y emparejamiento completado."}
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/riesgo_suspension")
async def obtener_riesgo_suspension(usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "administrativo":
        raise HTTPException(status_code=403, detail="Exclusivo administrativo.")
    try:
        # Limpieza perezosa: reiniciar faltas de suspensiones ya cumplidas y
        # promover a falta las inasistencias con plazo vencido.
        procesar_suspensiones_cumplidas()
        procesar_inasistencias_vencidas()
        filas = fetch_all(lambda: supabase.table("proceso_clinico").select(
            "id_proceso, inasistencias_acumuladas, faltas_acumuladas, estado, estudiante(nombres, apellidos, rut), servicio(nombre)"
        ).gte("faltas_acumuladas", 1).eq("estado", "activo"))
        resultados = []
        for item in filas:
            est = item.get("estudiante") or {}
            resultados.append({
                "id_proceso": item["id_proceso"],
                "faltas_acumuladas": item.get("faltas_acumuladas", 0),
                "inasistencias_acumuladas": item.get("inasistencias_acumuladas", 0),
                "estudiante_nombres": est.get("nombres", "Desconocido"),
                "estudiante_apellidos": est.get("apellidos", "Desconocido"),
                "estudiante_rut": est.get("rut", "Desconocido"),
                "servicio_nombre": (item.get("servicio") or {}).get("nombre", "Desconocido")
            })
        resultados.sort(key=lambda x: x["faltas_acumuladas"], reverse=True)
        return resultados
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/admin/justificaciones")
async def obtener_justificaciones_pendientes(usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "administrativo":
        raise HTTPException(status_code=403, detail="Exclusivo administrativo.")
    try:
        procesar_suspensiones_cumplidas()
        procesar_inasistencias_vencidas()
        filas = fetch_all(lambda: supabase.table("inasistencia").select(
            "id_inasistencia, tipo, estado, motivo_estudiante, fecha_inasistencia, "
            "fecha_justificacion, estudiante(nombres, apellidos, rut), servicio(nombre)"
        ).eq("estado", "pendiente_justificacion"))
        resultados = []
        for it in filas:
            if not it.get("motivo_estudiante"):
                continue  # solo las que el estudiante ya justificó (esperando revisión)
            est = it.get("estudiante") or {}
            resultados.append({
                "id_inasistencia": it["id_inasistencia"],
                "tipo": it["tipo"],
                "motivo_estudiante": it.get("motivo_estudiante"),
                "fecha_inasistencia": it.get("fecha_inasistencia"),
                "fecha_justificacion": it.get("fecha_justificacion"),
                "estudiante_nombres": est.get("nombres", "Desconocido"),
                "estudiante_apellidos": est.get("apellidos", "Desconocido"),
                "estudiante_rut": est.get("rut", "Desconocido"),
                "servicio_nombre": (it.get("servicio") or {}).get("nombre", "Desconocido"),
            })
        resultados.sort(key=lambda x: x.get("fecha_justificacion") or "")
        return resultados
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/admin/resolver_justificacion")
async def resolver_justificacion(datos: SolicitudResolverJustificacion, usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "administrativo":
        raise HTTPException(status_code=403, detail="Exclusivo administrativo.")
    try:
        resultado = await resolver_inasistencia(
            datos.id_inasistencia, datos.aprobada,
            resuelto_por=usuario_actual.get("id_usuario"),
            motivo_resolucion=datos.motivo_resolucion,
        )
        if not resultado.get("ok"):
            raise HTTPException(status_code=404, detail=resultado.get("detail", "No se pudo resolver."))
        return resultado
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/admin/justificar_directo")
async def justificar_directo(datos: SolicitudJustificarDirecto, usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "administrativo":
        raise HTTPException(status_code=403, detail="Exclusivo administrativo.")
    try:
        id_inasistencia = datos.id_inasistencia
        if not id_inasistencia and datos.id_reserva:
            req = supabase.table("inasistencia").select("id_inasistencia").eq("id_reserva", datos.id_reserva).order("fecha_registro", desc=True).limit(1).execute()
            if not req.data:
                raise HTTPException(status_code=404, detail="No hay una inasistencia registrada para esa reserva.")
            id_inasistencia = req.data[0]["id_inasistencia"]
        if not id_inasistencia:
            raise HTTPException(status_code=400, detail="Falta id_inasistencia o id_reserva.")

        resultado = await resolver_inasistencia(
            id_inasistencia, True,
            resuelto_por=usuario_actual.get("id_usuario"),
            motivo_resolucion="Justificada directamente por administración.",
        )
        if not resultado.get("ok"):
            raise HTTPException(status_code=404, detail=resultado.get("detail", "No se pudo justificar."))
        return resultado
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/suspender_servicio")
async def suspender_servicio_admin(solicitud: SolicitudSuspension, usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "administrativo":
        raise HTTPException(status_code=403, detail="Exclusivo administrativo.")
    try:
        proceso_req = supabase.table("proceso_clinico").select("id_estudiante, id_servicio").eq("id_proceso", solicitud.id_proceso).execute()
        if not proceso_req.data:
            raise HTTPException(status_code=404, detail="Proceso no encontrado.")
        p_data = proceso_req.data[0]

        supabase.table("proceso_clinico").update({"estado": "cerrado"}).eq("id_proceso", solicitud.id_proceso).execute()

        reservas_pendientes = supabase.table("reserva").select("id_reserva, id_bloque").eq("id_proceso", solicitud.id_proceso).eq("estado", "pendiente").execute()
        if reservas_pendientes.data:
            ids_reservas = [r["id_reserva"] for r in reservas_pendientes.data]
            ids_bloques = [r["id_bloque"] for r in reservas_pendientes.data]
            supabase.table("reserva").update({"estado": "cancelado_admin_suspension"}).in_("id_reserva", ids_reservas).execute()
            bloques_liberados_req = supabase.table("bloque_horario").update({"estado": "disponible"}).in_("id_bloque", ids_bloques).execute()
            for bloque_liberado in bloques_liberados_req.data:
                await _attempt_automatic_assignment(bloque_liberado["id_bloque"])

        fecha_fin = (datetime.utcnow() + timedelta(days=30)).isoformat()
        supabase.table("suspension_servicio").insert({
            "id_estudiante": p_data["id_estudiante"],
            "id_servicio": p_data["id_servicio"],
            "fecha_fin": fecha_fin
        }).execute()

        await notificar_suspension(p_data["id_estudiante"], p_data["id_servicio"], fecha_fin)

        return {"mensaje": "Estudiante suspendido y bloques devueltos a la comunidad."}
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/admin/suspensiones_activas")
async def obtener_suspensiones_activas(usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "administrativo":
        raise HTTPException(status_code=403, detail="Exclusivo administrativo.")
    try:
        # Reiniciar faltas de las suspensiones ya cumplidas antes de listar las activas.
        procesar_suspensiones_cumplidas()
        filas = fetch_all(lambda: supabase.table("suspension_servicio").select(
            "id_suspension, id_estudiante, id_servicio, fecha_fin, "
            "estudiante(nombres, apellidos, rut), servicio(nombre)"
        ).gt("fecha_fin", datetime.utcnow().isoformat()))

        # Agrupar por estudiante: un estudiante puede estar suspendido de varios servicios.
        estudiantes = {}
        for s in filas:
            est = s.get("estudiante") or {}
            id_est = s["id_estudiante"]
            if id_est not in estudiantes:
                estudiantes[id_est] = {
                    "id_estudiante": id_est,
                    "estudiante_nombres": est.get("nombres", "Desconocido"),
                    "estudiante_apellidos": est.get("apellidos", "Desconocido"),
                    "estudiante_rut": est.get("rut", "Desconocido"),
                    "suspensiones": []
                }
            estudiantes[id_est]["suspensiones"].append({
                "id_suspension": s["id_suspension"],
                "id_servicio": s["id_servicio"],
                "servicio_nombre": (s.get("servicio") or {}).get("nombre", "Desconocido"),
                "fecha_fin": s.get("fecha_fin"),
            })

        resultados = list(estudiantes.values())
        resultados.sort(key=lambda x: (x["estudiante_apellidos"], x["estudiante_nombres"]))
        return resultados
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/admin/levantar_suspension")
async def levantar_suspension(solicitud: SolicitudLevantarSuspension, usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "administrativo":
        raise HTTPException(status_code=403, detail="Exclusivo administrativo.")
    try:
        susp_req = supabase.table("suspension_servicio").select(
            "id_suspension, id_estudiante, id_servicio"
        ).eq("id_suspension", solicitud.id_suspension).execute()
        if not susp_req.data:
            raise HTTPException(status_code=404, detail="Suspensión no encontrada.")
        susp = susp_req.data[0]
        # Al levantar la suspensión se reinicia la cuenta: las faltas previas de ese
        # servicio se borran y los contadores quedan en cero (parte de cero).
        reiniciar_faltas_servicio(
            susp["id_estudiante"], susp["id_servicio"], datetime.utcnow().isoformat()
        )
        supabase.table("suspension_servicio").delete().eq("id_suspension", solicitud.id_suspension).execute()
        return {"mensaje": "Suspensión levantada y faltas reiniciadas. El estudiante parte de cero en este servicio."}
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/admin/reducir_inasistencia/{id_proceso}")
async def reducir_inasistencia(id_proceso: str, usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "administrativo":
        raise HTTPException(status_code=403, detail="Exclusivo administrativo.")
    try:
        proc_req = supabase.table("proceso_clinico").select("faltas_acumuladas").eq("id_proceso", id_proceso).execute()
        if not proc_req.data:
            raise HTTPException(status_code=404, detail="Proceso no encontrado.")
        actual = proc_req.data[0].get("faltas_acumuladas") or 0
        if actual > 0:
            supabase.table("proceso_clinico").update({"faltas_acumuladas": actual - 1}).eq("id_proceso", id_proceso).execute()
        return {"mensaje": "Falta reducida exitosamente."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/marcar_critico")
async def activar_protocolo_critico(solicitud: SolicitudCritico, usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "administrativo":
        raise HTTPException(status_code=403, detail="Exclusivo administrativo.")
    try:
        proceso_req = supabase.table("proceso_clinico").select("id_proceso, id_estudiante").eq("id_proceso", solicitud.id_proceso).execute()
        if not proceso_req.data:
            raise HTTPException(status_code=404, detail="Proceso clínico no encontrado.")
        id_estudiante = proceso_req.data[0]["id_estudiante"]

        todos_procesos_req = supabase.table("proceso_clinico").select("id_proceso").eq("id_estudiante", id_estudiante).execute()
        if todos_procesos_req.data:
            ids_procesos = [p["id_proceso"] for p in todos_procesos_req.data]
            supabase.table("proceso_clinico").update({"es_caso_critico": True, "estado": "cerrado", "estado_revision": "revisado"}).in_("id_proceso", ids_procesos).execute()
            reservas_req = supabase.table("reserva").select("id_reserva, id_bloque").in_("id_proceso", ids_procesos).eq("estado", "pendiente").execute()
            if reservas_req.data:
                supabase.table("reserva").update({"estado": "cancelado_protocolo_critico"}).in_("id_reserva", [r["id_reserva"] for r in reservas_req.data]).execute()
                # Los bloques vuelven a estar disponibles para otros estudiantes
                # (mismo criterio que aprobar_critico y el flujo del profesional).
                supabase.table("bloque_horario").update({"estado": "disponible"}).in_("id_bloque", [r["id_bloque"] for r in reservas_req.data]).execute()

        # Marcar al estudiante como caso crítico activo: sale del sistema de agendamiento
        # (la asignación automática lo salta) igual que en los otros dos flujos críticos.
        supabase.table("estudiante").update({
            "es_caso_critico_activo": True,
            "estado_critico": "confirmado_critico",
            "fecha_marcado_critico": datetime.now().isoformat()
        }).eq("id_estudiante", id_estudiante).execute()
        supabase.table("lista_espera").delete().eq("id_estudiante", id_estudiante).execute()

        return {"mensaje": "Protocolo de emergencia activado."}
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/reagendar")
async def reagendar_reserva(datos: SolicitudReagendamiento, usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "administrativo":
        raise HTTPException(status_code=403, detail="Exclusivo administrativo.")
    try:
        reserva_original_req = supabase.table("reserva").select(
            "id_proceso, id_bloque, bloque_horario(id_servicio), proceso_clinico(id_estudiante)"
        ).eq("id_reserva", datos.id_reserva_original).execute()
        if not reserva_original_req.data:
            raise HTTPException(status_code=404, detail="Reserva original no encontrada.")
        id_proceso = reserva_original_req.data[0]["id_proceso"]
        id_bloque_antiguo = reserva_original_req.data[0]["id_bloque"]
        servicio_original = (reserva_original_req.data[0].get("bloque_horario") or {}).get("id_servicio")
        id_estudiante_reserva = (reserva_original_req.data[0].get("proceso_clinico") or {}).get("id_estudiante")

        bloque_nuevo_req = supabase.table("bloque_horario").select("estado, id_servicio, fecha_hora_inicio").eq("id_bloque", datos.id_bloque_nuevo).execute()
        if not bloque_nuevo_req.data or bloque_nuevo_req.data[0]["estado"] not in ["disponible", "huerfano"]:
            raise HTTPException(status_code=400, detail="El nuevo bloque no es apto.")
        if servicio_original and bloque_nuevo_req.data[0]["id_servicio"] != servicio_original:
            raise HTTPException(status_code=400, detail="El nuevo bloque no corresponde al mismo servicio de la reserva original.")
        if id_estudiante_reserva and _tiene_conflicto_horario(id_estudiante_reserva, bloque_nuevo_req.data[0]["fecha_hora_inicio"], id_reserva_excluir=datos.id_reserva_original):
            raise HTTPException(status_code=409, detail="El estudiante ya tiene otra hora agendada a esa misma fecha y hora.")

        supabase.table("reserva").update({"estado": "cancelado_profesional"}).eq("id_reserva", datos.id_reserva_original).execute()
        bloques_liberados = supabase.table("bloque_horario").update({"estado": "disponible"}).eq("id_bloque", id_bloque_antiguo).execute()
        supabase.table("bloque_horario").update({"estado": "confirmado"}).eq("id_bloque", datos.id_bloque_nuevo).execute()
        nueva_reserva_ins = supabase.table("reserva").insert({"id_proceso": id_proceso, "id_bloque": datos.id_bloque_nuevo}).execute()
        for bl in bloques_liberados.data:
            await _attempt_automatic_assignment(bl["id_bloque"])
        return {"mensaje": "Reagendamiento completado.", "nueva_reserva": nueva_reserva_ins.data[0]}
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/admin/cambiar_serie")
async def cambiar_serie_ciclica(datos: SolicitudCambiarSerie, usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "administrativo":
        raise HTTPException(status_code=403, detail="Exclusivo administrativo.")
    try:
        proceso_req = supabase.table("proceso_clinico").select("id_proceso, id_servicio, estado").eq("id_proceso", datos.id_proceso).execute()
        if not proceso_req.data or proceso_req.data[0]["estado"] != "activo":
            raise HTTPException(status_code=404, detail="Proceso no encontrado o no activo.")

        id_servicio = proceso_req.data[0]["id_servicio"]
        bloque_req = supabase.table("bloque_horario").select("estado, id_servicio").eq("id_bloque", datos.id_bloque_nuevo).execute()
        if not bloque_req.data or bloque_req.data[0]["estado"] != "disponible":
            raise HTTPException(status_code=400, detail="El bloque seleccionado no está disponible.")
        if bloque_req.data[0]["id_servicio"] != id_servicio:
            raise HTTPException(status_code=400, detail="El bloque no corresponde al servicio del proceso.")

        resultado = await reagendar_serie_ciclica(datos.id_proceso, datos.id_bloque_nuevo)
        if resultado is None:
            raise HTTPException(status_code=400, detail="No se pudo cambiar la serie. Verifica que sea cíclico, esté activo y tenga sesiones pendientes futuras.")

        return {"mensaje": "Horario del ciclo cambiado exitosamente.", "primera_reserva": resultado}
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/admin/cancelar_serie_a_lista_espera")
async def cancelar_serie_a_lista_espera_endpoint(datos: SolicitudListaEsperaSerie, usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "administrativo":
        raise HTTPException(status_code=403, detail="Exclusivo administrativo.")
    try:
        proceso_req = supabase.table("proceso_clinico").select("id_servicio, estado").eq("id_proceso", datos.id_proceso).execute()
        if not proceso_req.data or proceso_req.data[0]["estado"] != "activo":
            raise HTTPException(status_code=404, detail="Proceso no encontrado o no activo.")

        servicio_req = supabase.table("servicio").select("es_ciclico").eq("id_servicio", proceso_req.data[0]["id_servicio"]).execute()
        if not servicio_req.data or not servicio_req.data[0]["es_ciclico"]:
            raise HTTPException(status_code=400, detail="El proceso no corresponde a un servicio cíclico.")

        id_lista = await cancelar_serie_a_lista_espera(
            datos.id_proceso,
            disponibilidad_indicada=datos.disponibilidad_indicada,
            campus_indicados=datos.campus_indicados,
        )
        if id_lista is None:
            raise HTTPException(status_code=400, detail="No se pudo procesar. Verifica que el proceso esté activo y tenga sesiones futuras pendientes.")

        return {"mensaje": "Sesiones canceladas. Estudiante registrado en lista de espera prioritaria.", "id_lista": id_lista}
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/limpiar_ofertas_vencidas")
async def limpiar_ofertas_vencidas(usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "administrativo":
        raise HTTPException(status_code=403, detail="Exclusivo administrativo.")
    try:
        vencidas_req = supabase.table("lista_espera").select("id_lista, disponibilidad_indicada").eq("estado_oferta", "ofertado").lt("vencimiento_oferta", datetime.utcnow().isoformat()).execute()
        if not vencidas_req.data:
            return {"mensaje": "No se encontraron ofertas vencidas."}
        id_bloques_liberar = []
        for oferta in vencidas_req.data:
            disponibilidad = oferta["disponibilidad_indicada"]
            id_bloque = disponibilidad.pop("bloque_ofertado", None)
            if id_bloque:
                id_bloques_liberar.append(id_bloque)
            supabase.table("lista_espera").update({"estado_oferta": "esperando", "vencimiento_oferta": None, "disponibilidad_indicada": disponibilidad}).eq("id_lista", oferta["id_lista"]).execute()
        if id_bloques_liberar:
            supabase.table("bloque_horario").update({"estado": "disponible"}).in_("id_bloque", id_bloques_liberar).execute()
        return {"mensaje": f"Se limpiaron {len(vencidas_req.data)} ofertas vencidas."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---- Endpoints /admin/* ----

@router.patch("/admin/marcar_critico/{id_lista}")
async def marcar_critico_admin(id_lista: str, usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "administrativo":
        raise HTTPException(status_code=403, detail="Exclusivo administrativo.")
    try:
        req = supabase.table("lista_espera").update({"es_prioritario": True}).eq("id_lista", id_lista).execute()
        if not req.data:
            raise HTTPException(status_code=404, detail="Registro no encontrado.")
        return {"mensaje": "Estudiante marcado como caso crítico."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/admin/estudiantes")
async def obtener_estudiantes_global(usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] not in ["administrativo", "profesional", "coordinador"]:
        raise HTTPException(status_code=403, detail="Acceso denegado.")
    try:
        if usuario_actual["rol"] in ["administrativo", "coordinador"]:
            return fetch_all(lambda: supabase.table("estudiante").select("*").order("apellidos"))

        # Profesional: solo sus pacientes. Se filtra por el profesional del bloque con un
        # join !inner (evita traer miles de ids de bloques y armar URLs gigantes).
        id_prof = usuario_actual["id_profesional"]
        reservas = fetch_all(lambda: supabase.table("reserva").select(
            "proceso_clinico(id_estudiante), bloque_horario!inner(id_profesional)"
        ).eq("bloque_horario.id_profesional", id_prof))
        ids_estudiantes = list(set(r["proceso_clinico"]["id_estudiante"] for r in reservas if r.get("proceso_clinico")))
        if not ids_estudiantes:
            return []
        estudiantes = []
        for lote in in_chunks(ids_estudiantes):
            est_req = supabase.table("estudiante").select("*").in_("id_estudiante", lote).execute()
            estudiantes.extend(est_req.data or [])
        estudiantes.sort(key=lambda e: (e.get("apellidos") or "", e.get("nombres") or ""))
        return estudiantes
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/admin/demanda_espera")
async def obtener_demanda_espera(usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] not in ROLES_ADMIN:
        raise HTTPException(status_code=403, detail="Acceso denegado.")
    try:
        return fetch_all(lambda: supabase.table("lista_espera").select(
            "id_lista, fecha_ingreso, es_prioritario, disponibilidad_indicada, motivo_consulta, campus_indicados, "
            "estudiante(nombres, apellidos, rut, carrera), servicio(id_servicio, nombre)"
        ).eq("estado_oferta", "esperando"))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/admin/calendario_reservas")
async def obtener_calendario_reservas(usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] not in ROLES_ADMIN:
        raise HTTPException(status_code=403, detail="Acceso denegado.")
    try:
        return fetch_all(lambda: supabase.table("reserva").select(
            "id_reserva, estado, bloque_horario(id_servicio, fecha_hora_inicio, fecha_hora_fin, profesional(nombres, apellidos), servicio(nombre), ubicacion(id_ubicacion, nombre)), proceso_clinico(estudiante(nombres, apellidos, rut))"
        ).in_("estado", ["pendiente", "presente"]))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/admin/sesiones_sin_registrar")
async def obtener_sesiones_sin_registrar(usuario_actual: dict = Depends(obtener_usuario_actual)):
    """Citas cuyo bloque ya pasó, siguen 'pendiente' (sin decisión de asistencia) y aún
    no tienen evolución clínica. Para que administración pueda marcar ausente sin llenar ficha."""
    if usuario_actual["rol"] not in ROLES_ADMIN:
        raise HTTPException(status_code=403, detail="Acceso denegado.")
    try:
        ahora_str = ahora_chile().isoformat()
        # Reservas pendientes (conjunto acotado) con bloque embebido; la fecha se filtra en
        # Python para evitar un .in_() sobre todos los bloques pasados (URL demasiado larga).
        reservas_rows = fetch_all(lambda: supabase.table("reserva").select(
            "id_reserva, bloque_horario!inner(fecha_hora_inicio, id_servicio, servicio(nombre), id_profesional, profesional(nombres, apellidos)), "
            "proceso_clinico(estudiante(nombres, apellidos, rut))"
        ).eq("estado", "pendiente").lte("bloque_horario.fecha_hora_inicio", ahora_str))

        # Quedarse solo con las citas cuyo bloque ya pasó (doble filtro por robustez).
        pasadas = []
        for r in reservas_rows:
            b = r.get("bloque_horario") or {}
            fh = b.get("fecha_hora_inicio")
            if fh and fh <= ahora_str:
                pasadas.append(r)

        # Excluir de forma robusta las reservas que ya tienen evolución (consulta explícita,
        # en trozos para no generar URLs gigantes con miles de ids).
        ids_reservas = [r["id_reserva"] for r in pasadas]
        reservas_con_evolucion = set()
        for lote in in_chunks(ids_reservas):
            evol_req = supabase.table("evolucion_clinica").select("id_reserva").in_("id_reserva", lote).execute()
            reservas_con_evolucion.update(e["id_reserva"] for e in (evol_req.data or []))

        sesiones = []
        for r in pasadas:
            if r["id_reserva"] in reservas_con_evolucion:
                continue
            b = r.get("bloque_horario") or {}
            prof = b.get("profesional") or {}
            serv = b.get("servicio") or {}
            proc = r.get("proceso_clinico") or {}
            est = proc.get("estudiante") or {}
            sesiones.append({
                "id_reserva": r["id_reserva"],
                "fecha": b.get("fecha_hora_inicio"),
                "id_servicio": b.get("id_servicio"),
                "servicio_nombre": serv.get("nombre", "Desconocido"),
                "id_profesional": b.get("id_profesional"),
                "profesional_nombres": prof.get("nombres", "Desconocido"),
                "profesional_apellidos": prof.get("apellidos", ""),
                "estudiante_nombres": est.get("nombres", "Desconocido"),
                "estudiante_apellidos": est.get("apellidos", ""),
                "estudiante_rut": est.get("rut", "")
            })
        sesiones.sort(key=lambda x: x["fecha"])
        return sesiones
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/admin/estudiantes/{id_estudiante}/reservas")
async def obtener_reservas_estudiante_admin(id_estudiante: str, usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] not in ["administrativo", "profesional", "coordinador"]:
        raise HTTPException(status_code=403, detail="Acceso denegado.")
    try:
        if usuario_actual["rol"] == "profesional":
            id_prof = usuario_actual["id_profesional"]
            procesos_val_req = supabase.table("proceso_clinico").select("id_proceso").eq("id_estudiante", id_estudiante).execute()
            if not procesos_val_req.data:
                raise HTTPException(status_code=403, detail="El estudiante no tiene historial clínico.")
            relacion_req = supabase.table("reserva").select(
                "id_reserva, bloque_horario!inner(id_profesional)"
            ).in_("id_proceso", [p["id_proceso"] for p in procesos_val_req.data]).eq(
                "bloque_horario.id_profesional", id_prof
            ).limit(1).execute()
            if not relacion_req.data:
                raise HTTPException(status_code=403, detail="Solo puedes ver tus propios pacientes.")

        procesos_req = supabase.table("proceso_clinico").select("id_proceso, id_servicio, fecha_inicio, motivo_consulta, estado, sesiones_realizadas, inasistencias_acumuladas, faltas_acumuladas, servicio(nombre, es_ciclico)").eq("id_estudiante", id_estudiante).execute()
        if not procesos_req.data:
            return []

        procesos = procesos_req.data
        ids_procesos = [p["id_proceso"] for p in procesos]
        req = supabase.table("reserva").select(
            "id_reserva, id_proceso, estado, bloque_horario(fecha_hora_inicio, profesional(nombres, apellidos)), evolucion_clinica(id_evolucion, observaciones, diagnostico, plan_tratamiento)"
        ).in_("id_proceso", ids_procesos).execute()

        # Inasistencias por reserva (para mostrar/justificar desde el perfil)
        inasistencia_por_reserva = {}
        try:
            ina_req = supabase.table("inasistencia").select(
                "id_inasistencia, id_reserva, estado"
            ).eq("id_estudiante", id_estudiante).execute()
            for ina in (ina_req.data or []):
                if ina.get("id_reserva"):
                    inasistencia_por_reserva[ina["id_reserva"]] = ina
        except Exception as e:
            print(f"[admin] No se pudieron leer inasistencias: {e}")

        reservas_por_proceso = {}
        evolucion_to_servicio_origen = {}
        for r in req.data:
            pid = r["id_proceso"]
            if pid not in reservas_por_proceso:
                reservas_por_proceso[pid] = []
            bloque = r.get("bloque_horario") or {}
            prof = bloque.get("profesional") or {}
            evo = r.get("evolucion_clinica") or []
            evo = evo[0] if isinstance(evo, list) and len(evo) > 0 else (None if isinstance(evo, list) else evo)
            if evo and evo.get("id_evolucion"):
                for p in procesos:
                    if p["id_proceso"] == pid:
                        evolucion_to_servicio_origen[evo["id_evolucion"]] = p.get("servicio", {}).get("nombre", "Desconocido")
                        break
            ina = inasistencia_por_reserva.get(r["id_reserva"])
            reservas_por_proceso[pid].append({
                "id_reserva": r["id_reserva"],
                "estado": r["estado"],
                "fecha": bloque.get("fecha_hora_inicio"),
                "profesional_nombres": prof.get("nombres", ""),
                "profesional_apellidos": prof.get("apellidos", ""),
                "evolucion": evo,
                "inasistencia_estado": ina.get("estado") if ina else None,
            })

        resultados = []
        for p in procesos:
            motivo = p.get("motivo_consulta") or ""
            es_derivacion = "Derivación interna" in motivo
            servicio_origen = None
            if es_derivacion and "Ref. Evolución: " in motivo:
                evo_id = motivo.split("Ref. Evolución: ")[1].strip()
                servicio_origen = evolucion_to_servicio_origen.get(evo_id)

            res_proceso = reservas_por_proceso.get(p["id_proceso"], [])
            todas_canceladas = all(r["estado"].startswith("cancelado") for r in res_proceso) if res_proceso else True
            nunca_paso = (p.get("sesiones_realizadas") or 0) == 0
            es_ciclico = p.get("servicio", {}).get("es_ciclico", False)
            estado_proceso = p["estado"]

            if nunca_paso and todas_canceladas and not es_ciclico:
                continue
            if estado_proceso == "activo" and todas_canceladas:
                estado_proceso = "cancelado"

            res_proceso.sort(key=lambda x: x["fecha"] if x["fecha"] else "", reverse=True)
            resultados.append({
                "id_proceso": p["id_proceso"],
                "id_servicio": p["id_servicio"],
                "servicio_nombre": p.get("servicio", {}).get("nombre", "Desconocido"),
                "es_ciclico": es_ciclico,
                "estado": estado_proceso,
                "fecha_inicio": p["fecha_inicio"],
                "sesiones_realizadas": p.get("sesiones_realizadas") or 0,
                "inasistencias_acumuladas": p.get("inasistencias_acumuladas") or 0,
                "faltas_acumuladas": p.get("faltas_acumuladas") or 0,
                "es_derivacion": es_derivacion,
                "servicio_origen": servicio_origen,
                "motivo_consulta": motivo,
                "reservas": res_proceso
            })

        resultados.sort(key=lambda x: x["fecha_inicio"] if x["fecha_inicio"] else "", reverse=True)
        return resultados
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/admin/cancelar_reserva")
async def cancelar_reserva_admin(datos: SolicitudCancelarReservaAdmin, usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] not in ROLES_ADMIN:
        raise HTTPException(status_code=403, detail="Acceso denegado.")
    try:
        res_req = supabase.table("reserva").select("id_bloque, estado").eq("id_reserva", datos.id_reserva).execute()
        if not res_req.data:
            raise HTTPException(status_code=404, detail="Reserva no encontrada")
        id_bloque = res_req.data[0]["id_bloque"]
        supabase.table("reserva").update({"estado": "cancelado_admin_suspension"}).eq("id_reserva", datos.id_reserva).execute()
        bloques_liberados = supabase.table("bloque_horario").update({"estado": "disponible"}).eq("id_bloque", id_bloque).execute()
        for bl in bloques_liberados.data:
            await _attempt_automatic_assignment(bl["id_bloque"])
        return {"mensaje": "Reserva cancelada y bloque liberado."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/admin/agendar_hora")
async def agendar_hora_admin(datos: SolicitudAgendarHoraAdmin, usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] not in ROLES_ADMIN:
        raise HTTPException(status_code=403, detail="Acceso denegado.")
    if not datos.id_bloque and not (datos.tipo_agendamiento == "prioritario" and datos.disponibilidad_indicada):
        raise HTTPException(status_code=400, detail="Debe proporcionar un bloque o disponibilidad para lista prioritaria.")
    try:
        id_proceso = None
        proceso_req = supabase.table("proceso_clinico").select("id_proceso").eq("id_estudiante", datos.id_estudiante).eq("id_servicio", datos.id_servicio).eq("estado", "activo").execute()

        if proceso_req.data:
            id_proceso = proceso_req.data[0]["id_proceso"]
            if supabase.table("reserva").select("id_reserva").eq("id_proceso", id_proceso).eq("estado", "pendiente").execute().data:
                raise HTTPException(status_code=400, detail="El estudiante ya tiene una reserva activa para este servicio.")
            supabase.table("proceso_clinico").update({"motivo_consulta": datos.motivo_consulta, "estado_revision": "pendiente"}).eq("id_proceso", id_proceso).execute()
        elif datos.id_bloque:
            proc_ins = supabase.table("proceso_clinico").insert({
                "id_estudiante": datos.id_estudiante,
                "id_servicio": datos.id_servicio,
                "motivo_consulta": datos.motivo_consulta,
                "estado": "activo",
                "estado_revision": "pendiente"
            }).execute()
            id_proceso = proc_ins.data[0]["id_proceso"]

        if datos.id_bloque and id_proceso:
            bloque_req = supabase.table("bloque_horario").select("estado, fecha_hora_inicio, id_ubicacion").eq("id_bloque", datos.id_bloque).execute()
            if not bloque_req.data or bloque_req.data[0]["estado"] != "disponible":
                raise HTTPException(status_code=400, detail="El bloque ya no está disponible.")
            if _tiene_conflicto_horario(datos.id_estudiante, bloque_req.data[0]["fecha_hora_inicio"]):
                raise HTTPException(status_code=409, detail="El estudiante ya tiene otra hora agendada a esa misma fecha y hora.")
            candidatos_q = supabase.table("bloque_horario").select("id_bloque, id_profesional").eq("id_servicio", datos.id_servicio).eq("fecha_hora_inicio", bloque_req.data[0]["fecha_hora_inicio"]).eq("estado", "disponible")
            id_ubicacion_bloque = bloque_req.data[0].get("id_ubicacion")
            candidatos_q = candidatos_q.eq("id_ubicacion", id_ubicacion_bloque) if id_ubicacion_bloque else candidatos_q.is_("id_ubicacion", "null")
            candidatos_req = candidatos_q.execute()
            id_bloque_final = _seleccionar_mejor_bloque(candidatos_req.data) if candidatos_req.data else datos.id_bloque
            # Si el estudiante venía esperando en la lista, preservar su fecha de ingreso para
            # poder medir después el tramo de espera por lista de espera (se borra abajo).
            espera_prev = supabase.table("lista_espera").select("fecha_ingreso").eq("id_estudiante", datos.id_estudiante).eq("id_servicio", datos.id_servicio).order("fecha_ingreso", desc=False).limit(1).execute()
            fecha_ingreso_prev = espera_prev.data[0]["fecha_ingreso"] if espera_prev.data else None
            await _procesar_reserva_bloques(id_proceso, id_bloque_final, fecha_ingreso_prev)
            supabase.table("lista_espera").delete().eq("id_estudiante", datos.id_estudiante).eq("id_servicio", datos.id_servicio).execute()
            await notificar_reserva_directa(datos.id_estudiante, id_bloque_final)

        if datos.tipo_agendamiento == "prioritario" and datos.disponibilidad_indicada:
            supabase.table("lista_espera").delete().eq("id_estudiante", datos.id_estudiante).eq("id_servicio", datos.id_servicio).execute()
            ins_lista = supabase.table("lista_espera").insert({
                "id_estudiante": datos.id_estudiante,
                "id_servicio": datos.id_servicio,
                "es_prioritario": True,
                "disponibilidad_indicada": datos.disponibilidad_indicada,
                "campus_indicados": datos.campus_indicados,
                "motivo_consulta": datos.motivo_consulta,
                "estado_oferta": "esperando",
                "estado_revision": "revisado" if datos.id_bloque else "pendiente"
            }).execute()
            if ins_lista.data:
                await _attempt_automatic_assignment_for_student(ins_lista.data[0]["id_lista"])

        return {"mensaje": "Agendamiento completado."}
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---- Triage ----

@router.patch("/admin/triage/{origen}/{id_item}/revisado")
async def marcar_revisado_triage(origen: str, id_item: str, usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "administrativo":
        raise HTTPException(status_code=403)
    try:
        tabla = "lista_espera" if origen == "lista_espera" else "proceso_clinico"
        columna_id = "id_lista" if origen == "lista_espera" else "id_proceso"
        req = supabase.table(tabla).select("id_estudiante, id_servicio").eq(columna_id, id_item).execute()
        if req.data:
            id_est = req.data[0]["id_estudiante"]
            id_srv = req.data[0]["id_servicio"]
            supabase.table("lista_espera").update({"estado_revision": "revisado"}).eq("id_estudiante", id_est).eq("id_servicio", id_srv).execute()
            supabase.table("proceso_clinico").update({"estado_revision": "revisado"}).eq("id_estudiante", id_est).eq("id_servicio", id_srv).execute()
        else:
            supabase.table(tabla).update({"estado_revision": "revisado"}).eq(columna_id, id_item).execute()
        return {"mensaje": "Marcado como leído."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/admin/triage/{origen}/{id_item}/critico")
async def marcar_critico_triage(origen: str, id_item: str, usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "administrativo":
        raise HTTPException(status_code=403, detail="Exclusivo administrativo.")
    try:
        id_estudiante = None
        id_servicio = None
        motivo_consulta = None
        servicio_nombre = None

        if origen == "lista_espera":
            espera_req = supabase.table("lista_espera").select("id_estudiante, id_servicio, motivo_consulta, servicio:id_servicio(nombre)").eq("id_lista", id_item).execute()
            if espera_req.data:
                espera = espera_req.data[0]
                id_estudiante = espera["id_estudiante"]
                id_servicio = espera["id_servicio"]
                motivo_consulta = espera.get("motivo_consulta")
                servicio_nombre = (espera.get("servicio") or {}).get("nombre")
        elif origen == "proceso_clinico":
            proc_req = supabase.table("proceso_clinico").select("id_estudiante, id_servicio, motivo_consulta, servicio:id_servicio(nombre)").eq("id_proceso", id_item).execute()
            if proc_req.data:
                proceso = proc_req.data[0]
                id_estudiante = proceso["id_estudiante"]
                id_servicio = proceso["id_servicio"]
                motivo_consulta = proceso.get("motivo_consulta")
                servicio_nombre = (proceso.get("servicio") or {}).get("nombre")

        if not id_estudiante:
            raise HTTPException(status_code=404, detail="Estudiante no encontrado.")

        supabase.table("lista_espera").update({"estado_revision": "revisado"}).eq("id_estudiante", id_estudiante).eq("id_servicio", id_servicio).execute()
        supabase.table("proceso_clinico").update({"estado_revision": "revisado"}).eq("id_estudiante", id_estudiante).eq("id_servicio", id_servicio).execute()

        supabase.table("estudiante").update({
            "estado_critico": "pendiente_coordinador",
            "motivo_caso_critico": _construir_motivo_caso_critico(origen, motivo_consulta, servicio_nombre),
            "fecha_marcado_critico": datetime.now().isoformat()
        }).eq("id_estudiante", id_estudiante).execute()

        return {"mensaje": "Estudiante marcado como caso crítico pendiente de revisión."}
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/admin/triage")
async def obtener_triage_unificado(usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "administrativo":
        raise HTTPException(status_code=403, detail="Exclusivo administrativo.")
    try:
        resultados = []

        req_espera = supabase.table("lista_espera").select(
            "id_lista, id_servicio, fecha_ingreso, motivo_consulta, estudiante:id_estudiante(rut, nombres, apellidos), servicio:id_servicio(nombre)"
        ).eq("estado_revision", "pendiente").execute()
        for item in (req_espera.data or []):
            resultados.append({
                "origen": "lista_espera",
                "id": item["id_lista"],
                "id_servicio": item["id_servicio"],
                "fecha": item["fecha_ingreso"],
                "motivo_consulta": item["motivo_consulta"],
                "estudiante_rut": item["estudiante"]["rut"],
                "estudiante_nombres": item["estudiante"]["nombres"],
                "estudiante_apellidos": item["estudiante"]["apellidos"],
                "servicio_nombre": item["servicio"]["nombre"]
            })

        req_proceso = supabase.table("proceso_clinico").select(
            "id_proceso, id_servicio, fecha_inicio, motivo_consulta, estudiante:id_estudiante(rut, nombres, apellidos), servicio:id_servicio(nombre), reserva(estado)"
        ).eq("estado_revision", "pendiente").execute()
        for item in (req_proceso.data or []):
            reservas = item.get("reserva") or []
            if reservas and not any(r.get("estado") in ["pendiente", "presente"] for r in reservas):
                continue
            resultados.append({
                "origen": "proceso_clinico",
                "id": item["id_proceso"],
                "id_servicio": item["id_servicio"],
                "fecha": item["fecha_inicio"],
                "motivo_consulta": item["motivo_consulta"],
                "estudiante_rut": item["estudiante"]["rut"],
                "estudiante_nombres": item["estudiante"]["nombres"],
                "estudiante_apellidos": item["estudiante"]["apellidos"],
                "servicio_nombre": item["servicio"]["nombre"]
            })

        pares_con_hora = {(r["estudiante_rut"], r["id_servicio"]) for r in resultados if r["origen"] == "proceso_clinico"}
        resultados = [
            r for r in resultados
            if r["origen"] == "proceso_clinico"
            or (r["estudiante_rut"], r["id_servicio"]) not in pares_con_hora
        ]
        resultados.sort(key=lambda x: x["fecha"])
        return resultados
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/admin/casos_criticos")
async def obtener_casos_criticos(usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "administrativo":
        raise HTTPException(status_code=403, detail="Exclusivo administrativo.")
    try:
        req = supabase.table("estudiante").select(
            "id_estudiante, rut, nombres, apellidos, carrera, motivo_caso_critico, fecha_marcado_critico"
        ).eq("es_caso_critico_activo", True).execute()
        casos = req.data if req.data else []
        for caso in casos:
            motivo = caso.get("motivo_caso_critico") or ""
            caso["fecha"] = caso.get("fecha_marcado_critico")
            caso["motivo"] = motivo
            caso["origen"] = "Profesional" if "proceso clinico" in motivo else ("Admin / Triage" if "lista de espera" in motivo else "Sistema")
            servicio_encontrado = next((p.replace("Servicio:", "").strip() for p in motivo.split("|") if p.strip().startswith("Servicio:")), None)
            caso["servicio"] = servicio_encontrado or "N/A"
        return casos
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
