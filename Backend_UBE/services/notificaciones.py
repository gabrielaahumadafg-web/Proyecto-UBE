"""
Notificaciones por correo (Brevo HTTP API).

Render bloquea los puertos SMTP salientes (25/465/587), por lo que el envío vía
Gmail SMTP falla con timeout. Se usa la API HTTP de Brevo (puerto 443), que Render
sí permite. Configurar por variables de entorno:
  BREVO_API_KEY    -> API key de Brevo (empieza con "xkeysib-")
  MAIL_FROM_EMAIL  -> correo emisor verificado en Brevo
                      (opcional; por defecto usa GMAIL_USER)
  GMAIL_USER       -> fallback del correo emisor (ya configurado)
  GMAIL_FROM_NAME  -> nombre visible del emisor (opcional, default "UBE PUCV")

Si BREVO_API_KEY no está configurada, el envío se omite silenciosamente
(solo deja un log) para no romper el flujo de asignación.
"""
import os
from datetime import datetime, timedelta

import httpx

from database import supabase

BREVO_API_KEY = os.getenv("BREVO_API_KEY")
GMAIL_USER = os.getenv("GMAIL_USER")
MAIL_FROM_EMAIL = os.getenv("MAIL_FROM_EMAIL") or GMAIL_USER
GMAIL_FROM_NAME = os.getenv("GMAIL_FROM_NAME", "UBE PUCV")

_BREVO_URL = "https://api.brevo.com/v3/smtp/email"

_DIAS = {0: "lunes", 1: "martes", 2: "miércoles", 3: "jueves", 4: "viernes", 5: "sábado", 6: "domingo"}
_MESES = {1: "enero", 2: "febrero", 3: "marzo", 4: "abril", 5: "mayo", 6: "junio",
          7: "julio", 8: "agosto", 9: "septiembre", 10: "octubre", 11: "noviembre", 12: "diciembre"}


async def enviar_correo(destinatario: str, asunto: str, cuerpo_html: str, cuerpo_texto: str = ""):
    """Envía un correo vía la API HTTP de Brevo. Nunca lanza: si falla, solo loguea."""
    if not destinatario:
        return
    if not BREVO_API_KEY:
        print("[notificaciones] BREVO_API_KEY no configurada; se omite el envío.")
        return
    if not MAIL_FROM_EMAIL:
        print("[notificaciones] Sin correo emisor (MAIL_FROM_EMAIL/GMAIL_USER); se omite el envío.")
        return
    payload = {
        "sender": {"name": GMAIL_FROM_NAME, "email": MAIL_FROM_EMAIL},
        "to": [{"email": destinatario}],
        "subject": asunto,
        "htmlContent": cuerpo_html,
        "textContent": cuerpo_texto or " ",
    }
    headers = {
        "api-key": BREVO_API_KEY,
        "accept": "application/json",
        "content-type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(_BREVO_URL, json=payload, headers=headers)
        if resp.status_code in (200, 201, 202):
            print(f"[notificaciones] Correo enviado a {destinatario}: {asunto}")
            return
        print(f"[notificaciones] Brevo respondió {resp.status_code} al enviar a {destinatario}: {resp.text}")
        return  # evita caer al except genérico que reimprime
    except Exception as e:
        print(f"[notificaciones] Error enviando correo a {destinatario}: {e}")


def _formatear_fecha(fh_iso: str) -> str:
    try:
        dt = datetime.fromisoformat(fh_iso.replace("Z", "").replace(" ", "T")[:19])
        return f"{_DIAS[dt.weekday()]} {dt.day} de {_MESES[dt.month]} de {dt.year}, {dt.strftime('%H:%M')} hrs"
    except Exception:
        return fh_iso or ""


async def _notificar_reserva(id_estudiante: str, id_bloque: str, asunto: str, intro: str):
    """
    Helper común: reúne los datos del bloque, servicio, profesional y correo del
    estudiante, arma el correo (HTML + texto) con el asunto/intro indicados y lo envía.
    Envuelta en try/except: jamás interrumpe el flujo que la invoca.
    """
    try:
        bloque_req = supabase.table("bloque_horario").select(
            "fecha_hora_inicio, servicio(nombre), profesional(nombres, apellidos), ubicacion(nombre, direccion)"
        ).eq("id_bloque", id_bloque).execute()
        if not bloque_req.data:
            return
        b = bloque_req.data[0]

        est_req = supabase.table("estudiante").select("nombres, id_usuario").eq("id_estudiante", id_estudiante).execute()
        if not est_req.data:
            return
        est = est_req.data[0]

        usu_req = supabase.table("usuario").select("email").eq("id_usuario", est["id_usuario"]).execute()
        if not usu_req.data or not usu_req.data[0].get("email"):
            return
        email = usu_req.data[0]["email"]

        servicio = (b.get("servicio") or {}).get("nombre") or "Atención"
        prof = b.get("profesional") or {}
        prof_nombre = f"{prof.get('nombres', '') or ''} {prof.get('apellidos', '') or ''}".strip() or "el/la profesional asignado/a"
        fecha_txt = _formatear_fecha(b.get("fecha_hora_inicio"))
        ubic = b.get("ubicacion") or {}
        campus = ubic.get("nombre")
        direccion = ubic.get("direccion")
        nombre = est.get("nombres") or "estudiante"

        asunto = asunto.format(servicio=servicio)

        fila_campus_html = (
            f'<tr><td style="padding:6px 0; color:#6b7280;">Campus / Sede</td>'
            f'<td style="padding:6px 0;"><strong>{campus}</strong></td></tr>'
            if campus else ""
        )
        fila_direccion_html = (
            f'<tr><td style="padding:6px 0; color:#6b7280;">Dirección</td>'
            f'<td style="padding:6px 0;"><strong>{direccion}</strong></td></tr>'
            if direccion else ""
        )
        linea_campus_texto = f"Campus / Sede: {campus}\n" if campus else ""
        linea_direccion_texto = f"Dirección: {direccion}\n" if direccion else ""

        html = f"""\
<div style="font-family: Arial, sans-serif; color: #1f2937; max-width: 560px; margin: 0 auto;">
  <div style="background:#003366; color:#fff; padding:16px 20px; border-radius:8px 8px 0 0;">
    <h2 style="margin:0; font-size:18px;">Unidad de Bienestar Estudiantil · PUCV</h2>
  </div>
  <div style="border:1px solid #e5e7eb; border-top:none; padding:20px; border-radius:0 0 8px 8px;">
    <p>Hola <strong>{nombre}</strong>,</p>
    <p>{intro}</p>
    <table style="width:100%; border-collapse:collapse; margin:16px 0;">
      <tr><td style="padding:6px 0; color:#6b7280;">Servicio</td><td style="padding:6px 0;"><strong>{servicio}</strong></td></tr>
      <tr><td style="padding:6px 0; color:#6b7280;">Fecha y hora</td><td style="padding:6px 0;"><strong>{fecha_txt}</strong></td></tr>
      <tr><td style="padding:6px 0; color:#6b7280;">Profesional</td><td style="padding:6px 0;"><strong>{prof_nombre}</strong></td></tr>
      {fila_campus_html}
      {fila_direccion_html}
    </table>
    <p>Puedes revisar el detalle e historial de tus horas en la plataforma de la UBE.</p>
    <p style="color:#b91c1c;"><strong>Importante:</strong> si no puedes asistir, cancela con al menos 48 horas de anticipación para evitar registrar una inasistencia.</p>
    <p style="color:#6b7280; font-size:12px; margin-top:20px;">Este es un correo automático, por favor no respondas a este mensaje.</p>
  </div>
</div>"""

        texto = (
            f"Hola {nombre},\n\n{intro}\n\n"
            f"Servicio: {servicio}\n"
            f"Fecha y hora: {fecha_txt}\n"
            f"Profesional: {prof_nombre}\n"
            f"{linea_campus_texto}"
            f"{linea_direccion_texto}\n"
            "Revisa el detalle en la plataforma de la UBE.\n"
            "Importante: si no puedes asistir, cancela con al menos 48 horas de anticipación.\n\n"
            "Este es un correo automático, por favor no respondas a este mensaje."
        )

        await enviar_correo(email, asunto, html, texto)
    except Exception as e:
        print(f"[notificaciones] Error preparando notificación de reserva: {e}")


async def notificar_asignacion_automatica(id_estudiante: str, id_bloque: str, es_reasignacion: bool = False):
    """
    Notifica al estudiante que el sistema le asignó automáticamente una hora
    (desde lista de espera) o que se la reprogramó a un mejor horario.
    """
    if es_reasignacion:
        asunto = "Tu hora de {servicio} fue reprogramada"
        intro = ("El sistema encontró un horario que se ajusta mejor a tu disponibilidad y "
                 "reprogramó tu hora automáticamente.")
    else:
        asunto = "Se te asignó una hora de {servicio}"
        intro = ("Estabas en la lista de espera y el sistema te asignó automáticamente una hora "
                 "que coincide con tu disponibilidad.")
    await _notificar_reserva(id_estudiante, id_bloque, asunto, intro)


async def notificar_reserva_directa(id_estudiante: str, id_bloque: str):
    """
    Notifica al estudiante que se le agendó/confirmó una hora directamente (reserva
    propia, agendamiento por administración/coordinación, derivación o aceptación de
    oferta), no proveniente de una asignación automática desde la lista de espera.
    """
    asunto = "Tu hora de {servicio} quedó agendada"
    intro = "Se agendó una hora de atención a tu nombre con los siguientes datos:"
    await _notificar_reserva(id_estudiante, id_bloque, asunto, intro)


def _email_y_nombre(id_estudiante: str):
    """Devuelve (email, nombre) del estudiante o (None, nombre/None) si falta el correo."""
    est_req = supabase.table("estudiante").select("nombres, id_usuario").eq("id_estudiante", id_estudiante).execute()
    if not est_req.data:
        return None, None
    est = est_req.data[0]
    usu_req = supabase.table("usuario").select("email").eq("id_usuario", est["id_usuario"]).execute()
    email = usu_req.data[0].get("email") if usu_req.data else None
    return email, (est.get("nombres") or "estudiante")


def _nombre_servicio(id_servicio: str) -> str:
    try:
        r = supabase.table("servicio").select("nombre").eq("id_servicio", id_servicio).execute()
        return (r.data[0]["nombre"] if r.data else None) or "el servicio"
    except Exception:
        return "el servicio"


def _shell_html(nombre: str, parrafos: list, barra: str = "#003366", nota: str = "") -> str:
    cuerpo = "".join(f'<p>{p}</p>' for p in parrafos)
    nota_html = f'<p style="color:#b91c1c;"><strong>Importante:</strong> {nota}</p>' if nota else ""
    return f"""\
<div style="font-family: Arial, sans-serif; color: #1f2937; max-width: 560px; margin: 0 auto;">
  <div style="background:{barra}; color:#fff; padding:16px 20px; border-radius:8px 8px 0 0;">
    <h2 style="margin:0; font-size:18px;">Unidad de Bienestar Estudiantil · PUCV</h2>
  </div>
  <div style="border:1px solid #e5e7eb; border-top:none; padding:20px; border-radius:0 0 8px 8px;">
    <p>Hola <strong>{nombre}</strong>,</p>
    {cuerpo}
    {nota_html}
    <p style="color:#6b7280; font-size:12px; margin-top:20px;">Este es un correo automático, por favor no respondas a este mensaje.</p>
  </div>
</div>"""


async def notificar_inasistencia_registrada(id_estudiante: str, id_servicio: str,
                                            tipo: str = "no_show", fecha_bloque_iso: str = None):
    """Avisa al estudiante que se le registró una inasistencia y que puede justificarla."""
    try:
        email, nombre = _email_y_nombre(id_estudiante)
        if not email:
            return
        servicio = _nombre_servicio(id_servicio)
        tipo_txt = {
            "cancelacion_tardia": "cancelación con menos de 48 horas de anticipación",
            "atraso": "atraso",
        }.get(tipo, "no presentarse a la cita")

        ahora = datetime.utcnow()
        fb = ahora
        if fecha_bloque_iso:
            try:
                fb = datetime.fromisoformat(fecha_bloque_iso.replace("Z", "").replace(" ", "T")[:19])
            except ValueError:
                fb = ahora
        limite = max(fb + timedelta(days=3), ahora + timedelta(days=2))
        limite_txt = _formatear_fecha(limite.isoformat())

        asunto = f"Se registró una inasistencia en {servicio}"
        parrafos = [
            f"Se registró una <strong>inasistencia</strong> en tu proceso de <strong>{servicio}</strong> por {tipo_txt}.",
            f"Si tuviste un motivo válido, puedes <strong>justificarla</strong> en la plataforma de la UBE, en la pestaña "
            f"<strong>«Mis Inasistencias»</strong>, antes del <strong>{limite_txt}</strong>.",
            "Si no la justificas dentro del plazo, o si la administración la rechaza, contará como una <strong>falta</strong>. "
            "Acumular 2 faltas puede derivar en la suspensión del servicio.",
        ]
        html = _shell_html(nombre, parrafos, barra="#92400e",
                           nota="Ingresa a la plataforma para justificar tu inasistencia a tiempo.")
        texto = (
            f"Hola {nombre},\n\n"
            f"Se registró una inasistencia en tu proceso de {servicio} por {tipo_txt}.\n"
            f"Puedes justificarla en la plataforma (pestaña 'Mis Inasistencias') antes del {limite_txt}.\n"
            "Si no la justificas a tiempo o se rechaza, contará como falta. Dos faltas pueden derivar en suspensión.\n\n"
            "Este es un correo automático, por favor no respondas a este mensaje."
        )
        await enviar_correo(email, asunto, html, texto)
    except Exception as e:
        print(f"[notificaciones] Error notificando inasistencia: {e}")


async def notificar_resolucion_justificacion(id_estudiante: str, id_servicio: str, aprobada: bool):
    """Avisa al estudiante el resultado de la revisión de su justificación."""
    try:
        email, nombre = _email_y_nombre(id_estudiante)
        if not email:
            return
        servicio = _nombre_servicio(id_servicio)
        if aprobada:
            asunto = f"Tu justificación de {servicio} fue aprobada"
            parrafos = [
                f"Tu justificación de la inasistencia en <strong>{servicio}</strong> fue <strong>aprobada</strong>.",
                "No se registrará como falta. Si tu servicio es un tratamiento continuo (cíclico), se agendó "
                "automáticamente una sesión de reposición; revisa tus horas en la plataforma.",
            ]
            html = _shell_html(nombre, parrafos, barra="#166534")
            texto = (f"Hola {nombre},\n\nTu justificación de la inasistencia en {servicio} fue APROBADA. "
                     "No contará como falta y, si el servicio es cíclico, se agendó una reposición.\n\n"
                     "Este es un correo automático, por favor no respondas a este mensaje.")
        else:
            asunto = f"Tu justificación de {servicio} fue rechazada"
            parrafos = [
                f"Tu justificación de la inasistencia en <strong>{servicio}</strong> fue <strong>rechazada</strong>.",
                "La inasistencia se registró como una <strong>falta</strong>. Recuerda que acumular 2 faltas puede "
                "derivar en la suspensión del servicio.",
            ]
            html = _shell_html(nombre, parrafos, barra="#b91c1c")
            texto = (f"Hola {nombre},\n\nTu justificación de la inasistencia en {servicio} fue RECHAZADA. "
                     "Se registró como falta. Dos faltas pueden derivar en suspensión.\n\n"
                     "Este es un correo automático, por favor no respondas a este mensaje.")
        await enviar_correo(email, asunto, html, texto)
    except Exception as e:
        print(f"[notificaciones] Error notificando resolución de justificación: {e}")


async def notificar_suspension(id_estudiante: str, id_servicio: str, fecha_fin_iso: str = None):
    """Avisa al estudiante que fue suspendido de un servicio."""
    try:
        email, nombre = _email_y_nombre(id_estudiante)
        if not email:
            return
        servicio = _nombre_servicio(id_servicio)
        fin_txt = _formatear_fecha(fecha_fin_iso) if fecha_fin_iso else "30 días"
        asunto = f"Suspensión del servicio {servicio}"
        parrafos = [
            f"Se ha aplicado una <strong>suspensión</strong> en el servicio <strong>{servicio}</strong> debido a "
            "faltas acumuladas.",
            "Tus horas futuras de este servicio fueron canceladas y liberadas para otros estudiantes.",
            f"No podrás volver a agendar este servicio hasta el <strong>{fin_txt}</strong>.",
            "Si crees que esto es un error o tienes antecedentes que aportar, comunícate con la Unidad de Bienestar Estudiantil.",
        ]
        html = _shell_html(nombre, parrafos, barra="#b91c1c")
        texto = (f"Hola {nombre},\n\nSe aplicó una suspensión en el servicio {servicio} por faltas acumuladas. "
                 f"Tus horas futuras fueron canceladas y no podrás agendar este servicio hasta el {fin_txt}.\n"
                 "Si crees que es un error, comunícate con la UBE.\n\n"
                 "Este es un correo automático, por favor no respondas a este mensaje.")
        await enviar_correo(email, asunto, html, texto)
    except Exception as e:
        print(f"[notificaciones] Error notificando suspensión: {e}")
