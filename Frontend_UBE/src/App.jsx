import { useState, useEffect } from 'react'
import { API_URL } from './config';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { supabase } from './supabaseClient'
import Dashboard from './Dashboard'
import DashboardProfesional from './DashboardProfesional'
import DashboardAdministrativo from './DashboardAdministrativo'
import DashboardCoordinador from './DashboardCoordinador'
import DashboardProfesionalApoyo from './DashboardProfesionalApoyo'

function App() {
  const [session, setSession] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [rol, setRol] = useState(null)
  
  // Estados para el formulario de primer registro
  const [necesitaRegistro, setNecesitaRegistro] = useState(false)
  const [rut, setRut] = useState('')
  const [nombres, setNombres] = useState('')
  const [apellidos, setApellidos] = useState('')
  const [carrera, setCarrera] = useState('')

  // Estados para inicio de sesión manual (Coordinador/Admin/Pruebas)
  const [emailLogin, setEmailLogin] = useState('')
  const [passwordLogin, setPasswordLogin] = useState('')

  // Emails con excepción explícita: pueden entrar con Google aunque no sean @mail.pucv.cl/@pucv.cl
  // y no se registran como estudiante (deben existir previamente en la BD con su rol)
  const EMAILS_STAFF_EXCEPCION = ['gabriela.ahumada.fg@gmail.com'];

  const manejarSesion = async (sessionData) => {
    if (sessionData && sessionData.user) {
      const email = sessionData.user.email;
      const provider = sessionData.user.app_metadata?.provider;

      // Para login con Google, solo se permite @mail.pucv.cl, @pucv.cl, o excepciones explícitas
      if (provider === 'google') {
        if (!email.endsWith('@mail.pucv.cl') && !email.endsWith('@pucv.cl') && !EMAILS_STAFF_EXCEPCION.includes(email)) {
          await supabase.auth.signOut();
          alert("Acceso denegado. Solo se puede ingresar con Google usando un correo @mail.pucv.cl o @pucv.cl.");
          setSession(null);
          setCargando(false);
          return;
        }
      }

      // Solo @mail.pucv.cl normales (no excepciones de staff) pueden auto-registrarse como estudiante
      const puedeRegistrarseComoEstudiante =
        provider === 'google' &&
        email.endsWith('@mail.pucv.cl') &&
        !EMAILS_STAFF_EXCEPCION.includes(email);

      try {
        const respuesta = await fetch(`${API_URL}/usuario_actual`, {
          headers: { "Authorization": `Bearer ${sessionData.access_token}` }
        });

        if (respuesta.ok) {
          const datos = await respuesta.json();

          if (datos.rol === 'estudiante' && !datos.id_estudiante) {
            if (puedeRegistrarseComoEstudiante) {
              setNecesitaRegistro(true);
            } else {
              await supabase.auth.signOut();
              alert("No tienes un perfil activo en el sistema. Contacta a la coordinación.");
              setSession(null);
              setCargando(false);
              return;
            }
          } else {
            setRol(datos.rol);
            setNecesitaRegistro(false);
          }
        } else if (respuesta.status === 404) {
          if (puedeRegistrarseComoEstudiante) {
            setNecesitaRegistro(true);
          } else {
            await supabase.auth.signOut();
            alert("No tienes un perfil activo en el sistema. Contacta a la coordinación.");
            setSession(null);
            setCargando(false);
            return;
          }
        } else {
          setRol(null);
        }
      } catch (error) {
        console.error("Error validando usuario:", error);
        setRol(null);
      }
    } else {
      setRol(null);
      setNecesitaRegistro(false);
    }
    setSession(sessionData);
    setCargando(false);
  };

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => manejarSesion(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => manejarSesion(session));
    return () => subscription.unsubscribe()
  }, [])

  const iniciarSesionConGoogle = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin,
        queryParams: {
          prompt: 'select_account'
        }
      }
    })
    if (error) console.error("Error iniciando sesión:", error.message)
  }

  const iniciarSesionConPassword = async (e) => {
    e.preventDefault();
    setCargando(true);
    const { error } = await supabase.auth.signInWithPassword({
      email: emailLogin,
      password: passwordLogin,
    });
    if (error) {
      alert("Error iniciando sesión: " + error.message);
      setCargando(false);
    }
  };

  const registrarEstudiante = async (e) => {
    e.preventDefault();
    try {
      const respuesta = await fetch(`${API_URL}/registro_estudiante`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ rut, nombres, apellidos, carrera })
      });

      if (respuesta.ok) {
        alert("Perfil completado exitosamente.");
        setRol('estudiante');
        setNecesitaRegistro(false);
      } else {
        const data = await respuesta.json();
        alert("Error al registrar: " + data.detail);
      }
    } catch (error) {
      console.error("Error al registrar:", error);
      alert("Error de conexión al registrar.");
    }
  };

  if (cargando) return <div style={{ padding: '50px', textAlign: 'center' }}>Cargando sistema...</div>

  // Pantalla de Login si no hay sesión
  if (!session) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'sans-serif', backgroundColor: '#eef2f5' }}>
        <div style={{ padding: '50px', backgroundColor: 'white', borderRadius: '12px', boxShadow: '0 10px 25px rgba(0,0,0,0.1)', textAlign: 'center', maxWidth: '400px' }}>
          <h1 style={{ color: '#003366', marginBottom: '10px' }}>Unidad de Bienestar Estudiantil</h1>
          <p style={{ marginBottom: '30px', color: '#666', lineHeight: '1.5' }}>Inicia sesión de forma segura con tu correo institucional para acceder al portal.</p>
          <button onClick={iniciarSesionConGoogle} style={{ padding: '12px 24px', cursor: 'pointer', backgroundColor: '#4285F4', color: 'white', border: 'none', borderRadius: '5px', fontSize: '16px', fontWeight: 'bold', width: '100%' }}>
            Continuar con Google
          </button>

          <div style={{ marginTop: '20px', borderTop: '1px solid #eee', paddingTop: '20px' }}>
            <p style={{ fontSize: '14px', color: '#666', marginBottom: '10px' }}>Acceso Administrativo / Pruebas:</p>
            <form onSubmit={iniciarSesionConPassword} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <input type="email" placeholder="Correo electrónico" value={emailLogin} onChange={(e) => setEmailLogin(e.target.value)} required style={{ padding: '10px', borderRadius: '5px', border: '1px solid #ccc' }} />
              <input type="password" placeholder="Contraseña" value={passwordLogin} onChange={(e) => setPasswordLogin(e.target.value)} required style={{ padding: '10px', borderRadius: '5px', border: '1px solid #ccc' }} />
              <button type="submit" style={{ padding: '10px', cursor: 'pointer', backgroundColor: '#333', color: 'white', border: 'none', borderRadius: '5px', fontWeight: 'bold' }}>
                Ingresar
              </button>
            </form>
          </div>
        </div>
      </div>
    )
  }

  // Pantalla de Registro de Primer Ingreso
  if (necesitaRegistro) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', backgroundColor: '#f4f4f9', fontFamily: 'sans-serif' }}>
        <div style={{ backgroundColor: 'white', padding: '40px', borderRadius: '8px', boxShadow: '0 4px 10px rgba(0,0,0,0.1)', maxWidth: '400px', width: '100%' }}>
          <h2 style={{ color: '#003366', marginTop: 0 }}>Completa tu Perfil</h2>
          <p style={{ color: '#666', marginBottom: '20px' }}>Para agendar horas, necesitamos registrar tus datos como estudiante por primera vez.</p>
          
          <form onSubmit={registrarEstudiante} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
            <input type="text" placeholder="RUT (ej: 12345678-9)" value={rut} onChange={(e) => setRut(e.target.value)} required style={{ padding: '10px', borderRadius: '5px', border: '1px solid #ccc' }} />
            <input type="text" placeholder="Nombres" value={nombres} onChange={(e) => setNombres(e.target.value)} required style={{ padding: '10px', borderRadius: '5px', border: '1px solid #ccc' }} />
            <input type="text" placeholder="Apellidos" value={apellidos} onChange={(e) => setApellidos(e.target.value)} required style={{ padding: '10px', borderRadius: '5px', border: '1px solid #ccc' }} />
            <input type="text" placeholder="Carrera" value={carrera} onChange={(e) => setCarrera(e.target.value)} required style={{ padding: '10px', borderRadius: '5px', border: '1px solid #ccc' }} />
            
            <button type="submit" style={{ padding: '12px', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold' }}>
              Guardar y Continuar
            </button>
          </form>
          <button onClick={async () => await supabase.auth.signOut()} style={{ marginTop: '15px', padding: '10px', backgroundColor: 'transparent', color: '#cc0000', border: 'none', cursor: 'pointer', width: '100%' }}>
            Cancelar y cerrar sesión
          </button>
        </div>
      </div>
    );
  }

  // Renderizado dinámico del Dashboard según el rol
  const renderDashboard = () => {
    switch (rol) {
      case 'coordinador':
        return <DashboardCoordinador session={session} />
      case 'profesional':
        return <DashboardProfesional session={session} />
      case 'administrativo':
        return <DashboardAdministrativo session={session} />
      case 'profesional_apoyo':
        return <DashboardProfesionalApoyo session={session} />
      case 'estudiante':
      default:
        return <Dashboard session={session} />
    }
  }

  // Si hay sesión, inicializamos el Router y cargamos el Dashboard
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={renderDashboard()} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App