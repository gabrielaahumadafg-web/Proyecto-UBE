import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import publico, estudiante, profesional, coordinador, admin, reportes

app = FastAPI(title="API Sistema de Reservas UBE")

# Orígenes permitidos: lista separada por comas en la variable de entorno
# ALLOWED_ORIGINS (ej: "https://mi-frontend.vercel.app,http://localhost:5173").
# Sin configurar se permite cualquier origen; la auth usa Bearer tokens (no
# cookies), así que allow_credentials no es necesario en ese caso.
_origins_env = os.getenv("ALLOWED_ORIGINS", "").strip()
_allowed_origins = [o.strip() for o in _origins_env.split(",") if o.strip()] if _origins_env else ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=_allowed_origins != ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(publico.router)
app.include_router(estudiante.router)
app.include_router(profesional.router)
app.include_router(coordinador.router)
app.include_router(coordinador.router_bloques)
app.include_router(admin.router)
app.include_router(reportes.router)
