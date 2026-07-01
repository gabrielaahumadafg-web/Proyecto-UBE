"""
Feriados legales de Chile, calculados por año.

Se usa al generar series semanales de bloques (coordinador.py) para NO publicar
disponibilidad sobre un feriado. Cubre los feriados nacionales fijos, los basados en
Pascua (Viernes/Sábado Santo) y los movibles por la "ley de feriados" (Ley 19.668 para
San Pedro y San Pablo / Encuentro de Dos Mundos, y Ley 20.299 para el Día de las Iglesias
Evangélicas).

Nota: el Día Nacional de los Pueblos Indígenas se fija cada año por decreto según el
solsticio de invierno (20 o 21 de junio). Se usa un override conocido por año y, si no
está, se asume el 20 de junio.
"""
from datetime import date, timedelta
from functools import lru_cache


def _domingo_pascua(anio: int) -> date:
    """Algoritmo de Gauss/Anonymous Gregorian para el Domingo de Resurrección."""
    a = anio % 19
    b = anio // 100
    c = anio % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    mes = (h + l - 7 * m + 114) // 31
    dia = ((h + l - 7 * m + 114) % 31) + 1
    return date(anio, mes, dia)


def _mover_ley_19668(d: date) -> date:
    """
    San Pedro y San Pablo (29-jun) y Encuentro de Dos Mundos (12-oct):
    martes/miércoles/jueves -> lunes de esa semana; viernes -> lunes siguiente.
    """
    wd = d.weekday()  # lunes=0
    if wd in (1, 2, 3):       # martes, miércoles, jueves
        return d - timedelta(days=wd)
    if wd == 4:               # viernes
        return d + timedelta(days=3)
    return d


def _mover_iglesias_evangelicas(anio: int) -> date:
    """
    Día de las Iglesias Evangélicas (31-oct, Ley 20.299):
    si cae martes -> viernes anterior; si cae miércoles -> viernes de esa semana; si no, 31-oct.
    """
    d = date(anio, 10, 31)
    wd = d.weekday()
    if wd == 1:               # martes -> viernes anterior
        return d - timedelta(days=4)
    if wd == 2:               # miércoles -> viernes siguiente
        return d + timedelta(days=2)
    return d


# Día Nacional de los Pueblos Indígenas (solsticio de invierno; decreto anual)
_PUEBLOS_INDIGENAS = {
    2024: date(2024, 6, 20),
    2025: date(2025, 6, 20),
    2026: date(2026, 6, 21),
}


@lru_cache(maxsize=None)
def feriados_anio(anio: int) -> frozenset:
    """Devuelve el conjunto (frozenset) de objetos date que son feriado legal en Chile ese año."""
    pascua = _domingo_pascua(anio)
    dias = {
        date(anio, 1, 1),                       # Año Nuevo
        pascua - timedelta(days=2),             # Viernes Santo
        pascua - timedelta(days=1),             # Sábado Santo
        date(anio, 5, 1),                       # Día del Trabajo
        date(anio, 5, 21),                      # Glorias Navales
        _mover_ley_19668(date(anio, 6, 29)),    # San Pedro y San Pablo
        date(anio, 7, 16),                      # Virgen del Carmen
        date(anio, 8, 15),                      # Asunción de la Virgen
        date(anio, 9, 18),                      # Independencia Nacional
        date(anio, 9, 19),                      # Glorias del Ejército
        _mover_ley_19668(date(anio, 10, 12)),   # Encuentro de Dos Mundos
        _mover_iglesias_evangelicas(anio),      # Iglesias Evangélicas
        date(anio, 11, 1),                      # Todos los Santos
        date(anio, 12, 8),                      # Inmaculada Concepción
        date(anio, 12, 25),                     # Navidad
    }
    dias.add(_PUEBLOS_INDIGENAS.get(anio, date(anio, 6, 20)))  # Pueblos Indígenas
    return frozenset(dias)


def es_feriado(d) -> bool:
    """True si la fecha (date o datetime) cae en un feriado legal chileno."""
    if hasattr(d, "date"):
        d = d.date()
    return d in feriados_anio(d.year)
