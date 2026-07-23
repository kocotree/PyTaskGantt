import { createApp } from 'vue'
import 'vfonts/Lato.css'
import 'vfonts/FiraCode.css'
import 'vis-timeline/styles/vis-timeline-graph2d.css'
import './style.css'
import App from './App.vue'
import router from './router.js'

const app = createApp(App)
app.use(router)
app.mount('#app')
