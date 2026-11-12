import { createApp } from 'vue'
import '@xterm/xterm/css/xterm.css'
import './style.css'
import App from './App.vue'
import { applyTheme } from './deck'

applyTheme()

createApp(App).mount('#app')
