// Dirección base del backend (FastAPI).
// En desarrollo local se usa http://localhost:8000 por defecto.
// En producción se define la variable VITE_API_URL con la URL pública del backend.
export const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";
