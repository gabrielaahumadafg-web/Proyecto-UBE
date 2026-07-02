"""
Gestión de inasistencias y su justificación.

Una *inasistencia* es todo evento de ausencia (no-show, atraso o cancelación con
menos de 48h). Se registra como una fila en la tabla `inasistencia` con estado
`pendiente_justificacion`. Una *falta* es una inasistencia NO justificada: solo se
cuenta (en `proceso_clinico.faltas_acumuladas`) cuando la justificación se rechaza
o cuando vence el plazo sin que el estudiante justifique. Las faltas son las que
habilitan la suspensión (a partir de 2).
"""
from datetime import datetime, timedelta
from database import supabase, fetch_all
from services.asignacion import _agendar_reposicion_ciclica
from services.notificaciones import notificar_resolucion_justificacion


def _calcular_fecha_limite(fecha_bloque_dt: datetime, fecha_registro_dt: datetime) -> str:
    """Plazo de justificación = max(bloque + 3 días, marcado + 2 días)."""
    limite = max(fecha_bloque_dt + timedelta(days=3), fecha_registro_dt + timedelta(days=2))
    return limite.isoformat()


def registrar_inasistencia(id_reserva: str, id_proceso: str, id_estudiante: str,
                           id_servicio: str, tipo: str, fecha_inasistencia_iso: str | None):
    """Inserta un evento de inasistencia en estado pendiente de justificación.

    No incrementa `faltas_acumuladas`: la inasistencia recién creada aún puede
    justificarse. Envuelto en try/except para no romper el flujo de cancelación o
    de registro de asistencia si la tabla aún no existe en algún entorno.
    """
    try:
        ahora = datetime.utcnow()
        fecha_bloque_dt = ahora
        if fecha_inasistencia_iso:
            try:
                fecha_bloque_dt = datetime.fromisoformat(
                    fecha_inasistencia_iso.replace("Z", "").replace(" ", "T")
                )
            except ValueError:
                fecha_bloque_dt = ahora
        fila = {
            "id_reserva": id_reserva,
            "id_proceso": id_proceso,
            "id_estudiante": id_estudiante,
            "id_servicio": id_servicio,
            "tipo": tipo,
            "estado": "pendiente_justificacion",
            "fecha_inasistencia": fecha_bloque_dt.isoformat(),
            "fecha_registro": ahora.isoformat(),
            "fecha_limite_justificacion": _calcular_fecha_limite(fecha_bloque_dt, ahora),
        }
        res = supabase.table("inasistencia").insert(fila).execute()
        return res.data[0]["id_inasistencia"] if res.data else None
    except Exception as e:
        print(f"[inasistencias] No se pudo registrar la inasistencia: {e}")
        return None


def _sumar_faltas(id_proceso: str, delta: int):
    """Incrementa o decrementa faltas_acumuladas sin bajar de 0."""
    proc = supabase.table("proceso_clinico").select("faltas_acumuladas").eq("id_proceso", id_proceso).execute()
    if not proc.data:
        return
    actual = proc.data[0].get("faltas_acumuladas") or 0
    nuevo = max(0, actual + delta)
    supabase.table("proceso_clinico").update({"faltas_acumuladas": nuevo}).eq("id_proceso", id_proceso).execute()


def reiniciar_faltas_servicio(id_estudiante: str, id_servicio: str, hasta_iso: str | None = None):
    """Reinicia la cuenta de faltas/inasistencias de un estudiante en un servicio.

    Se usa cuando una suspensión se cumple (vence) o se levanta manualmente: el
    "castigo" terminó, así que el estudiante parte con la cuenta limpia. Borra los
    eventos de `inasistencia` de ese (estudiante, servicio) ocurridos hasta
    `hasta_iso` (para no tocar faltas nuevas posteriores a la suspensión) y pone a
    cero los contadores en sus `proceso_clinico` del servicio.
    """
    try:
        q = supabase.table("inasistencia").delete().eq(
            "id_estudiante", id_estudiante
        ).eq("id_servicio", id_servicio)
        if hasta_iso:
            q = q.lte("fecha_inasistencia", hasta_iso)
        q.execute()
    except Exception as e:
        print(f"[inasistencias] No se pudieron borrar inasistencias: {e}")
    try:
        supabase.table("proceso_clinico").update({
            "faltas_acumuladas": 0,
            "inasistencias_acumuladas": 0,
        }).eq("id_estudiante", id_estudiante).eq("id_servicio", id_servicio).execute()
    except Exception as e:
        print(f"[inasistencias] No se pudieron reiniciar los contadores: {e}")


def procesar_suspensiones_cumplidas():
    """Limpieza perezosa: toda suspensión cuya `fecha_fin` ya pasó se considera
    cumplida -> reinicia las faltas previas del estudiante en ese servicio y
    elimina la suspensión vencida (ya no bloquea ni hace falta conservarla).

    Idempotente: las faltas nuevas (posteriores a `fecha_fin`) no se tocan porque
    se filtran por fecha, y la suspensión vencida se borra tras procesarla.
    """
    try:
        ahora_iso = datetime.utcnow().isoformat()
        vencidas = fetch_all(lambda: supabase.table("suspension_servicio").select(
            "id_suspension, id_estudiante, id_servicio, fecha_fin"
        ).lt("fecha_fin", ahora_iso))
        for s in vencidas:
            reiniciar_faltas_servicio(s["id_estudiante"], s["id_servicio"], s.get("fecha_fin"))
            supabase.table("suspension_servicio").delete().eq(
                "id_suspension", s["id_suspension"]
            ).execute()
    except Exception as e:
        print(f"[inasistencias] Error procesando suspensiones cumplidas: {e}")


def procesar_inasistencias_vencidas():
    """Promueve a falta toda inasistencia pendiente cuyo plazo ya venció.

    Limpieza perezosa (sin cron): se invoca al cargar las vistas de admin.
    """
    try:
        ahora_iso = datetime.utcnow().isoformat()
        vencidas = fetch_all(lambda: supabase.table("inasistencia").select("id_inasistencia, id_proceso").eq(
            "estado", "pendiente_justificacion"
        ).lt("fecha_limite_justificacion", ahora_iso))
        for fila in vencidas:
            supabase.table("inasistencia").update({"estado": "vencida_sin_justificar"}).eq(
                "id_inasistencia", fila["id_inasistencia"]
            ).execute()
            _sumar_faltas(fila["id_proceso"], +1)
    except Exception as e:
        print(f"[inasistencias] Error procesando vencidas: {e}")


async def resolver_inasistencia(id_inasistencia: str, aprobada: bool,
                                resuelto_por: str | None = None,
                                motivo_resolucion: str | None = None) -> dict:
    """Aprueba o rechaza una inasistencia.

    - Aprobar: estado -> justificada, ajusta `reserva.estado`, descuenta la falta si
      ya se había contado, y agenda reposición si el servicio es cíclico.
    - Rechazar: estado -> rechazada, suma 1 falta (solo si no estaba ya contada).
    """
    req = supabase.table("inasistencia").select(
        "id_inasistencia, id_reserva, id_proceso, id_estudiante, id_servicio, tipo, estado"
    ).eq("id_inasistencia", id_inasistencia).execute()
    if not req.data:
        return {"ok": False, "detail": "Inasistencia no encontrada."}
    fila = req.data[0]
    estado_actual = fila["estado"]
    if estado_actual == "justificada" and aprobada:
        return {"ok": True, "mensaje": "La inasistencia ya estaba justificada.", "reposicion": None}

    era_falta = estado_actual in ("rechazada", "vencida_sin_justificar")
    ahora_iso = datetime.utcnow().isoformat()
    reposicion = None

    if aprobada:
        supabase.table("inasistencia").update({
            "estado": "justificada",
            "resuelto_por": resuelto_por,
            "fecha_resolucion": ahora_iso,
            "motivo_resolucion": motivo_resolucion,
        }).eq("id_inasistencia", id_inasistencia).execute()

        if era_falta:
            _sumar_faltas(fila["id_proceso"], -1)

        # Ajustar el estado de la reserva original
        if fila.get("id_reserva"):
            if fila["tipo"] == "cancelacion_tardia":
                nuevo_estado_reserva = "cancelado_estudiante"
            elif fila["tipo"] == "atraso":
                nuevo_estado_reserva = None  # el alumno asistió, tarde: se mantiene
            else:
                nuevo_estado_reserva = "ausente_justificado"
            if nuevo_estado_reserva:
                supabase.table("reserva").update({"estado": nuevo_estado_reserva}).eq(
                    "id_reserva", fila["id_reserva"]
                ).execute()

        # Reposición para servicios cíclicos
        if fila.get("id_reserva"):
            reposicion = await _agendar_reposicion_ciclica(fila["id_proceso"], fila["id_reserva"])
        await notificar_resolucion_justificacion(fila.get("id_estudiante"), fila.get("id_servicio"), True)
        return {"ok": True, "mensaje": "Inasistencia justificada.", "reposicion": reposicion}
    else:
        supabase.table("inasistencia").update({
            "estado": "rechazada",
            "resuelto_por": resuelto_por,
            "fecha_resolucion": ahora_iso,
            "motivo_resolucion": motivo_resolucion,
        }).eq("id_inasistencia", id_inasistencia).execute()
        if not era_falta:
            _sumar_faltas(fila["id_proceso"], +1)
        await notificar_resolucion_justificacion(fila.get("id_estudiante"), fila.get("id_servicio"), False)
        return {"ok": True, "mensaje": "Justificación rechazada. Se registró una falta.", "reposicion": None}
