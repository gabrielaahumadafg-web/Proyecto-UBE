from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import publico, estudiante, profesional, coordinador, admin, reportes

app = FastAPI(title="API Sistema de Reservas UBE")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
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
