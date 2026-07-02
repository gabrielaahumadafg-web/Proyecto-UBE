from datetime import datetime, timedelta
from fastapi import APIRouter, HTTPException, Depends, Query
from database import supabase, supabase_admin, fetch_all
from dependencies import obtener_usuario_actual
from schemas import (SolicitudCrearBloque, SolicitudActualizarBloque, SolicitudCrearUsuario,
                     SolicitudCrearServicio, SolicitudActualizarServicio, SolicitudActualizarProfesional,
                     SolicitudCrearUbicacion, SolicitudActualizarUbicacion)
from services.asignacion import _attempt_automatic_assignment
from utils_tiempo import ahora_chile
from feriados_chile import es_feriado

router = APIRouter(prefix="/coordinador")
router_bloques = APIRouter()  # sin prefix, para /bloques

_rol = "coordinador"


def _check_coordinador(usuario_actual):
    if usuario_actual["rol"] != _rol:
        raise HTTPException(status_code=403, detail="Exclusivo para coordinadores.")


# ---- Bloques (gestionados por coordinador) ----

@router_bloques.post("/bloques")
async def crear_bloque(datos: SolicitudCrearBloque, usuario_actual: dict = Depends(obtener_usuario_actual)):
    _check_coordinador(usuario_actual)
    if not datos.id_ubicacion:
        raise HTTPException(status_code=400, detail="Debe seleccionar un campus/ubicación para publicar la disponibilidad.")
    try:
        servicio_req = supabase.table("servicio").select("duracion_minutos").eq("id_servicio", datos.id_servicio).execute()
        if not servicio_req.data:
            raise HTTPException(status_code=404, detail="Servicio no encontrado.")
        duracion_min = servicio_req.data[0]["duracion_minutos"]
        nuevos_bloques = []

        advertencias_feriado = []

        if not datos.es_ciclico:
            if not datos.fechas_inicio:
                raise HTTPException(status_code=400, detail="Debe seleccionar al menos un bloque.")
            for fecha_str in datos.fechas_inicio:
                inicio_base = datetime.fromisoformat(fecha_str.replace("Z", ""))
                if es_feriado(inicio_base):
                    primer_no_feriado = inicio_base + timedelta(weeks=1)
                    while es_feriado(primer_no_feriado):
                        primer_no_feriado += timedelta(weeks=1)
                    advertencias_feriado.append(
                        f"El {inicio_base.strftime('%d/%m/%Y')} es feriado nacional; los bloques empiezan el {primer_no_feriado.strftime('%d/%m/%Y')}."
                    )
                fin_anio = datetime(inicio_base.year, 12, 31, 23, 59, 59)
                inicio_bloque = inicio_base
                while inicio_bloque <= fin_anio:
                    if es_feriado(inicio_bloque):
                        inicio_bloque += timedelta(weeks=1)
                        continue
                    nuevos_bloques.append({
                        "id_profesional": datos.id_profesional,
                        "id_servicio": datos.id_servicio,
                        "fecha_hora_inicio": inicio_bloque.isoformat(),
                        "fecha_hora_fin": (inicio_bloque + timedelta(minutes=duracion_min)).isoformat(),
                        "estado": "disponible",
                        "id_ubicacion": datos.id_ubicacion
                    })
                    inicio_bloque += timedelta(weeks=1)
        else:
            if not datos.bloques_ciclicos:
                raise HTTPException(status_code=400, detail="Debe seleccionar al menos un bloque cíclico.")
            dias_map = {"lunes": 0, "martes": 1, "miercoles": 2, "miércoles": 2, "jueves": 3, "viernes": 4, "sabado": 5, "sábado": 5, "domingo": 6}
            hoy = ahora_chile()
            for b in datos.bloques_ciclicos:
                dia_objetivo = dias_map.get(b["dia_semana"].lower())
                hora, minuto = map(int, b["hora_inicio"].split(":"))
                if dia_objetivo is None:
                    raise HTTPException(status_code=400, detail=f"Día no reconocido: {b['dia_semana']}")
                dias_adelante = (dia_objetivo - hoy.weekday()) % 7
                if dias_adelante == 0 and (hoy.hour > hora or (hoy.hour == hora and hoy.minute > minuto)):
                    dias_adelante = 7
                fecha_base = (hoy + timedelta(days=dias_adelante)).replace(hour=hora, minute=minuto, second=0, microsecond=0)
                if es_feriado(fecha_base):
                    primer_no_feriado = fecha_base + timedelta(weeks=1)
                    while es_feriado(primer_no_feriado):
                        primer_no_feriado += timedelta(weeks=1)
                    advertencias_feriado.append(
                        f"El {fecha_base.strftime('%d/%m/%Y')} es feriado nacional; los bloques empiezan el {primer_no_feriado.strftime('%d/%m/%Y')}."
                    )
                fin_anio = datetime(fecha_base.year, 12, 31, 23, 59, 59)
                inicio_bloque = fecha_base
                while inicio_bloque <= fin_anio:
                    if es_feriado(inicio_bloque):
                        inicio_bloque += timedelta(weeks=1)
                        continue
                    nuevos_bloques.append({
                        "id_profesional": datos.id_profesional,
                        "id_servicio": datos.id_servicio,
                        "fecha_hora_inicio": inicio_bloque.isoformat(),
                        "fecha_hora_fin": (inicio_bloque + timedelta(minutes=duracion_min)).isoformat(),
                        "estado": "disponible",
                        "id_ubicacion": datos.id_ubicacion
                    })
                    inicio_bloque += timedelta(weeks=1)

        ahora = ahora_chile()
        nuevos_bloques = [b for b in nuevos_bloques if datetime.fromisoformat(b["fecha_hora_inicio"]) > ahora]
        if not nuevos_bloques:
            raise HTTPException(status_code=400, detail="Todos los horarios seleccionados están en el pasado.")

        min_fecha = min(datetime.fromisoformat(b["fecha_hora_inicio"]) for b in nuevos_bloques)
        # Paginado: con servicios sub-horarios un profesional supera fácil las 1000 filas
        # (tope de PostgREST); si se truncara, el chequeo de tope de horario dejaría
        # pasar bloques duplicados.
        existentes = fetch_all(lambda: supabase.table("bloque_horario").select("fecha_hora_inicio, fecha_hora_fin").eq("id_profesional", datos.id_profesional).gte("fecha_hora_fin", min_fecha.isoformat()))
        bloques_existentes = [(datetime.fromisoformat(b["fecha_hora_inicio"].replace("Z", "").replace(" ", "T")), datetime.fromisoformat(b["fecha_hora_fin"].replace("Z", "").replace(" ", "T"))) for b in existentes]

        bloques_a_insertar = []
        for nb in nuevos_bloques:
            nb_ini = datetime.fromisoformat(nb["fecha_hora_inicio"])
            nb_fin = datetime.fromisoformat(nb["fecha_hora_fin"])
            if not any(nb_ini < ex_fin and nb_fin > ex_ini for ex_ini, ex_fin in bloques_existentes):
                bloques_existentes.append((nb_ini, nb_fin))
                bloques_a_insertar.append(nb)

        if not bloques_a_insertar:
            raise HTTPException(status_code=400, detail="Todos los horarios seleccionados ya están ocupados.")

        bloques_ins = supabase.table("bloque_horario").insert(bloques_a_insertar).execute()
        for bloque_creado in bloques_ins.data:
            if bloque_creado["estado"] == "disponible":
                await _attempt_automatic_assignment(bloque_creado["id_bloque"])

        omitidos = len(nuevos_bloques) - len(bloques_a_insertar)
        mensaje = f"Se publicaron {len(bloques_ins.data)} bloques exitosamente."
        if omitidos > 0:
            mensaje += f" Se omitieron {omitidos} por tope de horario."
        for adv in advertencias_feriado:
            mensaje += f" ⚠ {adv}"
        return {"mensaje": mensaje, "bloques": bloques_ins.data}
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router_bloques.patch("/bloques/{id_bloque}")
async def actualizar_bloque(id_bloque: str, datos: SolicitudActualizarBloque, actualizar_serie: bool = Query(False), usuario_actual: dict = Depends(obtener_usuario_actual)):
    _check_coordinador(usuario_actual)
    try:
        bloque_req = supabase.table("bloque_horario").select("id_profesional, id_servicio, fecha_hora_inicio").eq("id_bloque", id_bloque).execute()
        if not bloque_req.data:
            raise HTTPException(status_code=404, detail="Bloque no encontrado.")
        bloque_db = bloque_req.data[0]
        datos_dump = datos.model_dump()
        datos_actualizar = {k: v for k, v in datos_dump.items() if v is not None}
        # Un bloque siempre debe tener campus: no se permite dejarlo sin ubicación.
        if datos_dump.get("id_ubicacion") == "":
            raise HTTPException(status_code=400, detail="Un bloque debe tener siempre un campus asignado; no se puede dejar sin ubicación.")
        if not datos_actualizar:
            return {"mensaje": "No se enviaron datos para actualizar."}

        ids_a_actualizar = [id_bloque]
        if actualizar_serie:
            # Mismo día de la semana y misma hora, de aquí en adelante (misma serie del profesional+servicio).
            fecha_inicio_base = datetime.fromisoformat(bloque_db["fecha_hora_inicio"].replace("Z", ""))
            futuros_req = supabase.table("bloque_horario").select("id_bloque, fecha_hora_inicio").eq("id_profesional", bloque_db["id_profesional"]).eq("id_servicio", bloque_db["id_servicio"]).gte("fecha_hora_inicio", bloque_db["fecha_hora_inicio"]).execute()
            for b in (futuros_req.data or []):
                b_dt = datetime.fromisoformat(b["fecha_hora_inicio"].replace("Z", ""))
                if b_dt.weekday() == fecha_inicio_base.weekday() and b_dt.time() == fecha_inicio_base.time() and b["id_bloque"] != id_bloque:
                    ids_a_actualizar.append(b["id_bloque"])

        respuesta = supabase.table("bloque_horario").update(datos_actualizar).in_("id_bloque", ids_a_actualizar).execute()
        return {"mensaje": f"{len(ids_a_actualizar)} bloque(s) actualizado(s) exitosamente.", "bloque": respuesta.data[0] if respuesta.data else None}
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router_bloques.delete("/bloques/{id_bloque}")
async def eliminar_bloque(id_bloque: str, eliminar_serie: bool = Query(False), usuario_actual: dict = Depends(obtener_usuario_actual)):
    _check_coordinador(usuario_actual)
    try:
        bloque_req = supabase.table("bloque_horario").select("id_profesional, id_servicio, estado, fecha_hora_inicio").eq("id_bloque", id_bloque).execute()
        if not bloque_req.data:
            raise HTTPException(status_code=404, detail="Bloque no encontrado.")
        bloque_db = bloque_req.data[0]
        ids_a_eliminar = [id_bloque]

        if eliminar_serie:
            fecha_inicio_base = datetime.fromisoformat(bloque_db["fecha_hora_inicio"].replace("Z", ""))
            futuros_req = supabase.table("bloque_horario").select("id_bloque, fecha_hora_inicio, estado").eq("id_profesional", bloque_db["id_profesional"]).eq("id_servicio", bloque_db["id_servicio"]).gte("fecha_hora_inicio", bloque_db["fecha_hora_inicio"]).execute()
            for b in futuros_req.data:
                b_dt = datetime.fromisoformat(b["fecha_hora_inicio"].replace("Z", ""))
                if b_dt.weekday() == fecha_inicio_base.weekday() and b_dt.time() == fecha_inicio_base.time() and b["id_bloque"] != id_bloque:
                    ids_a_eliminar.append(b["id_bloque"])

        reservas_req = supabase.table("reserva").select("id_reserva").in_("id_bloque", ids_a_eliminar).in_("estado", ["pendiente", "reservado", "confirmado"]).execute()
        if reservas_req.data:
            supabase.table("reserva").update({"estado": "cancelado_admin_suspension"}).in_("id_reserva", [r["id_reserva"] for r in reservas_req.data]).execute()

        try:
            supabase.table("bloque_horario").delete().in_("id_bloque", ids_a_eliminar).execute()
        except Exception:
            supabase.table("bloque_horario").update({"estado": "cancelado"}).in_("id_bloque", ids_a_eliminar).execute()

        return {"mensaje": "Bloque(s) eliminado(s). Reservas asociadas canceladas."}
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---- Ubicaciones (campus) ----

@router.post("/ubicaciones")
async def crear_ubicacion(datos: SolicitudCrearUbicacion, usuario_actual: dict = Depends(obtener_usuario_actual)):
    _check_coordinador(usuario_actual)
    if not datos.direccion or not datos.direccion.strip():
        raise HTTPException(status_code=400, detail="Debe indicar la dirección del campus/sede.")
    try:
        payload = {
            "nombre": datos.nombre.strip(),
            "direccion": datos.direccion.strip(),
            "abreviatura": (datos.abreviatura.strip() or None) if datos.abreviatura else None,
        }
        ins = supabase.table("ubicacion").insert(payload).execute()
        return {"mensaje": "Ubicación creada exitosamente.", "ubicacion": ins.data[0]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/ubicaciones/{id_ubicacion}")
async def actualizar_ubicacion(id_ubicacion: str, datos: SolicitudActualizarUbicacion, usuario_actual: dict = Depends(obtener_usuario_actual)):
    _check_coordinador(usuario_actual)
    try:
        datos_actualizar = {k: v for k, v in datos.model_dump().items() if v is not None}
        if not datos_actualizar:
            return {"mensaje": "Sin cambios."}
        if "nombre" in datos_actualizar:
            datos_actualizar["nombre"] = datos_actualizar["nombre"].strip()
        if "direccion" in datos_actualizar:
            datos_actualizar["direccion"] = datos_actualizar["direccion"].strip()
        if "abreviatura" in datos_actualizar:
            datos_actualizar["abreviatura"] = datos_actualizar["abreviatura"].strip() or None
        supabase.table("ubicacion").update(datos_actualizar).eq("id_ubicacion", id_ubicacion).execute()
        return {"mensaje": "Ubicación actualizada exitosamente."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/ubicaciones/{id_ubicacion}")
async def eliminar_ubicacion(id_ubicacion: str, usuario_actual: dict = Depends(obtener_usuario_actual)):
    _check_coordinador(usuario_actual)
    try:
        # Si hay bloques asociados, no se puede borrar duro (FK): se desactiva (soft-delete).
        bloques_req = supabase.table("bloque_horario").select("id_bloque").eq("id_ubicacion", id_ubicacion).limit(1).execute()
        if bloques_req.data:
            supabase.table("ubicacion").update({"activo": False}).eq("id_ubicacion", id_ubicacion).execute()
            return {"mensaje": "Ubicación desactivada (tiene bloques asociados; no se elimina para conservar el historial)."}
        supabase.table("ubicacion").delete().eq("id_ubicacion", id_ubicacion).execute()
        return {"mensaje": "Ubicación eliminada exitosamente."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---- Gestión de personal ----

@router.post("/crear_usuario")
async def crear_usuario_coordinador(datos: SolicitudCrearUsuario, usuario_actual: dict = Depends(obtener_usuario_actual)):
    _check_coordinador(usuario_actual)
    if not supabase_admin:
        raise HTTPException(status_code=500, detail="El backend no tiene configurada la clave SERVICE_ROLE de Supabase.")
    try:
        auth_res = supabase_admin.auth.admin.create_user({"email": datos.email, "password": datos.password, "email_confirm": True})
        nuevo_id_auth = auth_res.user.id
    except Exception as e:
        msg = str(e).lower()
        if "already registered" in msg or "already exists" in msg:
            raise HTTPException(status_code=400, detail="El correo ya existe en Autenticación.")
        raise HTTPException(status_code=500, detail=f"Error de Auth: {str(e)}")

    try:
        usuario_existente = supabase.table("usuario").select("id_usuario").eq("email", datos.email).execute()
        if usuario_existente.data and usuario_existente.data[0]["id_usuario"] != nuevo_id_auth:
            supabase.table("usuario").delete().eq("email", datos.email).execute()

        check_trigger = supabase.table("usuario").select("id_usuario").eq("id_usuario", nuevo_id_auth).execute()
        if check_trigger.data:
            supabase.table("usuario").update({"rol": datos.rol, "email": datos.email}).eq("id_usuario", nuevo_id_auth).execute()
        else:
            supabase.table("usuario").insert({"id_usuario": nuevo_id_auth, "email": datos.email, "rol": datos.rol}).execute()

        if datos.rol in ["profesional", "profesional_apoyo"] and datos.nombres and datos.apellidos:
            prof_ins = supabase.table("profesional").insert({"id_usuario": nuevo_id_auth, "nombres": datos.nombres, "apellidos": datos.apellidos}).execute()
            if datos.rol == "profesional" and datos.servicios and prof_ins.data:
                id_profesional = prof_ins.data[0]["id_profesional"]
                supabase.table("profesional_servicio").insert([{"id_profesional": id_profesional, "id_servicio": s} for s in datos.servicios]).execute()
        elif datos.rol == "estudiante" and datos.nombres and datos.apellidos and datos.carrera:
            if not supabase.table("estudiante").select("id_estudiante").eq("id_usuario", nuevo_id_auth).execute().data:
                rut_seguro = datos.rut if datos.rut else f"TEST-{nuevo_id_auth[:4]}"
                supabase.table("estudiante").delete().eq("rut", rut_seguro).execute()
                supabase.table("estudiante").insert({"id_usuario": nuevo_id_auth, "rut": rut_seguro, "nombres": datos.nombres, "apellidos": datos.apellidos, "carrera": datos.carrera}).execute()

        return {"mensaje": f"Usuario {datos.rol} creado exitosamente."}
    except Exception as db_error:
        try:
            supabase_admin.auth.admin.delete_user(nuevo_id_auth)
        except Exception:
            pass
        msg = str(db_error)
        if "23505" in msg:
            msg = "Error 23505: Un dato es duplicado (posiblemente RUT o email en uso)."
        raise HTTPException(status_code=400, detail=f"Creación revertida por error: {msg}")


@router.get("/profesionales")
async def obtener_profesionales_coordinador(usuario_actual: dict = Depends(obtener_usuario_actual)):
    _check_coordinador(usuario_actual)
    try:
        req = supabase.table("profesional").select("id_profesional, id_usuario, nombres, apellidos, profesional_servicio(id_servicio), usuario(rol)").execute()
        return req.data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/administrativos")
async def obtener_administrativos(usuario_actual: dict = Depends(obtener_usuario_actual)):
    _check_coordinador(usuario_actual)
    try:
        req = supabase.table("usuario").select("id_usuario, email, rol").eq("rol", "administrativo").execute()
        return req.data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/servicios")
async def crear_servicio_coordinador(datos: SolicitudCrearServicio, usuario_actual: dict = Depends(obtener_usuario_actual)):
    _check_coordinador(usuario_actual)
    try:
        ins = supabase.table("servicio").insert(datos.model_dump()).execute()
        return {"mensaje": "Servicio creado exitosamente.", "servicio": ins.data[0]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/servicios/{id_servicio}")
async def actualizar_servicio_coordinador(id_servicio: str, datos: SolicitudActualizarServicio, usuario_actual: dict = Depends(obtener_usuario_actual)):
    _check_coordinador(usuario_actual)
    try:
        datos_actualizar = {k: v for k, v in datos.model_dump().items() if v is not None}
        if not datos_actualizar:
            return {"mensaje": "Sin cambios."}
        supabase.table("servicio").update(datos_actualizar).eq("id_servicio", id_servicio).execute()
        return {"mensaje": "Servicio actualizado exitosamente."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/servicios/{id_servicio}")
async def eliminar_servicio_coordinador(id_servicio: str, usuario_actual: dict = Depends(obtener_usuario_actual)):
    _check_coordinador(usuario_actual)
    try:
        # 1. Cancelar reservas pendientes y marcar bloques como cancelado
        bloques_req = supabase.table("bloque_horario").select("id_bloque").eq("id_servicio", id_servicio).execute()
        if bloques_req.data:
            ids_bloques = [b["id_bloque"] for b in bloques_req.data]
            reservas_req = supabase.table("reserva").select("id_reserva").in_("id_bloque", ids_bloques).in_("estado", ["pendiente", "presente"]).execute()
            if reservas_req.data:
                supabase.table("reserva").update({"estado": "cancelado_admin_suspension"}).in_("id_reserva", [r["id_reserva"] for r in reservas_req.data]).execute()
            supabase.table("bloque_horario").update({"estado": "cancelado"}).in_("id_bloque", ids_bloques).execute()
        # 2. Limpiar lista de espera
        supabase.table("lista_espera").delete().eq("id_servicio", id_servicio).execute()
        # 3. Desasociar profesionales
        supabase.table("profesional_servicio").delete().eq("id_servicio", id_servicio).execute()
        # 4. Eliminar servicio (falla si hay historial clínico con FK activo)
        supabase.table("servicio").delete().eq("id_servicio", id_servicio).execute()
        return {"mensaje": "Servicio eliminado. Reservas activas canceladas."}
    except Exception as e:
        raise HTTPException(status_code=400, detail="No se pudo eliminar: el servicio tiene historial clínico registrado (proceso_clinico). Puedes desactivarlo en su lugar.")


@router.put("/profesionales/{id_profesional}/servicios")
async def actualizar_servicios_profesional(id_profesional: str, datos: SolicitudActualizarProfesional, usuario_actual: dict = Depends(obtener_usuario_actual)):
    _check_coordinador(usuario_actual)
    try:
        supabase.table("profesional_servicio").delete().eq("id_profesional", id_profesional).execute()
        if datos.servicios:
            supabase.table("profesional_servicio").insert([{"id_profesional": id_profesional, "id_servicio": s} for s in datos.servicios]).execute()
        return {"mensaje": "Especialidades actualizadas exitosamente."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/profesionales/{id_usuario}")
async def eliminar_profesional(id_usuario: str, usuario_actual: dict = Depends(obtener_usuario_actual)):
    _check_coordinador(usuario_actual)
    try:
        prof_req = supabase.table("profesional").select("id_profesional").eq("id_usuario", id_usuario).execute()
        if prof_req.data:
            id_prof = prof_req.data[0]["id_profesional"]
            # 1. Cancelar reservas pendientes de sus bloques
            bloques_req = supabase.table("bloque_horario").select("id_bloque, estado").eq("id_profesional", id_prof).execute()
            if bloques_req.data:
                ids_bloques = [b["id_bloque"] for b in bloques_req.data]
                reservas_req = supabase.table("reserva").select("id_reserva").in_("id_bloque", ids_bloques).in_("estado", ["pendiente", "presente"]).execute()
                if reservas_req.data:
                    supabase.table("reserva").update({"estado": "cancelado_admin_suspension"}).in_("id_reserva", [r["id_reserva"] for r in reservas_req.data]).execute()
                # 2. Eliminar bloques sin historial, marcar el resto como cancelado
                ids_disponibles = [b["id_bloque"] for b in bloques_req.data if b["estado"] == "disponible"]
                ids_historicos = [b["id_bloque"] for b in bloques_req.data if b["estado"] != "disponible"]
                if ids_disponibles:
                    supabase.table("bloque_horario").delete().in_("id_bloque", ids_disponibles).execute()
                if ids_historicos:
                    supabase.table("bloque_horario").update({"estado": "cancelado"}).in_("id_bloque", ids_historicos).execute()
            supabase.table("profesional_servicio").delete().eq("id_profesional", id_prof).execute()
            supabase.table("profesional").delete().eq("id_profesional", id_prof).execute()
        supabase.table("usuario").delete().eq("id_usuario", id_usuario).execute()
        if supabase_admin:
            supabase_admin.auth.admin.delete_user(id_usuario)
        return {"mensaje": "Profesional eliminado. Reservas activas canceladas."}
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/profesionales/{id_profesional}/bloques")
async def obtener_bloques_profesional(id_profesional: str, usuario_actual: dict = Depends(obtener_usuario_actual)):
    _check_coordinador(usuario_actual)
    try:
        return fetch_all(lambda: supabase.table("bloque_horario").select(
            "id_bloque, fecha_hora_inicio, fecha_hora_fin, estado, id_servicio, servicio(nombre), ubicacion(id_ubicacion, nombre, abreviatura), "
            "reserva(estado, evolucion_clinica(id_evolucion), proceso_clinico(estudiante(nombres, apellidos, rut)))"
        ).eq("id_profesional", id_profesional).order("fecha_hora_inicio", desc=True))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---- Casos críticos ----

@router.get("/casos_criticos_pendientes")
async def obtener_casos_pendientes(usuario_actual: dict = Depends(obtener_usuario_actual)):
    _check_coordinador(usuario_actual)
    from services.triage import _motivo_caso_critico_desde_origen
    try:
        req = supabase.table("estudiante").select("id_estudiante, rut, nombres, apellidos, carrera, motivo_caso_critico, fecha_marcado_critico").eq("estado_critico", "pendiente_coordinador").execute()
        casos = req.data if req.data else []
        prefijo = "Marcado por administrativo desde "
        for caso in casos:
            motivo_actual = caso.get("motivo_caso_critico") or ""
            if motivo_actual.startswith(prefijo):
                origen = motivo_actual.replace(prefijo, "", 1).strip()
                motivo_enriquecido = _motivo_caso_critico_desde_origen(caso["id_estudiante"], origen)
                if motivo_enriquecido:
                    caso["motivo_caso_critico"] = motivo_enriquecido
        return casos
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/aprobar_critico/{id_estudiante}")
async def aprobar_caso_critico(id_estudiante: str, usuario_actual: dict = Depends(obtener_usuario_actual)):
    _check_coordinador(usuario_actual)
    try:
        est_req = supabase.table("estudiante").select("estado_critico").eq("id_estudiante", id_estudiante).execute()
        if not est_req.data or est_req.data[0].get("estado_critico") != "pendiente_coordinador":
            raise HTTPException(status_code=400, detail="Estudiante no está pendiente de revisión.")

        procesos_req = supabase.table("proceso_clinico").select("id_proceso").eq("id_estudiante", id_estudiante).eq("estado", "activo").execute()
        ids_procesos = [p["id_proceso"] for p in procesos_req.data] if procesos_req.data else []

        supabase.table("estudiante").update({"es_caso_critico_activo": True, "estado_critico": "confirmado_critico"}).eq("id_estudiante", id_estudiante).execute()

        if ids_procesos:
            supabase.table("proceso_clinico").update({"es_caso_critico": True, "estado": "cerrado", "estado_revision": "revisado"}).in_("id_proceso", ids_procesos).execute()
            reservas_req = supabase.table("reserva").select("id_reserva, id_bloque").in_("id_proceso", ids_procesos).eq("estado", "pendiente").execute()
            if reservas_req.data:
                supabase.table("reserva").update({"estado": "cancelado_protocolo_critico"}).in_("id_reserva", [r["id_reserva"] for r in reservas_req.data]).execute()
                supabase.table("bloque_horario").update({"estado": "disponible"}).in_("id_bloque", [r["id_bloque"] for r in reservas_req.data]).execute()

        supabase.table("lista_espera").delete().eq("id_estudiante", id_estudiante).execute()
        return {"mensaje": "✓ Estudiante confirmado como caso crítico. Sale del sistema."}
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/rechazar_critico/{id_estudiante}")
async def rechazar_caso_critico(id_estudiante: str, usuario_actual: dict = Depends(obtener_usuario_actual)):
    _check_coordinador(usuario_actual)
    try:
        est_req = supabase.table("estudiante").select("estado_critico").eq("id_estudiante", id_estudiante).execute()
        if not est_req.data or est_req.data[0].get("estado_critico") != "pendiente_coordinador":
            raise HTTPException(status_code=400, detail="Estudiante no está pendiente de revisión.")
        supabase.table("estudiante").update({"estado_critico": None, "motivo_caso_critico": None}).eq("id_estudiante", id_estudiante).execute()
        return {"mensaje": "✓ Marca rechazada. Estudiante continúa activo."}
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
