# TV Control

Navegador propio para Android TV que controlas desde el celular (PWA) o desde el PC (API).

```
Celular (PWA) ──┐                       ┌── TV (APK: WebView + cursor virtual)
PC (send.py) ───┼──►  server (Node) ◄───┘
                └── WebSocket / HTTPS, sin abrir puertos en casa
```

## 1. Servidor (Raspberry u otro equipo siempre encendido)

```bash
cd server
npm install
TOKEN=$(openssl rand -hex 16) node server.js     # guarda ese token
```

Para acceder desde cualquier parte (elige uno):
- **Tailscale** (en Raspberry, celular y TV): `tailscale serve --bg 8080` → URL `https://<equipo>.<tailnet>.ts.net`
- **Cloudflare Tunnel**: `cloudflared tunnel --url http://localhost:8080` (o un túnel con tu dominio)

La PWA solo se puede instalar si la URL es **https**.

## 2. App de la TV (APK)

1. Abre `tv-app/` en Android Studio.
2. Copia `local.properties.example` → `local.properties` y pon `server.url` y `server.token`.
3. Activa en la TV: Opciones de desarrollador → Depuración por red/USB.
4. `adb connect IP_TV:5555` y pulsa **Run**, o `./gradlew assembleDebug` e instala `app/build/outputs/apk/debug/app-debug.apk`.
5. Cambiar servidor/token sin recompilar:
   `adb shell am start -n com.miguel.tvremote/.MainActivity --es server https://... --es token XXXX`

## 3. Celular

Abre la URL del servidor en Chrome → menú → **Instalar app**. Pega el token la primera vez.
Con la PWA instalada, **Compartir → TV Control** desde cualquier app abre el enlace en la TV.

## 4. PC

```bash
export TV_SERVER=https://tu-url  TV_TOKEN=xxxx
python pc/send.py https://youtube.com/watch?v=...
python pc/send.py --cmd toggle        # play/pausa
python pc/send.py --cmd seek --value 60
```
O con curl: `curl -H "Authorization: Bearer $TV_TOKEN" -H "Content-Type: application/json" -d '{"url":"..."}' $TV_SERVER/api/open`

## Qué controla
Abrir URL, atrás/adelante/recargar/inicio, cursor + clic + scroll, teclado (texto, Enter, borrar), play/pausa, ±10/±60 s, barra de progreso, velocidad, silencio, volumen, pantalla completa, modo escritorio, biblioteca de clases, vista en vivo de la TV. El control físico de la TV también sirve (flechas = cursor, OK = clic, Atrás = volver).

## Límites conocidos
- **DRM** (Netflix, Disney+, etc.) no reproduce en un WebView.
- La vista en vivo puede verse **negra con video en pantalla completa**; el título y progreso siguen llegando.
- El control de video usa JavaScript sobre la página; dentro de **iframes** (p. ej. YouTube embebido) usa atajos de teclado como respaldo.
- El Kotlin no se ha compilado todavía: es el primer paso al abrirlo en Android Studio.
- El volumen puede no responder si la TV usa volumen fijo por HDMI-CEC.
