import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist/wght.css'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { App } from './App'
import { applyTheme } from './appearance'
import { getTheme } from '../../shared/themes'

applyTheme(getTheme(window.api.initialThemeId))
createRoot(document.getElementById('root')!).render(<App />)
