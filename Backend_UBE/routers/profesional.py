from datetime import datetime, timedelta
from fastapi import APIRouter, HTTPException, Depends, Query
from database import supabase
from dependencies import obtener_usuario_actual
from schemas import SolicitudAsistencia, SolicitudEvolucion
from services.asignacion import _procesar_reserva_bloques, _attempt_automatic_assignment, _attempt_automatic_assignment_for_student, _seleccionar_mejor_bloque, extender_serie_ciclica, liberar_retencion_slot
from services.notificaciones import notificar_reserva_directa, notificar_inasistencia_registrada
from services.inasistencias import registrar_inasistencia
from services.triage import _construir_motivo_caso_critico
from utils_tiempo import ahora_chile

router = APIRouter()


@router.get("/mis_servicios")
async def obtener_mis_servicios(usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "profesional" or not usuario_actual["id_profesional"]:
        raise HTTPException(status_code=403, detail="Exclusivo para profesionales.")
    try:
        req = supabase.table("profesional_servicio").select("servicio(id_servicio, nombre, es_ciclico, duracion_minutos)").eq("id_profesional", usuario_actual["id_profesional"]).execute()
        return [item["servicio"] for item in req.data if item.get("servicio")]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/bloques")
async def obtener_mis_bloques(usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "profesional" or not usuario_actual["id_profesional"]:
        raise HTTPException(status_code=403, detail="Exclusivo para profesionales.")
    try:
        bloques_req = supabase.table("bloque_horario").select(
            "id_bloque, id_servicio, fecha_hora_inicio, fecha_hora_fin, estado, servicio(nombre, acronimo), "
            "ubicacion(id_ubicacion, nombre, abreviatura), "
            "reserva(estado, proceso_clinico(estudiante(nombres, apellidos)))"
        ).eq("id_profesional", usuario_actual["id_profesional"]).execute()

        resultados = []
        for b in bloques_req.data:
            est_nombres = est_apellidos = None
            for r in (b.get("reserva") or []):
                if r.get("estado") in ["pendiente", "presente"]:
                    est = ((r.get("proceso_clinico") or {}).get("estudiante") or {})
                    est_nombres = est.get("nombres")
                    est_apellidos = est.get("apellidos")
                    break
            item = {k: b[k] for k in ["id_bloque", "id_servicio", "fecha_hora_inicio", "fecha_hora_fin", "estado"]}
            item["servicio"] = b.get("servicio", {})
            item["ubicacion"] = b.get("ubicacion")
            if est_nombres:
                item["estudiante_nombres"] = est_nombres
                item["estudiante_apellidos"] = est_apellidos
            resultados.append(item)
        return resultados
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/asistencia")
async def registrar_asistencia(datos: SolicitudAsistencia, usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] not in ["administrativo", "profesional", "coordinador"]:
        raise HTTPException(status_code=403, detail="Registro exclusivo para administrativos, profesionales y coordinadores.")
    if datos.estado not in ["presente", "ausente", "atraso"]:
        raise HTTPException(status_code=400, detail="Estado de asistencia no admitido.")
    try:
        reserva_req = supabase.table("reserva").select(
            "id_proceso, bloque_horario(fecha_hora_inicio), "
            "proceso_clinico(id_estudiante, id_servicio, inasistencias_acumuladas)"
        ).eq("id_reserva", datos.id_reserva).execute()
        if not reserva_req.data:
            raise HTTPException(status_code=404, detail="Reserva no encontrada.")

        info = reserva_req.data[0]
        supabase.table("reserva").update({"estado": datos.estado}).eq("id_reserva", datos.id_reserva).execute()

        if datos.estado in ["ausente", "atraso"]:
            proc = info.get("proceso_clinico") or {}
            faltas = proc.get("inasistencias_acumuladas", 0)
            supabase.table("proceso_clinico").update({"inasistencias_acumuladas": faltas + 1}).eq("id_proceso", info["id_proceso"]).execute()
            # Registrar el evento de inasistencia (justificable). Las faltas se cuentan
            # solo si se rechaza o vence el plazo.
            tipo_ina = "no_show" if datos.estado == "ausente" else "atraso"
            fh_bloque = (info.get("bloque_horario") or {}).get("fecha_hora_inicio")
            registrar_inasistencia(
                id_reserva=datos.id_reserva,
                id_proceso=info["id_proceso"],
                id_estudiante=proc.get("id_estudiante"),
                id_servicio=proc.get("id_servicio"),
                tipo=tipo_ina,
                fecha_inasistencia_iso=fh_bloque,
            )
            await notificar_inasistencia_registrada(
                proc.get("id_estudiante"), proc.get("id_servicio"), tipo_ina, fh_bloque
            )

        return {"mensaje": f"Asistencia procesada ({datos.estado})."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/mis_atenciones")
async def obtener_mis_atenciones(usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "profesional" or not usuario_actual["id_profesional"]:
        raise HTTPException(status_code=403, detail="Exclusivo para profesionales.")
    try:
        ahora_str = ahora_chile().isoformat()
        bloques_req = supabase.table("bloque_horario").select("id_bloque, fecha_hora_inicio, id_servicio, servicio(nombre, es_ciclico, tope_sesiones)").eq("id_profesional", usuario_actual["id_profesional"]).lte("fecha_hora_inicio", ahora_str).execute()
        if not bloques_req.data:
            return []

        bloques_dict = {b["id_bloque"]: b for b in bloques_req.data}
        id_bloques = list(bloques_dict.keys())
        reservas_req = supabase.table("reserva").select("id_reserva, id_bloque, id_proceso, proceso_clinico(sesiones_realizadas, estudiante(nombres, apellidos))").in_("estado", ["pendiente", "presente"]).in_("id_bloque", id_bloques).execute()

        # Excluir de forma robusta las reservas que ya tienen evolución (consulta explícita,
        # sin depender del embed anidado que puede devolver null silenciosamente).
        ids_reservas = [r["id_reserva"] for r in reservas_req.data]
        reservas_con_evolucion = set()
        if ids_reservas:
            evol_req = supabase.table("evolucion_clinica").select("id_reserva").in_("id_reserva", ids_reservas).execute()
            reservas_con_evolucion = {e["id_reserva"] for e in (evol_req.data or [])}

        # Fecha de la última sesión reservada (no cancelada) de cada proceso, para detectar cuándo
        # esta atención es la última del ciclo (y ofrecer al profesional agregar más sesiones).
        ids_procesos = list({r.get("id_proceso") for r in reservas_req.data if r.get("id_proceso")})
        max_fecha_proceso = {}
        if ids_procesos:
            todas_req = supabase.table("reserva").select("id_proceso, estado, bloque_horario(fecha_hora_inicio)").in_("id_proceso", ids_procesos).execute()
            for rr in (todas_req.data or []):
                if (rr.get("estado") or "").startswith("cancelado"):
                    continue
                fh = (rr.get("bloque_horario") or {}).get("fecha_hora_inicio")
                pid = rr.get("id_proceso")
                if not fh or not pid:
                    continue
                if pid not in max_fecha_proceso or fh > max_fecha_proceso[pid]:
                    max_fecha_proceso[pid] = fh

        atenciones = []
        for r in reservas_req.data:
            if r["id_reserva"] in reservas_con_evolucion:
                continue
            b = bloques_dict[r["id_bloque"]]
            proc = r.get("proceso_clinico") or {}
            est = proc.get("estudiante") or {}
            serv = b.get("servicio") or {}
            es_ciclico = serv.get("es_ciclico", False)
            tope = serv.get("tope_sesiones")
            sesiones_realizadas = proc.get("sesiones_realizadas") or 0
            # Es la última sesión del ciclo si este bloque es el último reservado de la serie del
            # proceso (no quedan sesiones futuras agendadas). Ahí el profesional puede extender.
            pid = r.get("id_proceso")
            max_fh = max_fecha_proceso.get(pid)
            es_ultima_sesion = bool(es_ciclico and max_fh is not None and b["fecha_hora_inicio"] >= max_fh)
            atenciones.append({
                "id_reserva": r["id_reserva"],
                "fecha": b["fecha_hora_inicio"],
                "id_servicio": b.get("id_servicio"),
                "servicio_nombre": serv.get("nombre", "Desconocido"),
                "es_ciclico": es_ciclico,
                "tope_sesiones": tope,
                "sesiones_realizadas": sesiones_realizadas,
                "es_ultima_sesion": es_ultima_sesion,
                "estudiante_nombres": est.get("nombres", "Desconocido"),
                "estudiante_apellidos": est.get("apellidos", "Desconocido")
            })
        atenciones.sort(key=lambda x: x["fecha"])
        return atenciones
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/evolucion")
async def registrar_evolucion(datos: SolicitudEvolucion, usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] != "profesional":
        raise HTTPException(status_code=403, detail="Solo profesionales pueden registrar evoluciones clínicas.")
    if datos.decision_continuidad not in ["continuar", "cerrar_proceso"]:
        raise HTTPException(status_code=400, detail="Decisión de continuidad no válida.")

    try:
        reserva_req = supabase.table("reserva").select("id_proceso, proceso_clinico(id_estudiante, id_servicio, sesiones_realizadas)").eq("id_reserva", datos.id_reserva).execute()
        if not reserva_req.data:
            raise HTTPException(status_code=404, detail="Reserva no encontrada.")

        id_proceso = reserva_req.data[0]["id_proceso"]
        id_estudiante = reserva_req.data[0]["proceso_clinico"]["id_estudiante"]
        id_servicio_actual = reserva_req.data[0]["proceso_clinico"]["id_servicio"]
        sesiones_actuales = reserva_req.data[0]["proceso_clinico"]["sesiones_realizadas"]

        # Idempotencia: si esta reserva ya tiene evolución registrada, evitar el insert duplicado
        # (la constraint UNIQUE en id_reserva lanzaría un 23505). Esto cubre reintentos tras un
        # fallo parcial previo (p. ej. una derivación que falló después de guardar la evolución).
        evol_existente = supabase.table("evolucion_clinica").select("id_evolucion").eq("id_reserva", datos.id_reserva).execute()
        if evol_existente.data:
            raise HTTPException(status_code=409, detail="Esta atención ya tiene una evolución registrada. Recarga la lista de pacientes.")

        supabase.table("reserva").update({"estado": "presente"}).eq("id_reserva", datos.id_reserva).execute()

        id_servicio_derivacion_principal = None
        if datos.derivaciones_detalles and len(datos.derivaciones_detalles) > 0:
            id_servicio_derivacion_principal = datos.derivaciones_detalles[0].get("id_servicio")
        elif datos.id_servicios_derivacion and len(datos.id_servicios_derivacion) > 0:
            id_servicio_derivacion_principal = datos.id_servicios_derivacion[0]

        evolucion_ins = supabase.table("evolucion_clinica").insert({
            "id_reserva": datos.id_reserva,
            "observaciones": datos.observaciones,
            "diagnostico": datos.diagnostico,
            "plan_tratamiento": datos.plan_tratamiento,
            "id_servicio_derivacion": id_servicio_derivacion_principal,
            "decision_continuidad": datos.decision_continuidad
        }).execute()

        servicio_req = supabase.table("servicio").select("es_ciclico, tope_sesiones").eq("id_servicio", id_servicio_actual).execute()
        es_servicio_ciclico = servicio_req.data[0]["es_ciclico"]
        tope_sesiones = servicio_req.data[0]["tope_sesiones"]
        nuevas_sesiones = sesiones_actuales + 1
        tope_alcanzado = tope_sesiones is not None and nuevas_sesiones >= tope_sesiones

        # ¿Quedan sesiones futuras ya reservadas en esta serie? (la reserva actual ya pasó a 'presente')
        ahora_iso = ahora_chile().isoformat()
        futuras_req = supabase.table("reserva").select("id_reserva, bloque_horario(fecha_hora_inicio)").eq("id_proceso", id_proceso).in_("estado", ["pendiente", "reservado", "confirmado"]).execute()
        hay_sesiones_futuras = any(
            fr["id_reserva"] != datos.id_reserva
            and (fr.get("bloque_horario") or {}).get("fecha_hora_inicio")
            and fr["bloque_horario"]["fecha_hora_inicio"] > ahora_iso
            for fr in (futuras_req.data or [])
        )

        # Fin de ciclo: servicio cíclico sin sesiones futuras reservadas. En ese punto el profesional
        # puede otorgar sesiones adicionales (1-10). Servicios no cíclicos cierran al llegar al tope.
        es_fin_ciclo = es_servicio_ciclico and not hay_sesiones_futuras
        sesiones_adicionales = max(0, min(10, datos.sesiones_adicionales or 0))
        extender_ciclo = es_fin_ciclo and not datos.es_caso_critico and sesiones_adicionales > 0

        cierre_forzado = not datos.es_caso_critico and (
            (es_fin_ciclo and not extender_ciclo)
            or ((not es_servicio_ciclico) and tope_alcanzado)
        )

        if datos.es_caso_critico or cierre_forzado:
            decision_final = "cerrar_proceso"
        elif extender_ciclo:
            decision_final = "continuar"
        else:
            decision_final = datos.decision_continuidad

        update_proceso = {
            "sesiones_realizadas": nuevas_sesiones,
            "estado": "cerrado" if decision_final == "cerrar_proceso" else "activo"
        }
        if datos.es_caso_critico:
            update_proceso["estado_critico"] = "confirmado_critico"
            update_proceso["es_caso_critico"] = True

        supabase.table("proceso_clinico").update(update_proceso).eq("id_proceso", id_proceso).execute()

        if decision_final == "continuar":
            reservas_pendientes = supabase.table("reserva").select("id_reserva, id_bloque, bloque_horario(fecha_hora_inicio, estado)").eq("id_proceso", id_proceso).eq("estado", "pendiente").execute()
            futuras = [rp for rp in (reservas_pendientes.data or []) if (rp.get("bloque_horario") or {}).get("estado") == "reservado"]
            if futuras:
                futuras.sort(key=lambda x: x["bloque_horario"]["fecha_hora_inicio"])
                supabase.table("bloque_horario").update({"estado": "confirmado"}).eq("id_bloque", futuras[0]["id_bloque"]).execute()

        # Extensión del ciclo: el profesional otorgó más sesiones en la última ficha.
        sesiones_extendidas = 0
        if extender_ciclo:
            sesiones_extendidas = await extender_serie_ciclica(id_proceso, sesiones_adicionales)
            if sesiones_extendidas == 0:
                # No había bloques disponibles para extender: cerrar el ciclo como alta normal.
                supabase.table("proceso_clinico").update({"estado": "cerrado"}).eq("id_proceso", id_proceso).execute()
                decision_final = "cerrar_proceso"
                cierre_forzado = True

        if datos.es_caso_critico:
            proceso_critico_req = supabase.table("proceso_clinico").select("motivo_consulta, servicio:id_servicio(nombre)").eq("id_proceso", id_proceso).execute()
            proceso_critico = proceso_critico_req.data[0] if proceso_critico_req.data else {}
            motivo_critico = _construir_motivo_caso_critico(
                "proceso_clinico",
                proceso_critico.get("motivo_consulta"),
                (proceso_critico.get("servicio") or {}).get("nombre")
            )

            todos_procesos_req = supabase.table("proceso_clinico").select("id_proceso").eq("id_estudiante", id_estudiante).eq("estado", "activo").execute()
            ids_otros = [p["id_proceso"] for p in (todos_procesos_req.data or []) if p["id_proceso"] != id_proceso]
            if ids_otros:
                supabase.table("proceso_clinico").update({"es_caso_critico": True, "estado": "cerrado", "estado_critico": "confirmado_critico"}).in_("id_proceso", ids_otros).execute()
                otras_reservas = supabase.table("reserva").select("id_reserva, id_bloque").in_("id_proceso", ids_otros).eq("estado", "pendiente").execute()
                if otras_reservas.data:
                    supabase.table("reserva").update({"estado": "cancelado_protocolo_critico"}).in_("id_reserva", [r["id_reserva"] for r in otras_reservas.data]).execute()
                    supabase.table("bloque_horario").update({"estado": "disponible"}).in_("id_bloque", [r["id_bloque"] for r in otras_reservas.data]).execute()

            reservas_actuales = supabase.table("reserva").select("id_reserva, id_bloque").eq("id_proceso", id_proceso).eq("estado", "pendiente").execute()
            if reservas_actuales.data:
                supabase.table("reserva").update({"estado": "cancelado_protocolo_critico"}).in_("id_reserva", [r["id_reserva"] for r in reservas_actuales.data]).execute()
                supabase.table("bloque_horario").update({"estado": "disponible"}).in_("id_bloque", [r["id_bloque"] for r in reservas_actuales.data]).execute()

            supabase.table("estudiante").update({
                "es_caso_critico_activo": True,
                "estado_critico": "confirmado_critico",
                "motivo_caso_critico": motivo_critico,
                "fecha_marcado_critico": datetime.now().isoformat()
            }).eq("id_estudiante", id_estudiante).execute()
            supabase.table("lista_espera").delete().eq("id_estudiante", id_estudiante).execute()

        # --- Procesamiento de derivaciones ---
        # La evolución y el cierre del proceso ya están persistidos. Si una derivación falla,
        # NO debemos lanzar un 500 (eso provocaría que el profesional reintente y choque con la
        # constraint UNIQUE de evolucion_clinica). En su lugar reportamos el problema en el mensaje.
        mensaje_derivacion = ""
        # IDs de lo creado por la derivación PRINCIPAL (la primera, que es la que también se
        # guarda en id_servicio_derivacion). Se persisten luego en la evolución para poder
        # rastrear "a qué reserva se derivó".
        id_reserva_deriv = None
        id_lista_deriv = None
        try:
            if datos.derivaciones_detalles and len(datos.derivaciones_detalles) > 0:
                motivo_base = f"Derivación interna. Ref. Evolución: {evolucion_ins.data[0].get('id_evolucion', 'N/A')}"
                for idx, derivacion in enumerate(datos.derivaciones_detalles):
                    servicio_id = derivacion.get("id_servicio")
                    id_bloque = derivacion.get("id_bloque")
                    disponibilidad = derivacion.get("disponibilidad")
                    motivo = derivacion.get("motivo_consulta") or motivo_base
                    if not servicio_id:
                        continue

                    proceso_existente = supabase.table("proceso_clinico").select("id_proceso").eq("id_estudiante", id_estudiante).eq("id_servicio", servicio_id).eq("estado", "activo").execute()
                    if proceso_existente.data:
                        id_proceso_nuevo = proceso_existente.data[0]["id_proceso"]
                    else:
                        proceso_ins = supabase.table("proceso_clinico").insert({"id_estudiante": id_estudiante, "id_servicio": servicio_id, "motivo_consulta": motivo}).execute()
                        id_proceso_nuevo = proceso_ins.data[0]["id_proceso"]

                    if id_bloque:
                        bloque_req = supabase.table("bloque_horario").select("fecha_hora_inicio, id_ubicacion").eq("id_bloque", id_bloque).execute()
                        if bloque_req.data:
                            candidatos_q = supabase.table("bloque_horario").select("id_bloque, id_profesional").eq("id_servicio", servicio_id).eq("fecha_hora_inicio", bloque_req.data[0]["fecha_hora_inicio"]).eq("estado", "disponible")
                            id_ubicacion_bloque = bloque_req.data[0].get("id_ubicacion")
                            candidatos_q = candidatos_q.eq("id_ubicacion", id_ubicacion_bloque) if id_ubicacion_bloque else candidatos_q.is_("id_ubicacion", "null")
                            candidatos_req = candidatos_q.execute()
                            id_bloque_final = _seleccionar_mejor_bloque(candidatos_req.data) if candidatos_req.data else id_bloque
                            nueva_reserva = await _procesar_reserva_bloques(id_proceso_nuevo, id_bloque_final)
                            if idx == 0:
                                id_reserva_deriv = (nueva_reserva or {}).get("id_reserva")
                            await notificar_reserva_directa(id_estudiante, id_bloque_final)
                            mensaje_derivacion += f" [{idx+1}] Agendada para {derivacion.get('nombre_servicio', servicio_id)}."
                    else:
                        disp = disponibilidad if disponibilidad else {}
                        campus_ind = derivacion.get("campus_indicados")
                        ins_lista = supabase.table("lista_espera").insert({
                            "id_estudiante": id_estudiante,
                            "id_servicio": servicio_id,
                            "es_prioritario": False,
                            "disponibilidad_indicada": disp,
                            "campus_indicados": campus_ind,
                            "motivo_consulta": motivo,
                            "estado_oferta": "esperando"
                        }).execute()
                        if idx == 0 and ins_lista.data:
                            id_lista_deriv = ins_lista.data[0]["id_lista"]
                        if ins_lista.data and disp:
                            await _attempt_automatic_assignment_for_student(ins_lista.data[0]["id_lista"])
                        mensaje_derivacion += f" [{idx+1}] A lista de espera para {derivacion.get('nombre_servicio', servicio_id)}."

            elif datos.id_servicios_derivacion and len(datos.id_servicios_derivacion) > 0:
                # Flujo legacy de compatibilidad
                motivo = f"Derivación interna. Ref. Evolución: {evolucion_ins.data[0].get('id_evolucion', 'N/A')}"
                primer_servicio = datos.id_servicios_derivacion[0]
                if datos.id_bloque_derivacion:
                    proceso_existente = supabase.table("proceso_clinico").select("id_proceso").eq("id_estudiante", id_estudiante).eq("id_servicio", primer_servicio).eq("estado", "activo").execute()
                    if proceso_existente.data:
                        id_proceso_nuevo = proceso_existente.data[0]["id_proceso"]
                        supabase.table("proceso_clinico").update({"motivo_consulta": motivo, "estado_revision": "pendiente"}).eq("id_proceso", id_proceso_nuevo).execute()
                    else:
                        proceso_ins = supabase.table("proceso_clinico").insert({"id_estudiante": id_estudiante, "id_servicio": primer_servicio, "motivo_consulta": motivo}).execute()
                        id_proceso_nuevo = proceso_ins.data[0]["id_proceso"]
                    bloque_req = supabase.table("bloque_horario").select("fecha_hora_inicio").eq("id_bloque", datos.id_bloque_derivacion).execute()
                    id_bloque_final_deriv = datos.id_bloque_derivacion
                    if bloque_req.data:
                        candidatos_req = supabase.table("bloque_horario").select("id_bloque, id_profesional").eq("id_servicio", primer_servicio).eq("fecha_hora_inicio", bloque_req.data[0]["fecha_hora_inicio"]).eq("estado", "disponible").execute()
                        from services.asignacion import _seleccionar_mejor_bloque
                        if candidatos_req.data and len(candidatos_req.data) > 1:
                            id_bloque_final_deriv = _seleccionar_mejor_bloque(candidatos_req.data)
                    nueva_reserva = await _procesar_reserva_bloques(id_proceso_nuevo, id_bloque_final_deriv)
                    id_reserva_deriv = (nueva_reserva or {}).get("id_reserva")
                    await notificar_reserva_directa(id_estudiante, id_bloque_final_deriv)
                    mensaje_derivacion = f" Derivación agendada para {primer_servicio}."
                else:
                    proceso_existente = supabase.table("proceso_clinico").select("id_proceso").eq("id_estudiante", id_estudiante).eq("id_servicio", primer_servicio).eq("estado", "activo").execute()
                    if not proceso_existente.data:
                        supabase.table("proceso_clinico").insert({"id_estudiante": id_estudiante, "id_servicio": primer_servicio, "motivo_consulta": motivo}).execute()
                    disp = datos.disponibilidad_derivacion if datos.disponibilidad_derivacion else {}
                    ins_lista = supabase.table("lista_espera").insert({
                        "id_estudiante": id_estudiante, "id_servicio": primer_servicio, "es_prioritario": False,
                        "disponibilidad_indicada": disp, "motivo_consulta": motivo, "estado_oferta": "esperando"
                    }).execute()
                    if ins_lista.data:
                        id_lista_deriv = ins_lista.data[0]["id_lista"]
                    if ins_lista.data and disp:
                        await _attempt_automatic_assignment_for_student(ins_lista.data[0]["id_lista"])
                    mensaje_derivacion = f" Derivación a lista de espera para {primer_servicio}."

                for servicio_id in datos.id_servicios_derivacion[1:]:
                    proceso_existente = supabase.table("proceso_clinico").select("id_proceso").eq("id_estudiante", id_estudiante).eq("id_servicio", servicio_id).eq("estado", "activo").execute()
                    if not proceso_existente.data:
                        supabase.table("proceso_clinico").insert({"id_estudiante": id_estudiante, "id_servicio": servicio_id, "motivo_consulta": motivo}).execute()
                    disp = datos.disponibilidad_derivacion if datos.disponibilidad_derivacion else {}
                    ins_lista = supabase.table("lista_espera").insert({
                        "id_estudiante": id_estudiante, "id_servicio": servicio_id, "es_prioritario": False,
                        "disponibilidad_indicada": disp, "motivo_consulta": motivo, "estado_oferta": "esperando"
                    }).execute()
                    if ins_lista.data and disp:
                        await _attempt_automatic_assignment_for_student(ins_lista.data[0]["id_lista"])
        except Exception as e_deriv:
            mensaje_derivacion += f" ⚠ La evolución se guardó correctamente, pero la derivación no pudo completarse ({e_deriv}). Realízala manualmente."

        # Persistir en la evolución el id de la reserva/lista derivada (para rastreo en reportes).
        id_evolucion = (evolucion_ins.data[0] if evolucion_ins.data else {}).get("id_evolucion")
        if id_evolucion and (id_reserva_deriv or id_lista_deriv):
            try:
                supabase.table("evolucion_clinica").update({
                    "id_reserva_derivacion": id_reserva_deriv,
                    "id_lista_derivacion": id_lista_deriv,
                }).eq("id_evolucion", id_evolucion).execute()
            except Exception:
                pass  # columnas opcionales; no romper el flujo si la migración no se aplicó aún

        mensaje_respuesta = "Registro clínico almacenado."
        if cierre_forzado:
            reservas_pendientes = supabase.table("reserva").select("id_reserva, id_bloque").eq("id_proceso", id_proceso).eq("estado", "pendiente").execute()
            if reservas_pendientes.data:
                ids_r = [r["id_reserva"] for r in reservas_pendientes.data]
                ids_b = [r["id_bloque"] for r in reservas_pendientes.data]
                supabase.table("reserva").update({"estado": "cancelado_alta_medica"}).in_("id_reserva", ids_r).execute()
                b_liberados = supabase.table("bloque_horario").update({"estado": "disponible"}).in_("id_bloque", ids_b).execute()
                for bl in b_liberados.data:
                    await _attempt_automatic_assignment(bl["id_bloque"])
            mensaje_respuesta += " NOTA: Ciclo de sesiones finalizado. Proceso cerrado."

        # Al cerrar un ciclo cíclico (alta, fin de serie o caso crítico), liberar los bloques
        # retenidos del cupo recurrente para que vuelvan a estar disponibles a otros estudiantes.
        if es_servicio_ciclico and decision_final == "cerrar_proceso":
            bloque_ref = supabase.table("reserva").select("id_bloque").eq("id_reserva", datos.id_reserva).execute()
            if bloque_ref.data and bloque_ref.data[0].get("id_bloque"):
                await liberar_retencion_slot(bloque_ref.data[0]["id_bloque"])

        if sesiones_extendidas > 0:
            mensaje_respuesta += f" Se agregaron {sesiones_extendidas} sesión(es) adicional(es) para el estudiante."
        elif extender_ciclo:
            mensaje_respuesta += " NOTA: No había bloques disponibles para agregar más sesiones; el ciclo se cerró."

        mensaje_respuesta += mensaje_derivacion
        return {"mensaje": mensaje_respuesta}

    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
