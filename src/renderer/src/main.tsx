import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist/wght.css'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(<App />)
