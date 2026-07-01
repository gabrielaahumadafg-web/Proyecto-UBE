import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // eslint-plugin-react-hooks v7 trae reglas nuevas muy estrictas que marcan
      // patrones que esta app usa de forma deliberada y que funcionan en produccion:
      //  - exhaustive-deps: dependencias de useEffect omitidas a proposito (cargar al
      //    cambiar de pestaña sin re-disparar por cambios de funciones/token).
      //  - set-state-in-effect: el patron "al entrar a la pestaña X, cargar sus datos".
      //  - immutability: useEffect que llama a una funcion declarada mas abajo (TDZ
      //    inofensivo: el efecto corre despues del render, la funcion ya existe).
      // Se desactivan para no refactorizar 6 dashboards estables. Reactivar si algun
      // dia se reescribe el fetching con useCallback + dependencias correctas.
      'react-hooks/exhaustive-deps': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/immutability': 'off',
      // FormularioMotivo exporta el helper buildMotivoFinal junto al componente; solo
      // afecta a Fast Refresh en dev, no al build de produccion.
      'react-refresh/only-export-components': 'off',
    },
  },
])
