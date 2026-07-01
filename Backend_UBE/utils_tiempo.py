"""Utilidades de tiempo para el backend.

Los bloques horarios se guardan en **hora local de Chile** (lo que el usuario
escribe: "17:00" significa las 17:00 en Chile). El servidor de Render, en cambio,
corre en **UTC**. Comparar una hora de bloque contra ``datetime.utcnow()`` hace que
un bloque de hoy en la tarde parezca "pasado" varias horas antes (UTC-4), por lo que
toda comparación bloque-vs-ahora debe usar :func:`ahora_chile`.

OJO: los timestamps generados por el servidor (vencimiento de ofertas, fecha_fin de
suspensiones, plazos de justificación) se escriben con ``utcnow`` y deben seguir
comparándose con ``utcnow`` para mantener su consistencia interna — esos NO usan este
helper.
"""
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
    _TZ_CHILE = ZoneInfo("America/Santiago")
except Exception:
    _TZ_CHILE = None


def parse_utc_naive(iso_str: str | None):
    """Parsea un timestamp ISO a ``datetime`` *naive* en UTC.

    Postgres devuelve las columnas ``timestamptz`` con offset (``+00:00``), lo que
    produce un datetime *aware*. Compararlo directamente contra ``datetime.utcnow()``
    (naive) lanza ``TypeError: can't compare offset-naive and offset-aware datetimes``.
    Este helper normaliza a UTC y quita el ``tzinfo`` para que la comparación sea
    segura. Devuelve ``None`` si la cadena es vacía o no parseable.
    """
    if not iso_str:
        return None
    try:
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00").replace(" ", "T"))
    except ValueError:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def ahora_chile() -> datetime:
    """Hora local de Chile como ``datetime`` naive (para comparar con horas de bloque).

    Usa la zona ``America/Santiago``, que ajusta el horario de verano automáticamente.
    Si ``zoneinfo`` no encuentra la zona (p. ej. falta ``tzdata``), cae a un respaldo
    fijo de UTC-4.
    """
    if _TZ_CHILE is not None:
        return datetime.now(_TZ_CHILE).replace(tzinfo=None)
    return datetime.utcnow() - timedelta(hours=4)
