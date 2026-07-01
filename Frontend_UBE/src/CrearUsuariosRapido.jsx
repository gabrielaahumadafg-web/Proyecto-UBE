import { useState, useEffect } from 'react';
import { API_URL } from './config';

export default function CrearUsuariosRapido({ session }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rol, setRol] = useState('estudiante');
  const [nombres, setNombres] = useState('');
  const [apellidos, setApellidos] = useState('');
  const [carrera, setCarrera] = useState('');
  const [servicios, setServicios] = useState([]);
  const [serviciosDisponibles, setServiciosDisponibles] = useState([]);
  const [cargando, setCargando] = useState(false);

  useEffect(() => {
    cargarServicios();
  }, []);

  const cargarServicios = async () => {
    try {
      const respuesta = await fetch(`${API_URL}/servicios`);
      if (respuesta.ok) {
        const datos = await respuesta.json();
        setServiciosDisponibles(datos);
      }
    } catch (error) {
      console.error("Error cargando servicios:", error);
    }
  };

  const handleCheckboxChange = (id_servicio) => {
    if (servicios.includes(id_servicio)) {
      setServicios(servicios.filter(s => s !== id_servicio));
    } else {
      setServicios([...servicios, id_servicio]);
    }
  };

  const registrarUsuario = async (e) => {
    e.preventDefault();
    setCargando(true);
    try {
      const payload = { email, password, rol, nombres, apellidos };
      
      if (rol === 'estudiante') {
        // Generamos un RUT falso aleatorio para evitar problemas de duplicidad (Ej: 19482910-3)
        payload.rut = `${Math.floor(Math.random() * 20000000) + 10000000}-${Math.floor(Math.random() * 10)}`;
        payload.carrera = carrera;
      } else if (rol === 'profesional') {
        payload.servicios = servicios;
      }

      const respuesta = await fetch(`${API_URL}/coordinador/crear_usuario`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`
        },
        body: JSON.stringify(payload)
      });

      if (respuesta.ok) {
        alert("Usuario creado exitosamente. Puedes cerrar sesión y entrar con él usando el acceso de pruebas.");
        setEmail(''); setPassword(''); setNombres(''); setApellidos(''); setCarrera(''); setServicios([]);
      } else {
        const data = await respuesta.json();
        alert("Error al registrar: " + data.detail);
      }
    } catch (error) {
      console.error("Error al registrar:", error);
      alert("Error de conexión al registrar.");
    } finally {
      setCargando(false);
    }
  };

  return (
    <div style={{ padding: '20px', backgroundColor: 'white', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)', maxWidth: '500px' }}>
      <h2 style={{ color: '#003366', marginTop: 0 }}>Creación Rápida de Usuarios (Pruebas / Admin)</h2>
      <p style={{ color: '#666' }}>Crea cuentas para saltar la validación de Google.</p>
      
      <form onSubmit={registrarUsuario} style={{ display: 'flex', flexDirection: 'column', gap: '15px', marginTop: '20px' }}>
        <select value={rol} onChange={(e) => setRol(e.target.value)} required style={{ padding: '10px', borderRadius: '5px', border: '1px solid #ccc' }}>
          <option value="estudiante">Estudiante</option>
          <option value="profesional">Profesional</option>
          <option value="administrativo">Administrativo</option>
          <option value="profesional_apoyo">Profesional de Apoyo</option>
        </select>
        <input type="email" placeholder="Correo (ej: est1@test.com)" value={email} onChange={(e) => setEmail(e.target.value)} required style={{ padding: '10px', borderRadius: '5px', border: '1px solid #ccc' }} />
        <input type="text" placeholder="Contraseña (mínimo 6 caracteres)" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} style={{ padding: '10px', borderRadius: '5px', border: '1px solid #ccc' }} />
        <input type="text" placeholder="Nombres" value={nombres} onChange={(e) => setNombres(e.target.value)} required style={{ padding: '10px', borderRadius: '5px', border: '1px solid #ccc' }} />
        <input type="text" placeholder="Apellidos" value={apellidos} onChange={(e) => setApellidos(e.target.value)} required style={{ padding: '10px', borderRadius: '5px', border: '1px solid #ccc' }} />
        {rol === 'estudiante' && (<input type="text" placeholder="Carrera" value={carrera} onChange={(e) => setCarrera(e.target.value)} required style={{ padding: '10px', borderRadius: '5px', border: '1px solid #ccc' }} />)}
        {rol === 'profesional' && (<div style={{ border: '1px solid #ccc', padding: '10px', borderRadius: '5px' }}><p style={{ margin: '0 0 10px 0', fontSize: '14px', color: '#666' }}>Servicios:</p>{serviciosDisponibles.map(srv => (<label key={srv.id_servicio} style={{ display: 'block', marginBottom: '5px', fontSize: '14px' }}><input type="checkbox" checked={servicios.includes(srv.id_servicio)} onChange={() => handleCheckboxChange(srv.id_servicio)} style={{ marginRight: '8px' }}/>{srv.nombre}</label>))}</div>)}
        <button type="submit" disabled={cargando} style={{ padding: '12px', backgroundColor: cargando ? '#ccc' : '#003366', color: 'white', border: 'none', borderRadius: '5px', cursor: cargando ? 'not-allowed' : 'pointer', fontWeight: 'bold' }}>
          {cargando ? 'Creando...' : 'Crear Usuario'}
        </button>
      </form>
    </div>
  );
}