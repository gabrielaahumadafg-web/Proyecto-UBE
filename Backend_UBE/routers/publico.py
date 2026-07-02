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
async def obtener_disponibilidad(id_servicio: str = Query(...)):
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
            if es_ciclico:
                q = q.lte("fecha_hora_inicio", (ahora_local + timedelta(days=14)).isoformat())
            return q

        # Paginado: un servicio sub-horario acumula miles de bloques al año; sin esto
        # PostgREST trunca en 1000 filas y hay disponibilidad que nunca se muestra.
        return fetch_all(query)
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
