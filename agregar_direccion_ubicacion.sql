-- Migración: agregar dirección física a las ubicaciones (campus/sedes).
-- La dirección NO se muestra en la app; solo aparece en el correo de confirmación
-- de la cita. Ejecutar UNA vez en el SQL Editor de Supabase.

-- 1) Columna nueva (nullable; legacy sigue funcionando)
ALTER TABLE public.ubicacion
  ADD COLUMN IF NOT EXISTS direccion text;

-- 2) Direcciones de las sedes existentes
UPDATE public.ubicacion SET direccion = 'Avenida Brasil N.º 2950' WHERE nombre = 'Casa Central';
UPDATE public.ubicacion SET direccion = 'Av. Brasil 2241'         WHERE nombre = 'IBC';
UPDATE public.ubicacion SET direccion = 'Avenida Universidad 330' WHERE nombre = 'Curauma';
UPDATE public.ubicacion SET direccion = 'Online'                  WHERE nombre = 'Online';
