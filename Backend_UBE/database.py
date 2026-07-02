import os
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise ValueError("Configuración de credenciales de Supabase ausente.")

llave_principal = SUPABASE_SERVICE_KEY if SUPABASE_SERVICE_KEY else SUPABASE_KEY
supabase: Client = create_client(SUPABASE_URL, llave_principal)
supabase_admin: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY) if SUPABASE_SERVICE_KEY else None


def fetch_all(build_query, page_size: int = 1000) -> list:
    """Trae TODAS las filas de una consulta paginando con .range().

    PostgREST (Supabase) limita cada respuesta a max-rows (1000 por defecto) y
    TRUNCA EN SILENCIO lo que sobre: una consulta sin límite explícito parece
    completa pero no lo es. Este helper reconstruye la consulta por página
    (el builder es mutable, no se puede reutilizar) y acumula hasta agotar.

    `build_query` es una función sin argumentos que devuelve la consulta armada,
    SIN ejecutar. Ej:
        filas = fetch_all(lambda: supabase.table("bloque_horario")
                          .select("id_bloque").eq("estado", "disponible"))
    """
    filas = []
    offset = 0
    while True:
        req = build_query().range(offset, offset + page_size - 1).execute()
        datos = req.data or []
        filas.extend(datos)
        if len(datos) < page_size:
            break
        offset += page_size
    return filas


def in_chunks(items: list, size: int = 200):
    """Divide una lista en trozos para usar en filtros .in_() sin generar URLs
    gigantes (PostgREST pasa los filtros por query string)."""
    for i in range(0, len(items), size):
        yield items[i:i + size]
