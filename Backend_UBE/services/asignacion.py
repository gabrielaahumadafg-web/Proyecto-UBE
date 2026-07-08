from datetime import datetime, timedelta
from database import supabase, fetch_all
from services.notificaciones import notificar_asignacion_automatica, notificar_reserva_directa
from utils_tiempo import ahora_chile


def _seleccionar_mejor_bloque(candidatos: list) -> str:
    """Balanceo de carga: elige el bloque del profesional con menor porcentaje de ocupación."""
    if len(candidatos) == 1:
        return candidatos[0]["id_bloque"]
    ids_profesionales = list(set(c["id_profesional"] for c in candidatos))
    # Sólo bloques futuros: el balanceo reparte carga próxima, no historial pasado.
    ahora_iso = ahora_chile().isoformat()
    stats = fetch_all(lambda: supabase.table("bloque_horario").select("id_profesional, estado").in_("id_profesional", ids_profesionales).gte("fecha_hora_inicio", ahora_iso))
    ocupacion = {}
    for stat in stats:
        prof = stat["id_profesional"]
        if prof not in ocupacion:
            ocupacion[prof] = {"total": 0, "ocupados": 0}
        ocupacion[prof]["total"] += 1
        # Misma definición de "ocupado" que /reportes/ocupacion: cancelado no cuenta.
        if stat["estado"] not in ["disponible", "huerfano", "cancelado"]:
            ocupacion[prof]["ocupados"] += 1

    def ratio(c):
        s = ocupacion.get(c["id_profesional"], {"total": 1, "ocupados": 0})
        return s["ocupados"] / s["total"] if s["total"] > 0 else 0

    return sorted(candidatos, key=ratio)[0]["id_bloque"]


def _tiene_conflicto_horario(id_estudiante: str, fecha_hora_inicio_iso: str, id_reserva_excluir: str = None) -> bool:
    """True si el estudiante ya tiene una reserva activa (no cancelada) a esa fecha/hora
    exacta, en cualquier servicio. `id_reserva_excluir` permite ignorar una reserva
    concreta (p. ej. la que se está reagendando)."""
    target = fecha_hora_inicio_iso.replace("Z", "").replace(" ", "T")[:19]
    # Todos los procesos del estudiante (no solo activos): una reserva pendiente de un
    # proceso cerrado igualmente ocupa al estudiante a esa hora.
    procesos = supabase.table("proceso_clinico").select("id_proceso").eq("id_estudiante", id_estudiante).execute()
    if not procesos.data:
        return False
    id_procesos = [p["id_proceso"] for p in procesos.data]
    reservas = fetch_all(lambda: supabase.table("reserva").select(
        "id_reserva, estado, bloque_horario(fecha_hora_inicio)"
    ).in_("id_proceso", id_procesos))
    for res in reservas:
        if id_reserva_excluir and res.get("id_reserva") == id_reserva_excluir:
            continue
        if res["estado"].startswith("cancelado"):
            continue
        bh = res.get("bloque_horario") or {}
        fh = bh.get("fecha_hora_inicio")
        if fh and fh.replace("Z", "").replace(" ", "T")[:19] == target:
            return True
    return False


def _guardar_fecha_ingreso_lista(reserva_rows, fecha_ingreso_lista):
    """Mejor esfuerzo: guarda en la(s) reserva(s) recién creada(s) la fecha en que el
    estudiante entró a la lista de espera (`fecha_ingreso_lista`), para poder medir después
    el tramo de espera 'por lista de espera' (click en lista → asignación del cupo).
    Solo aplica a asignaciones que vienen de la lista de espera; en reservas directas es None
    (la espera total es solo el tramo reserva). Va en try/except porque la columna puede no
    existir todavía si aún no se corrió la migración — un fallo aquí no debe romper la reserva."""
    if not fecha_ingreso_lista or not reserva_rows:
        return
    try:
        ids = [r["id_reserva"] for r in reserva_rows if r.get("id_reserva")]
        if ids:
            supabase.table("reserva").update(
                {"fecha_ingreso_lista": fecha_ingreso_lista}
            ).in_("id_reserva", ids).execute()
    except Exception as e:
        print(f"[espera] no se pudo guardar fecha_ingreso_lista (¿falta migración?): {e}")


async def _procesar_reserva_bloques(id_proceso: str, id_bloque_final: str, fecha_ingreso_lista: str | None = None):
    """
    Procesa la reserva de un bloque. Para servicios cíclicos, reserva toda la serie futura
    hasta el tope de sesiones. Marca el primero como 'confirmado' y el resto como 'reservado'.

    `fecha_ingreso_lista` (opcional): fecha de ingreso a la lista de espera, que se preserva en
    la reserva para medir después el tramo de espera por lista de espera. None en reservas directas.
    """
    bloque_req = supabase.table("bloque_horario").select("id_profesional, id_servicio, fecha_hora_inicio").eq("id_bloque", id_bloque_final).execute()
    if not bloque_req.data:
        return {}

    b_data = bloque_req.data[0]
    id_profesional = b_data["id_profesional"]
    id_servicio = b_data["id_servicio"]
    fecha_bloque_dt = datetime.fromisoformat(b_data["fecha_hora_inicio"].replace("Z", "").replace(" ", "T"))

    servicio_req = supabase.table("servicio").select("es_ciclico, tope_sesiones").eq("id_servicio", id_servicio).execute()
    if not servicio_req.data:
        return {}

    es_ciclico = servicio_req.data[0]["es_ciclico"]
    tope_sesiones = servicio_req.data[0]["tope_sesiones"] or 8

    if es_ciclico:
        hora = fecha_bloque_dt.time()
        dow = fecha_bloque_dt.weekday()

        # La serie cíclica no debe cruzar el fin del año del bloque inicial (las
        # disponibilidades se publican hasta el 31-dic). Coincide con el tope que ya
        # aplica la creación de bloques en coordinador.py.
        fin_anio = datetime(fecha_bloque_dt.year, 12, 31, 23, 59, 59)

        futuros = fetch_all(lambda: supabase.table("bloque_horario").select("id_bloque, fecha_hora_inicio").eq("id_profesional", id_profesional).eq("id_servicio", id_servicio).eq("estado", "disponible").gte("fecha_hora_inicio", fecha_bloque_dt.isoformat()).lte("fecha_hora_inicio", fin_anio.isoformat()))

        bloques_slot = [
            b for b in futuros
            if datetime.fromisoformat(b["fecha_hora_inicio"].replace("Z", "").replace(" ", "T")).time() == hora
            and datetime.fromisoformat(b["fecha_hora_inicio"].replace("Z", "").replace(" ", "T")).weekday() == dow
        ]
        bloques_slot.sort(key=lambda x: x["fecha_hora_inicio"])
        bloques_serie = bloques_slot[:tope_sesiones]
        id_bloques_serie = [b["id_bloque"] for b in bloques_serie]

        if not id_bloques_serie:
            supabase.table("bloque_horario").update({"estado": "confirmado"}).eq("id_bloque", id_bloque_final).execute()
            reserva_ins = supabase.table("reserva").insert({"id_proceso": id_proceso, "id_bloque": id_bloque_final, "estado": "pendiente"}).execute()
            _guardar_fecha_ingreso_lista(reserva_ins.data, fecha_ingreso_lista)
            return reserva_ins.data[0] if reserva_ins.data else {}

        supabase.table("bloque_horario").update({"estado": "confirmado"}).eq("id_bloque", id_bloques_serie[0]).execute()
        if len(id_bloques_serie) > 1:
            supabase.table("bloque_horario").update({"estado": "reservado"}).in_("id_bloque", id_bloques_serie[1:]).execute()

        # Retención del cupo recurrente: los bloques futuros del mismo slot semanal que sobran
        # tras la serie quedan "huerfano" (retenidos), para que NO aparezcan disponibles a otros
        # estudiantes mientras el ciclo siga activo. Esto reserva el espacio para una posible
        # extensión de sesiones que el profesional decida al subir la última ficha. "huerfano" no
        # cuenta como ocupado en los reportes ni se ofrece en la asignación automática.
        ids_retener = [b["id_bloque"] for b in bloques_slot[len(id_bloques_serie):]]
        if ids_retener:
            supabase.table("bloque_horario").update({"estado": "huerfano"}).in_("id_bloque", ids_retener).execute()

        reservas_ins = [{"id_proceso": id_proceso, "id_bloque": b_id, "estado": "pendiente"} for b_id in id_bloques_serie]
        reserva_ins = supabase.table("reserva").insert(reservas_ins).execute()
        _guardar_fecha_ingreso_lista(reserva_ins.data, fecha_ingreso_lista)
        return reserva_ins.data[0] if reserva_ins.data else {}
    else:
        supabase.table("bloque_horario").update({"estado": "confirmado"}).eq("id_bloque", id_bloque_final).execute()
        reserva_ins = supabase.table("reserva").insert({
            "id_proceso": id_proceso,
            "id_bloque": id_bloque_final,
            "estado": "pendiente"
        }).execute()
        _guardar_fecha_ingreso_lista(reserva_ins.data, fecha_ingreso_lista)
        return reserva_ins.data[0] if reserva_ins.data else {}


async def _agendar_reposicion_ciclica(id_proceso: str, id_reserva_origen: str):
    """
    Agenda una sesión de reposición para un servicio cíclico cuando se justifica una
    inasistencia: busca el siguiente bloque disponible con el mismo día-semana + hora +
    profesional, después de la última sesión de la serie del proceso, y lo reserva
    (extiende la serie 1 sesión). Devuelve info del bloque agendado o None si no aplica
    (servicio no cíclico) o no hay bloque disponible.
    """
    reserva_req = supabase.table("reserva").select("id_bloque").eq("id_reserva", id_reserva_origen).execute()
    if not reserva_req.data or not reserva_req.data[0].get("id_bloque"):
        return None
    id_bloque_origen = reserva_req.data[0]["id_bloque"]

    bloque_req = supabase.table("bloque_horario").select("id_profesional, id_servicio, fecha_hora_inicio").eq("id_bloque", id_bloque_origen).execute()
    if not bloque_req.data:
        return None
    b = bloque_req.data[0]
    id_profesional = b["id_profesional"]
    id_servicio = b["id_servicio"]
    fecha_origen_dt = datetime.fromisoformat(b["fecha_hora_inicio"].replace("Z", "").replace(" ", "T"))

    servicio_req = supabase.table("servicio").select("es_ciclico").eq("id_servicio", id_servicio).execute()
    if not servicio_req.data or not servicio_req.data[0]["es_ciclico"]:
        return None  # solo servicios cíclicos tienen reposición

    hora = fecha_origen_dt.time()
    dow = fecha_origen_dt.weekday()

    # Última sesión activa ya reservada en la serie del proceso (para agendar después de ella)
    reservas_serie = supabase.table("reserva").select(
        "estado, bloque_horario(fecha_hora_inicio)"
    ).eq("id_proceso", id_proceso).execute()
    ultima_fecha = fecha_origen_dt
    for r in (reservas_serie.data or []):
        if (r.get("estado") or "").startswith("cancelado"):
            continue
        fh = (r.get("bloque_horario") or {}).get("fecha_hora_inicio")
        if not fh:
            continue
        fh_dt = datetime.fromisoformat(fh.replace("Z", "").replace(" ", "T"))
        if fh_dt > ultima_fecha:
            ultima_fecha = fh_dt

    # La reposición se mantiene dentro del mismo año del bloque original (hasta el 31-dic).
    fin_anio = datetime(fecha_origen_dt.year, 12, 31, 23, 59, 59)

    # Incluye los bloques retenidos ('huerfano') del propio slot del estudiante: la reposición
    # extiende su serie usando el cupo recurrente que se le reservó.
    candidatos_rows = fetch_all(lambda: supabase.table("bloque_horario").select("id_bloque, fecha_hora_inicio").eq(
        "id_profesional", id_profesional
    ).eq("id_servicio", id_servicio).in_("estado", ["disponible", "huerfano"]).gt(
        "fecha_hora_inicio", ultima_fecha.isoformat()
    ).lte("fecha_hora_inicio", fin_anio.isoformat()))

    candidatos = [
        c for c in candidatos_rows
        if datetime.fromisoformat(c["fecha_hora_inicio"].replace("Z", "").replace(" ", "T")).time() == hora
        and datetime.fromisoformat(c["fecha_hora_inicio"].replace("Z", "").replace(" ", "T")).weekday() == dow
    ]
    if not candidatos:
        return None
    candidatos.sort(key=lambda x: x["fecha_hora_inicio"])
    id_bloque_repo = candidatos[0]["id_bloque"]

    supabase.table("bloque_horario").update({"estado": "reservado"}).eq("id_bloque", id_bloque_repo).execute()
    supabase.table("reserva").insert({"id_proceso": id_proceso, "id_bloque": id_bloque_repo, "estado": "pendiente"}).execute()

    proc = supabase.table("proceso_clinico").select("id_estudiante").eq("id_proceso", id_proceso).execute()
    if proc.data:
        try:
            await notificar_reserva_directa(proc.data[0]["id_estudiante"], id_bloque_repo)
        except Exception as e:
            print(f"[reposicion] No se pudo notificar: {e}")

    return {"id_bloque": id_bloque_repo, "fecha_hora_inicio": candidatos[0]["fecha_hora_inicio"]}


async def extender_serie_ciclica(id_proceso: str, n_sesiones: int):
    """Extiende la serie de un proceso cíclico con hasta `n_sesiones` sesiones adicionales (1-10),
    tomando los siguientes bloques del mismo slot semanal (profesional + día-semana + hora)
    posteriores a la última sesión ya reservada. Usa los bloques retenidos ('huerfano') y, si
    faltan, cualquier bloque 'disponible' del slot. Devuelve el número de sesiones agregadas.

    Se invoca cuando el profesional, al subir la última ficha de un ciclo, decide otorgar más
    sesiones al estudiante."""
    n_sesiones = max(0, min(10, int(n_sesiones or 0)))
    if n_sesiones <= 0:
        return 0

    proceso_req = supabase.table("proceso_clinico").select("id_servicio").eq("id_proceso", id_proceso).execute()
    if not proceso_req.data:
        return 0
    id_servicio = proceso_req.data[0]["id_servicio"]

    servicio_req = supabase.table("servicio").select("es_ciclico").eq("id_servicio", id_servicio).execute()
    if not servicio_req.data or not servicio_req.data[0]["es_ciclico"]:
        return 0

    # Última sesión (cualquier estado no cancelado) de la serie del proceso → define el slot
    # semanal y desde cuándo buscar nuevos bloques.
    reservas_serie = supabase.table("reserva").select(
        "estado, bloque_horario(id_profesional, fecha_hora_inicio)"
    ).eq("id_proceso", id_proceso).execute()
    id_profesional = None
    ultima_fecha = None
    for r in (reservas_serie.data or []):
        if (r.get("estado") or "").startswith("cancelado"):
            continue
        bh = r.get("bloque_horario") or {}
        fh = bh.get("fecha_hora_inicio")
        if not fh:
            continue
        fh_dt = datetime.fromisoformat(fh.replace("Z", "").replace(" ", "T"))
        if ultima_fecha is None or fh_dt > ultima_fecha:
            ultima_fecha = fh_dt
            id_profesional = bh.get("id_profesional")
    if ultima_fecha is None or not id_profesional:
        return 0

    hora = ultima_fecha.time()
    dow = ultima_fecha.weekday()
    fin_anio = datetime(ultima_fecha.year, 12, 31, 23, 59, 59)

    candidatos_rows = fetch_all(lambda: supabase.table("bloque_horario").select("id_bloque, fecha_hora_inicio").eq(
        "id_profesional", id_profesional
    ).eq("id_servicio", id_servicio).in_("estado", ["huerfano", "disponible"]).gt(
        "fecha_hora_inicio", ultima_fecha.isoformat()
    ).lte("fecha_hora_inicio", fin_anio.isoformat()))

    candidatos = [
        c for c in candidatos_rows
        if datetime.fromisoformat(c["fecha_hora_inicio"].replace("Z", "").replace(" ", "T")).time() == hora
        and datetime.fromisoformat(c["fecha_hora_inicio"].replace("Z", "").replace(" ", "T")).weekday() == dow
    ]
    candidatos.sort(key=lambda x: x["fecha_hora_inicio"])
    candidatos = candidatos[:n_sesiones]
    if not candidatos:
        return 0

    ids_nuevos = [c["id_bloque"] for c in candidatos]
    # La sesión más próxima se confirma; el resto quedan reservadas.
    supabase.table("bloque_horario").update({"estado": "confirmado"}).eq("id_bloque", ids_nuevos[0]).execute()
    if len(ids_nuevos) > 1:
        supabase.table("bloque_horario").update({"estado": "reservado"}).in_("id_bloque", ids_nuevos[1:]).execute()

    nuevas_reservas = [{"id_proceso": id_proceso, "id_bloque": bid, "estado": "pendiente"} for bid in ids_nuevos]
    supabase.table("reserva").insert(nuevas_reservas).execute()

    proc = supabase.table("proceso_clinico").select("id_estudiante").eq("id_proceso", id_proceso).execute()
    if proc.data:
        try:
            await notificar_reserva_directa(proc.data[0]["id_estudiante"], ids_nuevos[0])
        except Exception as e:
            print(f"[extension] No se pudo notificar: {e}")

    return len(ids_nuevos)


async def liberar_retencion_slot(id_bloque_referencia: str):
    """Al cerrar un ciclo, libera los bloques retenidos ('huerfano') del mismo slot semanal del
    bloque de referencia, dejándolos 'disponible' y ofreciéndolos a la lista de espera. Es la
    contraparte de la retención que hace `_procesar_reserva_bloques`: el cupo recurrente solo se
    libera a otros estudiantes cuando el profesional cierra el ciclo (sube la última ficha)."""
    try:
        bloque_req = supabase.table("bloque_horario").select("id_profesional, id_servicio, fecha_hora_inicio").eq("id_bloque", id_bloque_referencia).execute()
        if not bloque_req.data:
            return
        b = bloque_req.data[0]
        id_profesional = b["id_profesional"]
        id_servicio = b["id_servicio"]
        fecha_ref = datetime.fromisoformat(b["fecha_hora_inicio"].replace("Z", "").replace(" ", "T"))
        hora = fecha_ref.time()
        dow = fecha_ref.weekday()
        fin_anio = datetime(fecha_ref.year, 12, 31, 23, 59, 59)
        ahora_iso = ahora_chile().isoformat()

        retenidos = fetch_all(lambda: supabase.table("bloque_horario").select("id_bloque, fecha_hora_inicio").eq(
            "id_profesional", id_profesional
        ).eq("id_servicio", id_servicio).eq("estado", "huerfano").gt(
            "fecha_hora_inicio", ahora_iso
        ).lte("fecha_hora_inicio", fin_anio.isoformat()))

        liberar = [
            r for r in retenidos
            if datetime.fromisoformat(r["fecha_hora_inicio"].replace("Z", "").replace(" ", "T")).time() == hora
            and datetime.fromisoformat(r["fecha_hora_inicio"].replace("Z", "").replace(" ", "T")).weekday() == dow
        ]
        if not liberar:
            return
        liberar.sort(key=lambda x: x["fecha_hora_inicio"])
        ids_liberar = [r["id_bloque"] for r in liberar]
        supabase.table("bloque_horario").update({"estado": "disponible"}).in_("id_bloque", ids_liberar).execute()
        # En orden cronológico: el primero captura la serie completa (si hay alguien en espera);
        # los siguientes quedan como no-op al estar ya reservados.
        for bid in ids_liberar:
            await _attempt_automatic_assignment(bid)
    except Exception as e:
        print(f"[liberar_retencion] {e}")


def _campus_aceptado(id_ubicacion_bloque, campus_indicados) -> bool:
    """True si el bloque cae en un campus aceptado por el estudiante.
    campus_indicados None/vacío = acepta cualquier campus. Si el estudiante indicó
    campus específicos, un bloque sin ubicación (None) no califica."""
    if not campus_indicados:
        return True
    return str(id_ubicacion_bloque) in [str(c) for c in campus_indicados]


def _campus_aceptado_slot(id_ubicacion_bloque, dia_str: str, hora_str: str,
                           campus_por_slot: dict | None, campus_indicados) -> bool:
    """Campus check con granularidad por slot. Primero busca en campus_por_slot
    (clave "dia|HH:MM"); si no hay entrada para ese slot usa campus_indicados global."""
    if campus_por_slot:
        clave = f"{dia_str}|{hora_str}"
        if clave in campus_por_slot:
            campus_slot = campus_por_slot[clave]
            if not campus_slot:
                return True  # lista vacía = cualquier campus para este slot
            return str(id_ubicacion_bloque) in [str(c) for c in campus_slot]
    return _campus_aceptado(id_ubicacion_bloque, campus_indicados)


async def _attempt_automatic_assignment(id_bloque_disponible: str):
    """
    Intenta asignar un bloque recién liberado al estudiante más prioritario de la lista de espera
    que cumpla con la disponibilidad. Verifica suspensiones y casos críticos activos.
    """
    try:
        bloque_req = supabase.table("bloque_horario").select("id_bloque, id_servicio, fecha_hora_inicio, estado, id_ubicacion").eq("id_bloque", id_bloque_disponible).execute()
        if not bloque_req.data or bloque_req.data[0]["estado"] != "disponible":
            return False

        bloque_data = bloque_req.data[0]
        id_servicio = bloque_data["id_servicio"]
        id_ubicacion_bloque = bloque_data.get("id_ubicacion")
        fecha_hora_inicio = datetime.fromisoformat(bloque_data["fecha_hora_inicio"].replace("Z", "").replace(" ", "T"))

        if fecha_hora_inicio - ahora_chile() < timedelta(hours=12):
            return False

        dias_semana_map = {0: "lunes", 1: "martes", 2: "miercoles", 3: "jueves", 4: "viernes", 5: "sabado", 6: "domingo"}
        dia_str = dias_semana_map[fecha_hora_inicio.weekday()]
        hora_str = fecha_hora_inicio.strftime("%H:%M")

        lista_espera_req = supabase.table("lista_espera").select(
            "id_lista, id_estudiante, disponibilidad_indicada, campus_indicados, campus_por_slot, motivo_consulta, puntaje_triage, fecha_ingreso"
        ).eq("id_servicio", id_servicio).eq("estado_oferta", "esperando").order("es_prioritario", desc=True).order("fecha_ingreso", desc=False).execute()

        estudiante_asignado = None
        id_lista_asignada = None

        for estudiante in lista_espera_req.data:
            disponibilidad = estudiante["disponibilidad_indicada"]
            if not _campus_aceptado_slot(id_ubicacion_bloque, dia_str, hora_str,
                                          estudiante.get("campus_por_slot"), estudiante.get("campus_indicados")):
                continue
            if "sistema" not in disponibilidad and dia_str in disponibilidad and hora_str in disponibilidad[dia_str]:
                susp_req = supabase.table("suspension_servicio").select("id_suspension").eq("id_estudiante", estudiante["id_estudiante"]).eq("id_servicio", id_servicio).gte("fecha_fin", datetime.utcnow().isoformat()).execute()
                if susp_req.data:
                    continue
                est_req = supabase.table("estudiante").select("es_caso_critico_activo").eq("id_estudiante", estudiante["id_estudiante"]).execute()
                if est_req.data and est_req.data[0].get("es_caso_critico_activo"):
                    supabase.table("lista_espera").delete().eq("id_lista", estudiante["id_lista"]).execute()
                    continue
                # No doble-citar: si ya tiene otra hora (cualquier servicio) a esa misma
                # fecha/hora, se salta a este estudiante y se prueba con el siguiente.
                if _tiene_conflicto_horario(estudiante["id_estudiante"], bloque_data["fecha_hora_inicio"]):
                    continue
                estudiante_asignado = estudiante
                id_lista_asignada = estudiante["id_lista"]
                break

        if not estudiante_asignado:
            return False

        proceso_existente = supabase.table("proceso_clinico").select("id_proceso").eq("id_estudiante", estudiante_asignado["id_estudiante"]).eq("id_servicio", id_servicio).eq("estado", "activo").execute()

        id_bloques_liberados = []
        if proceso_existente.data:
            id_proceso = proceso_existente.data[0]["id_proceso"]
            reserva_pend = supabase.table("reserva").select("id_reserva, id_bloque").eq("id_proceso", id_proceso).eq("estado", "pendiente").execute()
            if reserva_pend.data:
                for old_res in reserva_pend.data:
                    id_bloques_liberados.append(old_res["id_bloque"])
                    supabase.table("reserva").update({"estado": "cancelado_sistema_mejora"}).eq("id_reserva", old_res["id_reserva"]).execute()
                supabase.table("bloque_horario").update({"estado": "disponible"}).in_("id_bloque", id_bloques_liberados).execute()
            supabase.table("proceso_clinico").update({
                "motivo_consulta": estudiante_asignado["motivo_consulta"],
                "puntaje_triage": estudiante_asignado.get("puntaje_triage"),
                "estado_revision": "pendiente"
            }).eq("id_proceso", id_proceso).execute()
        else:
            proceso_ins = supabase.table("proceso_clinico").insert({
                "id_estudiante": estudiante_asignado["id_estudiante"],
                "id_servicio": id_servicio,
                "motivo_consulta": estudiante_asignado["motivo_consulta"],
                "puntaje_triage": estudiante_asignado.get("puntaje_triage")
            }).execute()
            id_proceso = proceso_ins.data[0]["id_proceso"]

        await _procesar_reserva_bloques(id_proceso, id_bloque_disponible, estudiante_asignado.get("fecha_ingreso"))
        supabase.table("lista_espera").delete().eq("id_lista", id_lista_asignada).execute()

        await notificar_asignacion_automatica(
            estudiante_asignado["id_estudiante"], id_bloque_disponible,
            es_reasignacion=bool(id_bloques_liberados)
        )

        if id_bloques_liberados:
            for bl_id in id_bloques_liberados:
                await _attempt_automatic_assignment(bl_id)

        return True

    except Exception as e:
        print(f"Error en asignación automática para bloque {id_bloque_disponible}: {e}")
        return False


async def _attempt_automatic_assignment_for_student(id_lista: str):
    """
    Intenta asignar un bloque disponible al estudiante recién ingresado a la lista de espera,
    cruzando su disponibilidad con los bloques libres.
    """
    try:
        lista_req = supabase.table("lista_espera").select("*").eq("id_lista", id_lista).execute()
        if not lista_req.data or lista_req.data[0]["estado_oferta"] != "esperando":
            return False

        estudiante = lista_req.data[0]
        id_servicio = estudiante["id_servicio"]
        disponibilidad = estudiante["disponibilidad_indicada"]
        campus_indicados = estudiante.get("campus_indicados")
        campus_por_slot = estudiante.get("campus_por_slot")

        if "sistema" in disponibilidad:
            return False

        doce_horas_mas = (ahora_chile() + timedelta(hours=12)).isoformat()
        bloques_disp = fetch_all(lambda: supabase.table("bloque_horario").select("id_bloque, id_profesional, fecha_hora_inicio, id_ubicacion").eq("id_servicio", id_servicio).eq("estado", "disponible").gt("fecha_hora_inicio", doce_horas_mas).order("fecha_hora_inicio", desc=False))
        if not bloques_disp:
            return False

        dias_semana_map = {0: "lunes", 1: "martes", 2: "miercoles", 3: "jueves", 4: "viernes", 5: "sabado", 6: "domingo"}

        bloques_agrupados = {}
        for b in bloques_disp:
            fh = b["fecha_hora_inicio"]
            if fh not in bloques_agrupados:
                bloques_agrupados[fh] = []
            bloques_agrupados[fh].append(b)

        for fh in sorted(bloques_agrupados.keys()):
            fecha_obj = datetime.fromisoformat(fh.replace("Z", "").replace(" ", "T"))
            dia_str = dias_semana_map[fecha_obj.weekday()]
            hora_str = fecha_obj.strftime("%H:%M")

            if dia_str in disponibilidad and hora_str in disponibilidad[dia_str]:
                candidatos = [c for c in bloques_agrupados[fh] if _campus_aceptado_slot(
                    c.get("id_ubicacion"), dia_str, hora_str, campus_por_slot, campus_indicados)]
                if not candidatos:
                    continue
                # No doble-citar: si ya tiene otra hora a esa misma fecha/hora
                # (cualquier servicio), se prueba con el siguiente horario disponible.
                if _tiene_conflicto_horario(estudiante["id_estudiante"], fh):
                    continue
                id_bloque_final = _seleccionar_mejor_bloque(candidatos)

                proceso_existente = supabase.table("proceso_clinico").select("id_proceso").eq("id_estudiante", estudiante["id_estudiante"]).eq("id_servicio", id_servicio).eq("estado", "activo").execute()

                id_bloques_liberados = []
                if proceso_existente.data:
                    id_proceso = proceso_existente.data[0]["id_proceso"]
                    reserva_pend = supabase.table("reserva").select("id_reserva, id_bloque").eq("id_proceso", id_proceso).eq("estado", "pendiente").execute()
                    if reserva_pend.data:
                        for old_res in reserva_pend.data:
                            id_bloques_liberados.append(old_res["id_bloque"])
                            supabase.table("reserva").update({"estado": "cancelado_sistema_mejora"}).eq("id_reserva", old_res["id_reserva"]).execute()
                        supabase.table("bloque_horario").update({"estado": "disponible"}).in_("id_bloque", id_bloques_liberados).execute()
                    supabase.table("proceso_clinico").update({
                        "motivo_consulta": estudiante["motivo_consulta"],
                        "puntaje_triage": estudiante.get("puntaje_triage"),
                        "estado_revision": "pendiente"
                    }).eq("id_proceso", id_proceso).execute()
                else:
                    proceso_ins = supabase.table("proceso_clinico").insert({
                        "id_estudiante": estudiante["id_estudiante"],
                        "id_servicio": id_servicio,
                        "motivo_consulta": estudiante["motivo_consulta"],
                        "puntaje_triage": estudiante.get("puntaje_triage")
                    }).execute()
                    id_proceso = proceso_ins.data[0]["id_proceso"]

                await _procesar_reserva_bloques(id_proceso, id_bloque_final, estudiante.get("fecha_ingreso"))
                supabase.table("lista_espera").delete().eq("id_lista", id_lista).execute()

                await notificar_asignacion_automatica(
                    estudiante["id_estudiante"], id_bloque_final,
                    es_reasignacion=bool(id_bloques_liberados)
                )

                if id_bloques_liberados:
                    for bl_id in id_bloques_liberados:
                        await _attempt_automatic_assignment(bl_id)

                return True

        return False

    except Exception as e:
        print(f"Error en asignación automática para estudiante {id_lista}: {e}")
        return False


async def reagendar_serie_ciclica(id_proceso: str, id_bloque_nuevo: str):
    """Cancela las sesiones futuras pendientes de un proceso cíclico y las reasigna
    desde el nuevo bloque, manteniendo el mismo proceso_clinico."""
    proceso_req = supabase.table("proceso_clinico").select(
        "id_servicio, sesiones_realizadas, estado"
    ).eq("id_proceso", id_proceso).execute()
    if not proceso_req.data or proceso_req.data[0]["estado"] != "activo":
        return None

    id_servicio = proceso_req.data[0]["id_servicio"]
    sesiones_realizadas = proceso_req.data[0]["sesiones_realizadas"] or 0

    servicio_req = supabase.table("servicio").select("es_ciclico, tope_sesiones").eq("id_servicio", id_servicio).execute()
    if not servicio_req.data or not servicio_req.data[0]["es_ciclico"]:
        return None

    tope_sesiones = servicio_req.data[0]["tope_sesiones"] or 8
    sesiones_restantes = tope_sesiones - sesiones_realizadas
    if sesiones_restantes <= 0:
        return None

    ahora_iso = ahora_chile().isoformat()
    reservas_req = supabase.table("reserva").select(
        "id_reserva, id_bloque, estado, bloque_horario(fecha_hora_inicio)"
    ).eq("id_proceso", id_proceso).in_("estado", ["pendiente", "reservado", "confirmado"]).execute()

    reservas_a_cancelar = []
    bloques_a_liberar = []
    for res in reservas_req.data or []:
        bh = res.get("bloque_horario") or {}
        fh = bh.get("fecha_hora_inicio")
        if fh and fh >= ahora_iso:
            reservas_a_cancelar.append(res["id_reserva"])
            bloques_a_liberar.append(res["id_bloque"])

    if not reservas_a_cancelar:
        return None

    supabase.table("reserva").update({"estado": "cancelado_admin_suspension"}).in_("id_reserva", reservas_a_cancelar).execute()
    bloques_liberados = supabase.table("bloque_horario").update({"estado": "disponible"}).in_("id_bloque", bloques_a_liberar).execute()

    # Liberar la retención del slot antiguo (los bloques 'huerfano' del cupo recurrente que se dejó
    # de usar) para que vuelvan a estar disponibles a otros estudiantes.
    if bloques_a_liberar:
        await liberar_retencion_slot(bloques_a_liberar[0])

    bloque_req = supabase.table("bloque_horario").select("id_profesional, id_servicio, fecha_hora_inicio").eq("id_bloque", id_bloque_nuevo).execute()
    if not bloque_req.data or bloque_req.data[0]["id_servicio"] != id_servicio:
        return None

    b = bloque_req.data[0]
    id_profesional = b["id_profesional"]
    fecha_dt = datetime.fromisoformat(b["fecha_hora_inicio"].replace("Z", "").replace(" ", "T"))
    hora = fecha_dt.time()
    dow = fecha_dt.weekday()
    fin_anio = datetime(fecha_dt.year, 12, 31, 23, 59, 59)

    futuros = fetch_all(lambda: supabase.table("bloque_horario").select("id_bloque, fecha_hora_inicio").eq("id_profesional", id_profesional).eq("id_servicio", id_servicio).eq("estado", "disponible").gte("fecha_hora_inicio", fecha_dt.isoformat()).lte("fecha_hora_inicio", fin_anio.isoformat()))

    bloques_slot = [
        b2 for b2 in futuros
        if datetime.fromisoformat(b2["fecha_hora_inicio"].replace("Z", "").replace(" ", "T")).time() == hora
        and datetime.fromisoformat(b2["fecha_hora_inicio"].replace("Z", "").replace(" ", "T")).weekday() == dow
    ]
    bloques_slot.sort(key=lambda x: x["fecha_hora_inicio"])
    bloques_serie = bloques_slot[:sesiones_restantes]
    id_bloques_serie = [b2["id_bloque"] for b2 in bloques_serie]

    if not id_bloques_serie:
        return None

    supabase.table("bloque_horario").update({"estado": "confirmado"}).eq("id_bloque", id_bloques_serie[0]).execute()
    if len(id_bloques_serie) > 1:
        supabase.table("bloque_horario").update({"estado": "reservado"}).in_("id_bloque", id_bloques_serie[1:]).execute()

    # Retener el resto del cupo recurrente del slot nuevo para este estudiante (igual que en una
    # reserva normal): no se ofrece a otros mientras el ciclo siga activo.
    ids_retener = [b2["id_bloque"] for b2 in bloques_slot[len(id_bloques_serie):]]
    if ids_retener:
        supabase.table("bloque_horario").update({"estado": "huerfano"}).in_("id_bloque", ids_retener).execute()

    nuevas_reservas = [{"id_proceso": id_proceso, "id_bloque": bid, "estado": "pendiente"} for bid in id_bloques_serie]
    reserva_ins = supabase.table("reserva").insert(nuevas_reservas).execute()

    bloques_nuevos_set = set(id_bloques_serie)
    for bl in bloques_liberados.data or []:
        if bl["id_bloque"] not in bloques_nuevos_set:
            await _attempt_automatic_assignment(bl["id_bloque"])

    return reserva_ins.data[0] if reserva_ins.data else {}


async def cancelar_serie_a_lista_espera(id_proceso: str, disponibilidad_indicada: dict = None, campus_indicados: list = None):
    """Cancela sesiones futuras pendientes de un proceso cíclico y registra al estudiante
    en lista de espera prioritaria para el mismo servicio, manteniendo el proceso_clinico activo.

    `disponibilidad_indicada` son las horas que el estudiante indicó (mismo formato que el flujo
    prioritario normal); si trae horas, el sistema intenta una asignación automática inmediata."""
    disponibilidad_indicada = disponibilidad_indicada or {}

    proceso_req = supabase.table("proceso_clinico").select(
        "id_estudiante, id_servicio, estado"
    ).eq("id_proceso", id_proceso).execute()
    if not proceso_req.data or proceso_req.data[0]["estado"] != "activo":
        return None

    p = proceso_req.data[0]
    id_estudiante = p["id_estudiante"]
    id_servicio = p["id_servicio"]

    servicio_req = supabase.table("servicio").select("es_ciclico").eq("id_servicio", id_servicio).execute()
    if not servicio_req.data or not servicio_req.data[0]["es_ciclico"]:
        return None

    ahora_iso = ahora_chile().isoformat()
    reservas_req = supabase.table("reserva").select(
        "id_reserva, id_bloque, bloque_horario(fecha_hora_inicio)"
    ).eq("id_proceso", id_proceso).in_("estado", ["pendiente", "reservado", "confirmado"]).execute()

    reservas_a_cancelar = []
    bloques_a_liberar = []
    for res in reservas_req.data or []:
        bh = res.get("bloque_horario") or {}
        fh = bh.get("fecha_hora_inicio")
        if fh and fh >= ahora_iso:
            reservas_a_cancelar.append(res["id_reserva"])
            bloques_a_liberar.append(res["id_bloque"])

    if not reservas_a_cancelar:
        return None

    supabase.table("reserva").update({"estado": "cancelado_admin_suspension"}).in_("id_reserva", reservas_a_cancelar).execute()
    supabase.table("bloque_horario").update({"estado": "disponible"}).in_("id_bloque", bloques_a_liberar).execute()

    # Liberar la retención del slot (bloques 'huerfano' del cupo recurrente) al sacar al estudiante
    # de su serie hacia la lista de espera.
    if bloques_a_liberar:
        await liberar_retencion_slot(bloques_a_liberar[0])

    # Reusar entrada existente si la hay (no asignada), o crear una nueva
    lista_req = supabase.table("lista_espera").select("id_lista").eq(
        "id_estudiante", id_estudiante
    ).eq("id_servicio", id_servicio).neq("estado_revision", "asignado").execute()

    if lista_req.data:
        id_lista = lista_req.data[0]["id_lista"]
        supabase.table("lista_espera").update({
            "es_prioritario": True,
            "estado_revision": "pendiente",
            "estado_oferta": "esperando",
            "disponibilidad_indicada": disponibilidad_indicada,
            "campus_indicados": campus_indicados,
            "vencimiento_oferta": None,
        }).eq("id_lista", id_lista).execute()
    else:
        nueva_req = supabase.table("lista_espera").insert({
            "id_estudiante": id_estudiante,
            "id_servicio": id_servicio,
            "es_prioritario": True,
            "disponibilidad_indicada": disponibilidad_indicada,
            "campus_indicados": campus_indicados,
            "estado_revision": "pendiente",
            "estado_oferta": "esperando",
        }).execute()
        id_lista = nueva_req.data[0]["id_lista"] if nueva_req.data else None

    # Si el estudiante indicó disponibilidad, intentar primero asignarle a él (es prioritario);
    # luego liberar el resto de bloques para que otros en espera puedan tomarlos.
    if id_lista and disponibilidad_indicada:
        await _attempt_automatic_assignment_for_student(id_lista)
    for id_bloque in bloques_a_liberar:
        await _attempt_automatic_assignment(id_bloque)

    return id_lista
