from datetime import datetime, timedelta
from fastapi import APIRouter, HTTPException, Depends, Query
from fastapi.security import HTTPAuthorizationCredentials
from database import supabase, fetch_all
from dependencies import security, obtener_usuario_actual
from schemas import SolicitudRegistroEstudiante
from utils_tiempo import ahora_chile

router = APIRouter()


@router.get("/usuario_actual")
async def get_usuario_actual(usuario_actual: dict = Depends(obtener_usuario_actual)):
    return usuario_actual


@router.post("/registro_estudiante")
async def registrar_estudiante_nuevo(datos: SolicitudRegistroEstudiante, credentials: HTTPAuthorizationCredentials = Depends(security)):
    token = credentials.credentials
    try:
        auth_response = supabase.auth.get_user(token)
        if not auth_response or not auth_response.user:
            raise HTTPException(status_code=401, detail="Token inválido o expirado.")

        user_email = auth_response.user.email

        # Validación de dominio en el servidor: el filtro del frontend es solo UX
        # (cualquiera con un token de Google válido podría llamar este endpoint directo).
        # Solo correos institucionales de estudiante pueden auto-registrarse; el personal
        # se crea desde el panel del coordinador.
        if not user_email.endswith("@mail.pucv.cl"):
            raise HTTPException(status_code=403, detail="Solo correos @mail.pucv.cl pueden registrarse como estudiantes. El personal debe ser creado por coordinación.")

        check_req = supabase.table("usuario").select("id_usuario").eq("email", user_email).execute()
        if check_req.data:
            id_user = check_req.data[0]["id_usuario"]
            est_check = supabase.table("estudiante").select("id_estudiante").eq("id_usuario", id_user).execute()
            if est_check.data:
                raise HTTPException(status_code=400, detail="El usuario ya tiene un perfil de estudiante completo.")
        else:
            user_ins = supabase.table("usuario").insert({"email": user_email, "rol": "estudiante"}).execute()
            id_user = user_ins.data[0]["id_usuario"]

        supabase.table("estudiante").insert({
            "id_usuario": id_user,
            "rut": datos.rut,
            "nombres": datos.nombres,
            "apellidos": datos.apellidos,
            "carrera": datos.carrera
        }).execute()
        return {"mensaje": "Perfil completado exitosamente."}
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/servicios")
async def obtener_servicios():
    try:
        respuesta = supabase.table("servicio").select("id_servicio, nombre, es_ciclico, duracion_minutos, tope_sesiones, acronimo").execute()
        return respuesta.data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/ubicaciones")
async def obtener_ubicaciones(activo: bool = Query(None)):
    try:
        query = supabase.table("ubicacion").select("id_ubicacion, nombre, activo, abreviatura").order("nombre")
        if activo is not None:
            query = query.eq("activo", activo)
        return query.execute().data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/disponibilidad")
async def obtener_disponibilidad(
    id_servicio: str = Query(...),
    ventana_dias: int | None = Query(
        None,
        description=(
            "Si se indica (>0), solo devuelve bloques dentro de los próximos N días. "
            "El flujo del estudiante pasa 14: solo puede agendar dentro de las próximas "
            "2 semanas y más allá queda en lista de espera. El personal "
            "(admin/coordinador/profesional) lo omite para agendar sin tope."
        ),
    ),
):
    try:
        servicio_req = supabase.table("servicio").select("es_ciclico").eq("id_servicio", id_servicio).execute()
        if not servicio_req.data:
            raise HTTPException(status_code=404, detail="Servicio no encontrado.")

        es_ciclico = servicio_req.data[0]["es_ciclico"]
        ahora_local = ahora_chile()
        ahora_str = ahora_local.isoformat()

        def query():
            q = supabase.table("bloque_horario").select(
                "id_bloque, fecha_hora_inicio, fecha_hora_fin, profesional(nombres, apellidos), ubicacion(id_ubicacion, nombre)"
            ).eq("id_servicio", id_servicio).eq("estado", "disponible").gt("fecha_hora_inicio", ahora_str)
            # Tope de ventana. El estudiante manda ventana_dias=14: TODOS los servicios se
            # acotan a las próximas 2 semanas (lo de más allá solo se resuelve por lista de
            # espera). Sin el parámetro (personal) se mantiene el tope histórico de 14 días
            # solo para servicios cíclicos, cuya serie semanal generaría miles de bloques.
            if ventana_dias and ventana_dias > 0:
                q = q.lte("fecha_hora_inicio", (ahora_local + timedelta(days=ventana_dias)).isoformat())
            elif es_ciclico:
                q = q.lte("fecha_hora_inicio", (ahora_local + timedelta(days=14)).isoformat())
            return q

        # Paginado: un servicio sub-horario acumula miles de bloques al año; sin esto
        # PostgREST trunca en 1000 filas y hay disponibilidad que nunca se muestra.
        return fetch_all(query)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/ocupacion_slot")
async def obtener_ocupacion_slot(
    id_servicio: str = Query(...),
    dia: str = Query(..., description="Día de la semana: lunes|martes|miercoles|jueves|viernes|sabado|domingo"),
    hora: str = Query(..., description="Hora exacta de inicio del slot en formato HH:MM"),
):
    """Para un servicio en un día de la semana + hora exacta, cuenta cuántos
    profesionales tienen su cupo OCUPADO (bloque en estado 'reservado' o
    'confirmado') en cada campus. Sirve para que un estudiante que se inscribe
    en la lista de espera vea en qué campus hay cupos que podrían liberarse.

    Devuelve un dict { id_ubicacion (o "__none__"): cantidad_profesionales_ocupados }.
    """
    try:
        dias_map = {
            "lunes": 0, "martes": 1, "miercoles": 2, "jueves": 3,
            "viernes": 4, "sabado": 5, "domingo": 6,
        }
        dow = dias_map.get(dia.strip().lower())
        if dow is None:
            raise HTTPException(status_code=400, detail="Día de la semana inválido.")

        ahora_local = ahora_chile()
        # Ventana acotada: para servicios cíclicos la serie semanal genera decenas de
        # bloques al año; con ~4 semanas basta para captar a cada profesional al menos
        # una vez en ese día/hora. Contamos profesionales DISTINTOS (no bloques) para
        # no inflar el número con las repeticiones semanales de la misma serie.
        limite = (ahora_local + timedelta(days=28)).isoformat()

        def query():
            return (
                supabase.table("bloque_horario")
                .select("id_profesional, fecha_hora_inicio, ubicacion(id_ubicacion)")
                .eq("id_servicio", id_servicio)
                .in_("estado", ["reservado", "confirmado"])
                .gt("fecha_hora_inicio", ahora_local.isoformat())
                .lte("fecha_hora_inicio", limite)
            )

        # fetch_all evita el tope de 1000 filas de PostgREST.
        bloques = fetch_all(query)

        # id_ubicacion -> set(id_profesional) ocupados en ese día/hora exactos.
        ocupados: dict = {}
        for b in bloques:
            fecha = datetime.fromisoformat(
                b["fecha_hora_inicio"].replace("Z", "").replace(" ", "T")
            )
            if fecha.weekday() != dow:
                continue
            if fecha.strftime("%H:%M") != hora:
                continue
            id_ubi = (b.get("ubicacion") or {}).get("id_ubicacion") or "__none__"
            ocupados.setdefault(id_ubi, set()).add(b.get("id_profesional"))

        return {id_ubi: len(profs) for id_ubi, profs in ocupados.items()}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/slots_ocupados")
async def obtener_slots_ocupados(id_servicio: str = Query(...)):
    """Para un servicio, devuelve el conjunto de slots (día de semana + hora exacta)
    donde HAY al menos un profesional atendiendo con su cupo OCUPADO (bloque
    'reservado' o 'confirmado'). La grilla de lista de espera los pinta de
    AMARILLO: son los horarios donde es más probable que se libere un cupo
    (hay profesionales atendiendo), frente a los GRISES donde no atiende nadie y
    solo se abriría un cupo si se publican horas nuevas.

    Devuelve una lista de strings "dia|HH:MM" (dia en español, como usa la grilla).
    Misma ventana de 28 días y lógica de weekday/hora que /ocupacion_slot para no
    inflar con las repeticiones semanales de una serie cíclica.
    """
    try:
        dias_nombre = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"]
        ahora_local = ahora_chile()
        limite = (ahora_local + timedelta(days=28)).isoformat()

        def query():
            return (
                supabase.table("bloque_horario")
                .select("fecha_hora_inicio")
                .eq("id_servicio", id_servicio)
                .in_("estado", ["reservado", "confirmado"])
                .gt("fecha_hora_inicio", ahora_local.isoformat())
                .lte("fecha_hora_inicio", limite)
            )

        # fetch_all evita el tope de 1000 filas de PostgREST.
        bloques = fetch_all(query)

        slots = set()
        for b in bloques:
            fecha = datetime.fromisoformat(
                b["fecha_hora_inicio"].replace("Z", "").replace(" ", "T")
            )
            dow = fecha.weekday()
            if dow > 6:
                continue
            slots.add(f"{dias_nombre[dow]}|{fecha.strftime('%H:%M')}")

        return sorted(slots)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/profesionales_activos")
async def obtener_profesionales_activos(usuario_actual: dict = Depends(obtener_usuario_actual)):
    if usuario_actual["rol"] not in ["profesional_apoyo", "coordinador", "administrativo"]:
        raise HTTPException(status_code=403, detail="Acceso denegado.")
    try:
        req = supabase.table("profesional").select("id_profesional, nombres, apellidos").execute()
        return req.data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
