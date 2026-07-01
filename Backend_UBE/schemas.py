from typing import Optional
from pydantic import BaseModel


class SolicitudReserva(BaseModel):
    id_bloque: str
    motivo_consulta: str = ""
    puntaje_triage: Optional[int] = None

class SolicitudListaEspera(BaseModel):
    id_servicio: str
    disponibilidad_indicada: dict = {}
    motivo_consulta: str = ""
    puntaje_triage: Optional[int] = None
    campus_indicados: Optional[list[str]] = None
    campus_por_slot: Optional[dict] = None  # {"lunes|09:00": ["uuid1", ...], ...}

class SolicitudActualizarDisponibilidad(BaseModel):
    disponibilidad_indicada: dict
    campus_indicados: Optional[list[str]] = None
    campus_por_slot: Optional[dict] = None  # {"lunes|09:00": ["uuid1", ...], ...}

class SolicitudAsistencia(BaseModel):
    id_reserva: str
    estado: str

class SolicitudEvolucion(BaseModel):
    id_reserva: str
    observaciones: str
    diagnostico: str = ""
    plan_tratamiento: str = ""
    id_servicios_derivacion: Optional[list[str]] = None
    derivaciones_detalles: Optional[list[dict]] = None
    id_bloque_derivacion: Optional[str] = None
    disponibilidad_derivacion: Optional[dict] = None
    decision_continuidad: str
    es_caso_critico: bool = False
    sesiones_adicionales: int = 0  # 1-10: extiende la serie cíclica en la última sesión

class CancelacionReserva(BaseModel):
    id_reserva: str

class SolicitudCritico(BaseModel):
    id_proceso: str

class SolicitudReagendamiento(BaseModel):
    id_reserva_original: str
    id_bloque_nuevo: str

class SolicitudCambiarSerie(BaseModel):
    id_proceso: str
    id_bloque_nuevo: str

class SolicitudListaEsperaSerie(BaseModel):
    id_proceso: str
    disponibilidad_indicada: dict = {}
    campus_indicados: Optional[list[str]] = None

class SolicitudRespuestaOferta(BaseModel):
    id_lista: str
    aceptada: bool

class SolicitudCrearUsuario(BaseModel):
    email: str
    password: str
    rol: str
    nombres: Optional[str] = None
    apellidos: Optional[str] = None
    servicios: Optional[list[str]] = None
    rut: Optional[str] = None
    carrera: Optional[str] = None

class SolicitudCrearServicio(BaseModel):
    nombre: str
    es_ciclico: bool = False
    tope_sesiones: Optional[int] = None
    duracion_minutos: int = 60
    acronimo: Optional[str] = None

class SolicitudActualizarServicio(BaseModel):
    nombre: Optional[str] = None
    es_ciclico: Optional[bool] = None
    tope_sesiones: Optional[int] = None
    duracion_minutos: Optional[int] = None
    acronimo: Optional[str] = None

class SolicitudActualizarProfesional(BaseModel):
    servicios: list[str]

class SolicitudCrearBloque(BaseModel):
    id_profesional: str
    id_servicio: str
    es_ciclico: bool = False
    fechas_inicio: Optional[list[str]] = None
    bloques_ciclicos: Optional[list[dict]] = None
    id_ubicacion: Optional[str] = None

class SolicitudActualizarBloque(BaseModel):
    id_servicio: Optional[str] = None
    fecha_hora_inicio: Optional[str] = None
    fecha_hora_fin: Optional[str] = None
    id_ubicacion: Optional[str] = None

class SolicitudCrearUbicacion(BaseModel):
    nombre: str
    abreviatura: Optional[str] = None
    direccion: Optional[str] = None  # dirección física; solo se usa en el correo de confirmación

class SolicitudActualizarUbicacion(BaseModel):
    nombre: Optional[str] = None
    activo: Optional[bool] = None
    abreviatura: Optional[str] = None
    direccion: Optional[str] = None

class SolicitudRegistroEstudiante(BaseModel):
    rut: str
    nombres: str
    apellidos: str
    carrera: str

class SolicitudAsignacionManual(BaseModel):
    id_lista: str
    id_bloque: str

class SolicitudActualizarPrioridad(BaseModel):
    es_prioritario: bool

class SolicitudMarcarRevisado(BaseModel):
    estado_revision: str

class SolicitudSuspension(BaseModel):
    id_proceso: str

class SolicitudLevantarSuspension(BaseModel):
    id_suspension: str

class SolicitudCancelarReservaAdmin(BaseModel):
    id_reserva: str

class SolicitudAgendarHoraAdmin(BaseModel):
    id_estudiante: str
    id_servicio: str
    id_bloque: Optional[str] = None
    tipo_agendamiento: str
    disponibilidad_indicada: Optional[dict] = None
    motivo_consulta: str = "Agendamiento administrativo"
    campus_indicados: Optional[list[str]] = None

class SolicitudJustificarInasistencia(BaseModel):
    id_inasistencia: str
    motivo: str

class SolicitudResolverJustificacion(BaseModel):
    id_inasistencia: str
    aprobada: bool
    motivo_resolucion: Optional[str] = None

class SolicitudJustificarDirecto(BaseModel):
    id_inasistencia: Optional[str] = None
    id_reserva: Optional[str] = None
