# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Sistema de reservas para la Unidad de Bienestar Estudiantil (UBE) de la PUCV. Allows students to book health/wellness appointments, manages waitlists, and provides role-specific dashboards.

**Stack:** FastAPI backend (deployed on Render) + React/Vite frontend (deployed on Vercel) + Supabase (PostgreSQL + Auth)

## Development Commands

### Frontend (`Frontend_UBE/`)
```bash
npm run dev        # start dev server (http://localhost:5173)
npm run build      # production build
npm run lint       # eslint check
```

### Backend (`Backend_UBE/`)
```bash
uvicorn main:app --reload   # start dev server (http://localhost:8000)
```

### Environment setup

**Backend** (`Backend_UBE/.env`):
```
SUPABASE_URL="https://TU_PROYECTO.supabase.co"
SUPABASE_KEY="TU_ANON_KEY"          # public anon key
SUPABASE_SERVICE_KEY="TU_SERVICE_ROLE_KEY"   # elevated; used for user creation
BREVO_API_KEY="xkeysib-..."                   # optional; Brevo HTTP API key for email
MAIL_FROM_EMAIL="ubenotificaciones@gmail.com" # optional; verified Brevo sender (defaults to GMAIL_USER)
GMAIL_USER="ubenotificaciones@gmail.com"      # optional; fallback sender email
GMAIL_FROM_NAME="UBE PUCV"                     # optional; display name (default "UBE PUCV")
```
- Email notifications (`services/notificaciones.py`) use the **Brevo HTTP API** (`api.brevo.com`, port 443), **not** SMTP — Render blocks outbound SMTP ports (25/465/587), so Gmail SMTP times out from production. The sender (`MAIL_FROM_EMAIL`, falling back to `GMAIL_USER`) must be a **verified sender** in Brevo. If `BREVO_API_KEY` is unset, sending is skipped silently (logged) — nothing breaks.

**Frontend** (`Frontend_UBE/.env.local`):
```
VITE_SUPABASE_URL="https://TU_PROYECTO.supabase.co"
VITE_SUPABASE_ANON_KEY="TU_ANON_KEY"
VITE_API_URL="https://backend.example.com"  # optional; defaults to http://localhost:8000
```

- `SUPABASE_SERVICE_KEY` goes **only** to the backend — never to the frontend
- Frontend vars must be prefixed with `VITE_`

## Architecture

### Auth flow
Supabase Auth handles login (Google OAuth for students, email+password for staff). The frontend passes the JWT as `Authorization: Bearer <token>` on every API call. `Backend_UBE/dependencies.py:obtener_usuario_actual` validates the token against Supabase, then looks up the user's role and profile IDs (`id_estudiante` or `id_profesional`) from the `usuario` table.

`obtener_usuario_actual` returns:
```python
{ "rol": str, "id_estudiante": str|None, "id_profesional": str|None, "email": str }
```

**Email domain validation (frontend, `App.jsx`):** Only allows `@mail.pucv.cl`, `@pucv.cl`, `@gmail.com`, or addresses containing `coordinador`/`admin`/`test`.

**First-login flow for students:** If `GET /usuario_actual` returns no `id_estudiante`, `App.jsx` shows the registration form before rendering the dashboard. Registration posts to `POST /registro_estudiante`.

### Roles and their dashboards
| Role | Component |
|------|-----------|
| `estudiante` | `Dashboard.jsx` + `AgendarHora.jsx` |
| `profesional` | `DashboardProfesional.jsx` |
| `profesional_apoyo` | `DashboardProfesionalApoyo.jsx` |
| `coordinador` | `DashboardCoordinador.jsx` |
| `administrativo` | `DashboardAdministrativo.jsx` |

Other frontend files: `FormularioMotivo.jsx` (shared triage/motive form), `HistorialEstudiante.jsx` (appointment history), `CrearUsuariosRapido.jsx` (bulk user creation tool), `src/utils/calendarUtils.js` (grid helpers), `src/config.js` (API_URL), `src/supabaseClient.js` (auth client).

### Backend routers
Each router guards its own role via `obtener_usuario_actual`. CORS is `allow_origins=["*"]` (all origins).

| Router | Prefix | Responsibility |
|--------|--------|----------------|
| `publico.py` | none | login helpers, public block/service listing |
| `estudiante.py` | none | reservar, cancelar, lista_espera, mis_reservas, ofertas |
| `profesional.py` | `/profesional` | attendance, clinical notes (evolución), block/service listing |
| `coordinador.py` | `/coordinador` + `/bloques` | block/service/user CRUD, critical case approval |
| `admin.py` | none (endpoints use `/admin/` prefix individually) | scheduling, triage, suspensions, waitlist management |
| `reportes.py` | `/reportes` | statistics |

### Endpoints reference

#### `publico.py`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/usuario_actual` | any | Returns current user role + IDs |
| POST | `/registro_estudiante` | estudiante | Complete student profile on first login |
| GET | `/servicios` | public | List all services |
| GET | `/disponibilidad` | public | Available blocks for a service (`?id_servicio=`) |
| GET | `/profesionales_activos` | prof_apoyo, coordinador, admin | List active professionals |
| GET | `/ubicaciones` | public | List campus/sedes (`?activo=true` to filter) |

#### `estudiante.py`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/reservar` | estudiante | Book block directly |
| GET | `/mis_reservas` | estudiante | Non-cancelled reservations |
| POST | `/cancelar` | estudiante, admin, profesional | Cancel reservation |
| POST | `/lista_espera` | estudiante | Enroll in waitlist with availability |
| GET | `/mis_esperas` | estudiante | My waitlist entries |
| PATCH | `/lista_espera/{id_lista}` | estudiante | Update availability for waitlist entry |
| DELETE | `/lista_espera/{id_lista}` | estudiante | Withdraw from waitlist |
| POST | `/responder_oferta` | estudiante | Accept/reject a waitlist offer |

#### `profesional.py`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/profesional/mis_servicios` | profesional | Services this professional offers |
| GET | `/profesional/bloques` | profesional | Own blocks with reservation info |
| POST | `/profesional/asistencia` | admin, profesional, coordinador | Mark attendance (presente/ausente/atraso) |
| GET | `/profesional/mis_atenciones` | profesional | Past blocks needing clinical notes |
| POST | `/profesional/evolucion` | profesional | Record clinical evolution note |

#### `coordinador.py`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/bloques` | coordinador | Create blocks (single or cyclic weekly series) |
| PATCH | `/bloques/{id_bloque}` | coordinador | Update block |
| DELETE | `/bloques/{id_bloque}` | coordinador | Delete block (`?eliminar_serie=true` deletes whole series) |
| POST | `/coordinador/ubicaciones` | coordinador | Create campus/sede |
| PUT | `/coordinador/ubicaciones/{id_ubicacion}` | coordinador | Update campus (`nombre`, `activo`) |
| DELETE | `/coordinador/ubicaciones/{id_ubicacion}` | coordinador | Delete campus (soft-delete `activo=false` if blocks reference it, else hard-delete) |
| POST | `/coordinador/crear_usuario` | coordinador | Create user (requires SERVICE_KEY) |
| GET | `/coordinador/profesionales` | coordinador | List professionals |
| POST | `/coordinador/servicios` | coordinador | Create service |
| PUT | `/coordinador/servicios/{id_servicio}` | coordinador | Update service |
| DELETE | `/coordinador/servicios/{id_servicio}` | coordinador | Delete service |
| PUT | `/coordinador/profesionales/{id_profesional}/servicios` | coordinador | Update professional's specialties |
| DELETE | `/coordinador/profesionales/{id_usuario}` | coordinador | Delete professional |
| GET | `/coordinador/profesionales/{id_profesional}/bloques` | coordinador | Professional's blocks |
| GET | `/coordinador/casos_criticos_pendientes` | coordinador | Critical cases awaiting approval |
| POST | `/coordinador/aprobar_critico/{id_estudiante}` | coordinador | Approve critical case |
| POST | `/coordinador/rechazar_critico/{id_estudiante}` | coordinador | Reject critical case |

#### `admin.py`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/lista_espera_admin` | admin | Pending-review waitlist entries |
| POST | `/asignar_hora_manual` | admin | Manually assign waitlist entry to block |
| GET | `/riesgo_suspension` | admin | Processes with ≥1 absence |
| POST | `/suspender_servicio` | admin | Suspend student from service (30 days) |
| PATCH | `/admin/reducir_inasistencia/{id_proceso}` | admin | Reduce absence count |
| POST | `/marcar_critico` | admin | Emergency protocol (closes all procesos) |
| POST | `/reagendar` | admin | Reschedule reservation to new block |
| POST | `/limpiar_ofertas_vencidas` | admin | Clean up expired waitlist offers |
| PATCH | `/admin/marcar_critico/{id_lista}` | admin | Mark waitlist entry as priority |
| GET | `/admin/estudiantes` | admin, profesional, coordinador | List students (profesional: only own patients) |
| GET | `/admin/demanda_espera` | admin | All waiting entries (demand view) |
| GET | `/admin/calendario_reservas` | admin, coordinador | Calendar of pending/present reservations |
| GET | `/admin/estudiantes/{id_estudiante}/reservas` | admin, profesional, coordinador | Student's full appointment history |
| POST | `/admin/cancelar_reserva` | admin, coordinador | Admin cancel reservation |
| POST | `/admin/agendar_hora` | admin, coordinador | Admin direct scheduling |
| GET | `/admin/triage` | admin | Unified triage view (lista_espera + proceso_clinico) |
| PATCH | `/admin/triage/{origen}/{id_item}/revisado` | admin | Mark triage item reviewed |
| PATCH | `/admin/triage/{origen}/{id_item}/critico` | admin | Escalate to coordinator (pending_coordinador) |
| GET | `/admin/casos_criticos` | admin | All active critical cases |

#### `reportes.py`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/reportes/ocupacion` | prof_apoyo, coordinador, admin | Occupancy stats (`?fecha_inicio&fecha_fin&id_servicio&id_profesional`) |
| GET | `/reportes/resumen_global` | prof_apoyo, coordinador, admin | Summary counts: active, waiting, critical |
| GET | `/reportes/ocupacion_semanal` | prof_apoyo, coordinador, admin | Occupancy % time-series grouped by ISO week (`?fecha_inicio&fecha_fin&id_servicio&id_profesional`). Returns `[{semana, inicio, total, ocupados, porcentaje}]` |
| GET | `/reportes/asistencias` | prof_apoyo, coordinador, admin | Attendance counts from `reserva.estado` (`?fecha_inicio&fecha_fin&id_servicio&id_profesional`). Returns `{presente, ausente, atraso}` |
| GET | `/reportes/distribucion_carreras` | prof_apoyo, coordinador, admin | Active patients (unique students) grouped by `estudiante.carrera` (`?id_servicio`). Returns `[{carrera, cantidad}]` |
| GET | `/reportes/reservas_detalle` | prof_apoyo, coordinador, admin | Reservation-level export DB: one row per `reserva` with full joined info (profesional, estudiante, asistencia, caso crítico, motivo, evolución clínica, derivación). All filters optional (`?fecha_inicio&fecha_fin&id_servicio&id_profesional`, filtered in Python over embedded `bloque_horario` — date range filters by **fecha de atención** = `bloque_horario.fecha_hora_inicio`). Also returns `fecha_creacion` (fecha de reserva), `registro_atencion` (Registrada / Sesión sin registrar / Pendiente (futura) / Cancelada — derived from `evolucion_clinica` presence + cita vs. now) and `derivacion_destino` (the `id_reserva_derivacion`, or "En lista de espera" if only `id_lista_derivacion`). `es_entrevista_ingreso` flags rows whose `motivo_consulta` is a triage questionnaire. |
| GET | `/reportes/lista_espera_detalle` | prof_apoyo, coordinador, admin | Waitlist export: one row per `lista_espera` entry (students awaiting an offer, no reserva yet). Filters optional (`?fecha_inicio&fecha_fin&id_servicio`; **no professional filter** — waitlist has no professional; dates filter `fecha_ingreso`). |

> The Profesional de Apoyo "Descargar Base de Reservas (Excel)" button (`DashboardProfesionalApoyo.jsx`, `exportarReservasExcel`) calls both `/reportes/reservas_detalle` and `/reportes/lista_espera_detalle`, then builds a multi-sheet `.xlsx` via SheetJS: **Reservas** (past/future/cancelled) + **Lista de Espera** + **Cuestionarios** (annex). Each Entrevista de Ingreso row (`es_entrevista_ingreso`) on either sheet gets an internal hyperlink to its full questionnaire in the Cuestionarios sheet.

### Key Pydantic schemas (`Backend_UBE/schemas.py`)
| Schema | Key Fields |
|--------|-----------|
| `SolicitudReserva` | `id_bloque`, `motivo_consulta`, `puntaje_triage` |
| `SolicitudListaEspera` | `id_servicio`, `disponibilidad_indicada`, `campus_indicados[]` (optional), `motivo_consulta`, `puntaje_triage` |
| `SolicitudActualizarDisponibilidad` | `disponibilidad_indicada` |
| `SolicitudAsistencia` | `id_reserva`, `estado` (presente/ausente/atraso) |
| `SolicitudEvolucion` | `id_reserva`, `observaciones`, `diagnostico`, `plan_tratamiento`, `derivaciones_detalles[]`, `id_servicios_derivacion[]` (legacy), `decision_continuidad` (continuar/cerrar_proceso), `es_caso_critico` |
| `SolicitudCrearUsuario` | `email`, `password`, `rol`, `nombres`, `apellidos`, `servicios`, `rut`, `carrera` |
| `SolicitudCrearBloque` | `id_profesional`, `id_servicio`, `es_ciclico`, `fechas_inicio`, `bloques_ciclicos[]`, `id_ubicacion` (optional) |
| `SolicitudAgendarHoraAdmin` | `id_estudiante`, `id_servicio`, `id_bloque`, `tipo_agendamiento` (prioritario/directo), `disponibilidad_indicada`, `campus_indicados[]` (optional), `motivo_consulta` |
| `SolicitudRespuestaOferta` | `id_lista`, `aceptada` (bool) |

### Core business logic (`Backend_UBE/services/asignacion.py`)

- **`_procesar_reserva_bloques(id_proceso, id_bloque_final)`** — creates `reserva` rows. For cyclic services, reserves the full weekly series up to `tope_sesiones`. First block → `confirmado`; rest → `reservado`. All reservas start as `pendiente`.
- **`_seleccionar_mejor_bloque(candidatos)`** — among multiple available blocks at the same day+time, picks the one whose professional has the lowest occupancy ratio (load balancing). The ratio counts **only future blocks** (`fecha_hora_inicio >= now`) and uses the same "occupied" definition as the reports (`estado not in ["disponible", "huerfano", "cancelado"]`) — so cancelled blocks no longer inflate a professional's apparent load. This matches the `/reportes/ocupacion` methodology.
- **`_attempt_automatic_assignment(id_bloque)`** — called when a block is freed (cancellation/admin deletion). Finds the highest-priority waitlisted student whose `disponibilidad_indicada` matches the block's day+time. Skips blocks within 12 hours. If student already has a pending reserva for the same service, cancels it (`cancelado_sistema_mejora`) and assigns the new block instead (upgrade logic). Recursively tries to fill any newly freed blocks.
- **`_attempt_automatic_assignment_for_student(id_lista)`** — called immediately when a student joins the waitlist. Searches available blocks matching their `disponibilidad_indicada`. Same upgrade logic applies.
- **`_tiene_conflicto_horario(id_estudiante, fecha_hora_inicio_iso)`** — checks whether a student already has any active (non-cancelled) reservation at the exact datetime across any service, to prevent double-booking.

### Waitlist availability format
`disponibilidad_indicada` is stored as `{ "dia": ["HH:MM", ...] }` — e.g., `{ "lunes": ["08:20", "08:40"] }`. The matching in `asignacion.py` does an exact string match on `hora_str = fecha_hora_inicio.strftime("%H:%M")`. For sub-hourly services (e.g., 20-min Medicina General), the frontend must store the exact slot start times, not just the hour.

### Waitlist offers system
When the system finds a match for a waitlisted student via `_attempt_automatic_assignment`, it can transition the `lista_espera` entry to an **ofertado** state and notify the student. The student then calls `POST /responder_oferta` with `aceptada: true/false`. Expired offers are cleaned by `POST /limpiar_ofertas_vencidas`.

### Email notifications (`services/notificaciones.py`)
Two trigger families email the student:
1. **Automatic waitlist assignment** — `_attempt_automatic_assignment` (block freed) or `_attempt_automatic_assignment_for_student` (student joins waitlist) call `notificar_asignacion_automatica(id_estudiante, id_bloque, es_reasignacion)`. `es_reasignacion=True` (existing pending reserva cancelled/upgraded to a better block) changes subject/wording.
2. **Any direct booking** — `notificar_reserva_directa(id_estudiante, id_bloque)` is called from the direct-reservation flows: `/reservar` and `/responder_oferta` (estudiante), `/asignar_hora_manual` and `/admin/agendar_hora` (admin), and both professional derivation branches in `/profesional/evolucion`. No double-send with the waitlist path because a direct booking deletes the student's `lista_espera` entry before any auto-assignment.

Both delegate to the shared helper `_notificar_reserva(id_estudiante, id_bloque, asunto, intro)` (DB joins → HTML/text build → `enviar_correo`). `asunto` may contain a `{servicio}` placeholder filled in by the helper. Everything is wrapped in try/except — a mail failure never breaks the booking/assignment.

`enviar_correo` posts to the **Brevo HTTP API** (`https://api.brevo.com/v3/smtp/email`, port 443) via `httpx.AsyncClient` — **not** SMTP, because Render blocks outbound SMTP ports (Gmail SMTP fails first with `[Errno 101] Network is unreachable` on IPv6, then `timed out` on IPv4). Needs `BREVO_API_KEY`; sender = `MAIL_FROM_EMAIL` (falls back to `GMAIL_USER`), name = `GMAIL_FROM_NAME`. The sender must be a **verified sender** in Brevo.

The student-email lookup chain is `estudiante.id_estudiante` → `estudiante.id_usuario` → `usuario.email`. Note `_seleccionar_mejor_bloque` may pick a *different* block than the one that triggered the search (the same-time slot from the least-loaded professional), so the reserva/email may reference that block instead. Sender account in production: `ubenotificaciones@gmail.com`.

**Status:** Migrated from Gmail SMTP to Brevo HTTP API (SMTP is unreachable from Render: `[Errno 101]`/`timed out`) and **verified working in production** — a real assignment delivered a live email via Brevo. `BREVO_API_KEY` is set in the **Render** dashboard (Environment tab) and the sender `ubenotificaciones@gmail.com` is verified in Brevo. Confirm via Render logs: `[notificaciones] Correo enviado a ...` (success) vs. `[notificaciones] Brevo respondió <code> ...` (API error, e.g. unverified sender) or `[notificaciones] BREVO_API_KEY no configurada...` (key missing). `GMAIL_APP_PASSWORD` is no longer used.

### Critical case and triage flow
1. **Admin** reviews triage queue (`GET /admin/triage`) — combines unreviewed `lista_espera` and `proceso_clinico` entries.
2. Admin can mark an item as reviewed or escalate it to `PATCH .../critico` → state becomes `pendiente_coordinador`.
3. **Coordinator** sees pending critical cases (`GET /coordinador/casos_criticos_pendientes`) and approves or rejects.
4. **Emergency protocol** (`POST /marcar_critico`): immediately closes all active `proceso_clinico` for a student, sets their `reserva` states to `cancelado_protocolo_critico`, sets blocks to `huerfano`, and flags `es_caso_critico_activo: true` on the student.

### Absence and suspension rules
- Cancelling with **<48 hours** notice → `cancelado_estudiante_tarde` state → increments `inasistencias_acumuladas` on `proceso_clinico`.
- `GET /riesgo_suspension` lists processes with ≥1 absence for admin review.
- `POST /suspender_servicio` suspends a student from a service for 30 days (written to `suspension_servicio` table). Suspended students are skipped during automatic assignment.

### Clinical derivations (`/profesional/evolucion`)
- New format: `derivaciones_detalles[]` — array of objects with target service + details.
- Legacy format: `id_servicios_derivacion[]` — array of service IDs.
- Each derivation creates a new `proceso_clinico` + `lista_espera` entry (or direct booking) for the student.
- The **primary** derivation (first one) records its result on the source `evolucion_clinica`: `id_reserva_derivacion` (if it became a direct booking) or `id_lista_derivacion` (if it went to the waitlist). These power the "ID Reserva Derivada" column in the reservation export. Both are nullable `uuid` columns (no FK); the write is wrapped in try/except so a missing migration doesn't break the flow.
- If `es_caso_critico: true`: triggers emergency protocol (closes all other procesos, flags student).
- If `decision_continuidad: "cerrar_proceso"`: closes the current `proceso_clinico`.

### Block/reservation states
`bloque_horario.estado`: `disponible` | `reservado` | `confirmado` | `huerfano` | `cancelado`

`reserva.estado`: `pendiente` | `presente` | `confirmado` | `reservado` | `cancelado_admin_suspension` | `cancelado_protocolo_critico` | `cancelado_estudiante` | `cancelado_profesional` | `cancelado_estudiante_tarde` | `cancelado_alta_medica` | `cancelado_sistema_mejora`

> **Important:** These values are enforced by PostgreSQL check constraints in Supabase. If a new state is needed, the constraint must be dropped and recreated manually in the Supabase SQL Editor — the Python code alone is not enough.

### Block series boundary (year-end) and Chilean holidays
Cyclic weekly block series (and the non-cyclic weekly-repeat in `crear_bloque`) **always run to Dec 31 of the starting block's year** — there is **no mid-year semester cut** anymore (it used to split Jan–Jun / Jul–Dec). The boundary variable is `fin_anio = datetime(year, 12, 31, 23, 59, 59)`, used in four places:
- `coordinador.py` `crear_bloque` (both the non-cyclic and cyclic branches).
- `services/asignacion.py` `_procesar_reserva_bloques` (cyclic series) and `_agendar_reposicion_ciclica` (replacement booking).

**Holiday skipping:** block *generation* in `coordinador.py` skips Chilean legal holidays via `from feriados_chile import es_feriado` — when a weekly iteration lands on a holiday it does `inicio_bloque += timedelta(weeks=1); continue` instead of creating a block. `Backend_UBE/feriados_chile.py` computes per-year holidays (`@lru_cache`): fixed dates, Easter-based (Good Friday/Holy Saturday via the Gauss algorithm), movable ones under Ley 19.668 (San Pedro y San Pablo, Encuentro de Dos Mundos) and Ley 20.299 (Iglesias Evangélicas), plus Día de los Pueblos Indígenas (`_PUEBLOS_INDIGENAS` per-year override, default Jun 20). The `asignacion.py` sites do **not** skip holidays — they only reserve pre-existing blocks, which can't fall on a holiday that was never created. UI strings in `DashboardCoordinador.jsx` say "hasta fin de año, omitiendo feriados".

### Ubicaciones / campus (block locations)
Blocks can be tagged with a physical campus/sede. `bloque_horario.id_ubicacion` is a **nullable** FK to the `ubicacion` table (null = "Sin ubicación", so legacy blocks still work). `lista_espera.campus_indicados` is a nullable `uuid[]` of campus the student accepts (null/empty = any campus). Both require SQL run in Supabase (see `feature-ubicaciones-campus` memory).

- **Coordinator** manages an `ubicacion` catalog (CRUD mirrors services) and assigns a campus per block when publishing availability.
- **Booking is campus-aware end-to-end:** `/reservar`, `/admin/agendar_hora` and professional derivation filter their `candidatos_req` by the chosen block's `id_ubicacion` (so `_seleccionar_mejor_bloque` load-balancing never moves the student to a different campus at the same time). Waitlist matching in `asignacion.py` skips blocks whose campus isn't in the student's `campus_indicados`.
- **Student booking (`AgendarHora.jsx`):** after picking a service, a "¿Qué campus te sirven?" multi-select chip filter (shown only when >1 campus has availability) narrows the grid. **The grid cell shows only "Disponible"** (not a campus name) — a single time slot may have blocks in several campus. Clicking a cell calls `abrirSeleccionSlot`, which groups that slot's blocks by campus (one representative each); if one campus it preselects it, if several the Paso 4 confirmation screen shows a "Selecciona el campus" picker and gates "Confirmar Cita" until one is chosen. (Bug history: the cell used `.find()` and silently reserved only the first campus, hiding the others — now it uses `.filter()`.)

### Frontend calendar utilities (`src/utils/calendarUtils.js`)
- `getLunes(d)` — returns Monday of the week containing `d`.
- `getBlocksForCell(blocks, fechaBase, diaIndex, hora)` — filters blocks for a grid cell by matching date and **hour prefix only** (`split(':')[0]`), so all sub-hourly blocks within an hour appear in the same row.
- `deduplicateCyclicBlocks(blocks, isCyclic)` — for cyclic services, collapses the weekly series to show only the first occurrence per (day, time, professional) combination.

### Sub-hourly service grids
**Every** booking/availability grid across the app follows the same pattern: 10 hourly rows (08:00–17:00), with sub-slot divs inside each cell computed from the service's `duracion_minutos`. Example for a 20-min service:
```js
const subSlots = [];
for (let m = startMin; m + duracionMin <= startMin + 60; m += duracionMin) {
  subSlots.push({ inicio: `${hh}:${mm}`, fin: `...` });
}
```
Grids using this pattern:
- Student booking (`AgendarHora.jsx` paso 2 "Selecciona tu hora") and waitlist enrollment (paso 3).
- Coordinator availability publication grid + priority grid (`DashboardCoordinador.jsx`).
- Admin booking grid + priority-availability grid (`DashboardAdministrativo.jsx`).
- Professional derivation grids (`DashboardProfesional.jsx`, calendario + lista modes).
- **Coordinator/admin "Calendario de Disponibilidad"** sub-view (see *Unified Demanda / Reservas tab* below) — read-only cupos count per sub-slot.

The available `duracion_minutos` is read per-service (`servicio.duracion_minutos`, `servicios.find(...)?.duracion_minutos`, etc.), falling back to `60`. **Critical:** availability grids must store the exact sub-slot start time (e.g. `"08:20"`) in `disponibilidad_indicada`, never the hour-level `"08:00"` — the backend matches by exact `strftime("%H:%M")`, so an hour-level time would never match a sub-hourly block.

### Responsive dashboard layout
The student (`Dashboard.jsx`) and admin (`DashboardAdministrativo.jsx`) dashboards use a mobile-friendly **top navbar + horizontal scrollable tabs** layout (matching `DashboardProfesional.jsx`) — not a fixed-width sidebar (a fixed 250px sidebar breaks on mobile, wrapping text letter-by-letter). Pattern:
- `<header style={{ backgroundColor: '#003366' }}>` with title + email (`hidden sm:inline`) + "Cerrar Sesión".
- A tab strip with `overflow-x-auto`, each tab `whitespace-nowrap flex-shrink-0`, via a `tabClass(v)` helper (admin's variant takes a `danger` flag for red "críticos" styling).
- `<main className="max-w-Nxl mx-auto p-4 md:p-6">` (student `max-w-5xl`, admin `max-w-6xl`).

### Unified "Demanda / Reservas" tab (coordinator + admin)
Both `DashboardCoordinador.jsx` (`pestañaActiva === 'demanda'`) and `DashboardAdministrativo.jsx` (`vista === 'demanda'`) host a **single tab** with three sub-views toggled by `subVistaDemanda` (`'demanda' | 'disponibilidad' | 'reservas'`, default `'demanda'`, styled via `subTabDemandaClass`). There is **no separate "Calendario Reservas" tab** anymore — it was folded in here. The tab label is **"Demanda / Reservas"**.

- **Calendario de Demanda** — heatmap of `lista_espera` demand per day+hour (count of waiting students; click → priority order). This *is* the waitlist view; the old standalone "Lista de Espera" table was removed. Data from `cargarDemanda()` (`/admin/demanda_espera`).
- **Calendario de Disponibilidad** — pick a service → grid of available `bloque_horario` cupos. **Sub-hourly:** each hour cell is split into sub-slots by the service's `duracion_minutos` (the standard sub-slot pattern), each sub-slot showing its cupos count; click → modal (`celdaSeleccionadaDisp`) lists the professionals + campus for that **exact** sub-slot (`hora: inicio`, not the hour). Data from `cargarDisponibilidadCalendario(idServicio)` → `GET /disponibilidad?id_servicio=` (no backend changes; reuses the public endpoint).
- **Calendario de Reservas** — heatmap of agendadas (`calendarioReservas`) per day+hour; click → `celdaSeleccionadaReservas` modal of citados. Data from `cargarCalendarioReservas()`.

Both `cargarDemanda()` and `cargarCalendarioReservas()` are fired together in the tab's `useEffect` when the tab opens.

### Key Supabase table relationships
```
usuario (id_usuario, email, rol)
  ├─ estudiante (id_usuario, rut, carrera, es_caso_critico_activo)
  │   ├─ lista_espera (id_estudiante, id_servicio, disponibilidad_indicada, campus_indicados uuid[] nullable, puntaje_triage, estado)
  │   └─ proceso_clinico (id_estudiante, id_servicio, estado, sesiones_realizadas, inasistencias_acumuladas)
  └─ profesional (id_usuario, id_servicio[])

ubicacion (id_ubicacion, nombre, activo)   ← campus/sede catalog (nullable on bloque)

servicio (id_servicio, nombre, es_ciclico, tope_sesiones, duracion_minutos)
  └─ bloque_horario (id_bloque, id_profesional, id_servicio, fecha_hora_inicio, estado, id_ubicacion nullable → ubicacion)
       └─ reserva (id_reserva, id_proceso, id_bloque, estado)

proceso_clinico
  ├─ reserva (id_proceso → 1 proceso, N reservas for cyclic)
  └─ evolucion_clinica (id_reserva, observaciones, diagnostico, plan_tratamiento, fecha_atencion, id_servicio_derivacion, id_reserva_derivacion, id_lista_derivacion)

suspension_servicio (id_estudiante, id_servicio, fecha_fin)
```

### `proceso_clinico` lifecycle
One `proceso_clinico` per (estudiante, servicio) while active. A student can re-book the same service if there is no current `pendiente` reserva. The `motivo_consulta` and `puntaje_triage` are updated on the existing proceso when re-booking. `estado` is `activo` until the professional closes it (via `cerrar_proceso` or session limit reached).

### Database clients (`Backend_UBE/database.py`)
Two Supabase client instances:
- `supabase` — uses `SERVICE_KEY` if available, else falls back to anon `SUPABASE_KEY`. Used for most operations.
- `supabase_admin` — uses `SERVICE_KEY` only (None if not configured). Required for `crear_usuario`.

## Deployment
- **Frontend:** Vercel — auto-deploys from `main` branch. Environment variables set in Vercel dashboard.
- **Backend:** Render — auto-deploys from `main` branch. Environment variables set in Render dashboard. Backend may sleep on inactivity (free tier). The email-notification vars (`BREVO_API_KEY`, optionally `MAIL_FROM_EMAIL`, `GMAIL_FROM_NAME`) must be added here for production email to work — saving them triggers an automatic redeploy. **Note:** Render blocks outbound SMTP ports, so email must go through an HTTP API (Brevo), not SMTP.
- Pushing to `main` triggers both deployments simultaneously.
