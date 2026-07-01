from fastapi import HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from database import supabase

security = HTTPBearer()

async def obtener_usuario_actual(credentials: HTTPAuthorizationCredentials = Depends(security)):
    token = credentials.credentials
    try:
        auth_response = supabase.auth.get_user(token)
        if not auth_response or not auth_response.user:
            raise HTTPException(status_code=401, detail="Token inválido o expirado.")

        user_email = auth_response.user.email
        usuario_req = supabase.table("usuario").select("id_usuario, email, rol").eq("email", user_email).execute()
        if not usuario_req.data:
            raise HTTPException(status_code=404, detail="Usuario autenticado pero no registrado en el sistema.")

        usuario_db = usuario_req.data[0]
        id_estudiante = None
        id_profesional = None

        if usuario_db["rol"] == "estudiante":
            est_req = supabase.table("estudiante").select("id_estudiante").eq("id_usuario", usuario_db["id_usuario"]).execute()
            if est_req.data:
                id_estudiante = est_req.data[0]["id_estudiante"]
        elif usuario_db["rol"] == "profesional":
            prof_req = supabase.table("profesional").select("id_profesional").eq("id_usuario", usuario_db["id_usuario"]).execute()
            if prof_req.data:
                id_profesional = prof_req.data[0]["id_profesional"]

        return {
            "rol": usuario_db["rol"],
            "id_usuario": usuario_db["id_usuario"],
            "id_estudiante": id_estudiante,
            "id_profesional": id_profesional,
            "email": usuario_db["email"]
        }
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Error de autenticación: {str(e)}")
