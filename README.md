# Android TV Remote Control

Un navegador propio para Android TV que se controla desde el celular, y que además permite manejar el resto de la TV: apps, volumen, encendido y lo que se esté viendo en pantalla.

Lo hice porque necesitaba ponerle a mi mamá sus clases en la TV desde mi celular, sin que ella tuviera que pelear con el control; empezó como un navegador sencillo y terminó siendo un control remoto completo, con pantalla en vivo y modo de escritorio remoto.

## Qué hace

- Abre cualquier enlace en la TV desde el celular, el PC o el menú "Compartir" de Android.
- Trackpad con cursor, clic y desplazamiento a dos dedos, pensado para usarse sobre una pantalla lisa y no como un control de botones.
- Control de video: reproducir, pausar, adelantar, atrasar, velocidad, volumen y pantalla completa; también con gestos sobre la imagen.
- Pantalla en vivo de lo que muestra la TV, y un modo de pantalla completa horizontal con tres formas de interactuar: cursor, toque directo y cruceta.
- Modo TV completa: controla cualquier app del dispositivo (Netflix, YouTube, ajustes, el inicio) por ADB, enciende y apaga la TV por HDMI-CEC, abre apps y escribe en cualquier buscador.
- Lista de enlaces guardados, ajustes sincronizados con la TV y apertura automática al encender.
- Vibración por niveles y animaciones en el celular; se puede desactivar.

## Cómo está armado

```
Celular (PWA) ──┐
PC (send.py) ───┼──►  Servidor Node  ◄──── App Android TV (WebView + cursor)
                │          │
                │          └──── ADB ────► Chromecast / Android TV (cualquier app)
```

- `server/`: servidor en Node.js con Express y WebSocket; sirve la PWA, hace de puente entre el celular y la TV, y controla el dispositivo por ADB.
- `server/public/`: la PWA que se usa como control desde el celular.
- `tv-app/`: la app para Android TV en Kotlin; es el navegador que se abre en la TV.
- `pc/send.py`: script para mandar enlaces o comandos desde el PC.

La TV y el celular se conectan hacia el servidor, así que no hace falta abrir puertos en el router.

## Requisitos

- Node.js 18 o superior.
- Android Studio, para compilar la app de la TV.
- Android SDK Platform Tools (`adb`); viene con Android Studio.
- Un dispositivo con Android TV o Google TV. Lo probé en un Chromecast con Google TV 4K con Android 14.
- El PC y la TV en la misma red Wi-Fi para la primera configuración.

## Instalación paso a paso

### 1. Clonar el repositorio

```
git clone https://github.com/MiguelAngelNieves/android-tv-remote-control.git
cd android-tv-remote-control
```

### 2. Levantar el servidor

```
cd server
npm install
```

En PowerShell:

```
$env:TOKEN='una-clave-de-al-menos-8-caracteres'
node server.js
```

En Linux o macOS:

```
TOKEN='una-clave-de-al-menos-8-caracteres' node server.js
```

Si todo va bien, la consola muestra `TV Remote server en :8080`. La clave es la que se va a pedir en el celular y la que lleva la app de la TV; conviene que no tenga el símbolo `$`, porque PowerShell lo interpreta como variable si se usan comillas dobles.

### 3. Activar la depuración en la TV

1. En la TV: Ajustes, Sistema, Información, y presionar siete veces "Compilación" hasta que aparezca el aviso de modo desarrollador.
2. Volver a Ajustes, Sistema, Opciones para desarrolladores, y activar **Depuración inalámbrica**.
3. Entrar a Depuración inalámbrica y elegir "Vincular dispositivo con código de vinculación"; la TV muestra un código y una IP con un puerto.
4. Desde el PC, con la ventana del código todavía abierta:

```
adb pair IP_DE_LA_TV:PUERTO_DE_VINCULACION
```

5. Cerrar la ventana del código, mirar la IP y el puerto que aparecen en la pantalla principal de Depuración inalámbrica (es otro puerto), y conectar:

```
adb connect IP_DE_LA_TV:PUERTO_DE_CONEXION
adb devices
```

La TV debe aparecer con el estado `device`. Si `adb` dice que hay más de un dispositivo, se agrega `-s IP:PUERTO` a cada comando.

### 4. Compilar e instalar la app de la TV

1. Abrir la carpeta `tv-app` en Android Studio con File, Open.
2. Si pregunta por la versión de Java para Gradle, elegir JVM 21.
3. Copiar `local.properties.example` como `local.properties` y poner la dirección del servidor y la misma clave:

```
server.url=http://IP_DEL_PC:8080
server.token=una-clave-de-al-menos-8-caracteres
```

4. File, Sync Project with Gradle Files.
5. Elegir la TV en el selector de dispositivos y presionar Run.

La app abre en la TV con un reloj y el estado de conexión.

### 5. Permisos que se dan una sola vez

Para que la app se abra sola al encender la TV:

```
adb shell appops set com.miguel.tvremote SYSTEM_ALERT_WINDOW allow
```

Para que la TV vuelva a activar la depuración inalámbrica después de reiniciarse, y así el servidor no pierda el control:

```
adb shell pm grant com.miguel.tvremote android.permission.WRITE_SECURE_SETTINGS
```

Ninguno de los dos muestra nada si sale bien.

### 6. Usarlo desde el celular

1. Con el celular en la misma red, abrir `http://IP_DEL_PC:8080` en Chrome.
2. Escribir la clave; el ojo permite verla mientras se escribe.
3. Si la URL es `https`, Chrome ofrece instalarla como app desde el menú, y aparece la opción "Compartir, TV Control" en cualquier aplicación.

### 7. Activar el modo TV completa

El servidor necesita saber dónde está `adb` y cuál es la IP de la TV; el puerto lo encuentra solo y se reconecta si cambia.

```
$env:TOKEN='una-clave-de-al-menos-8-caracteres'
$env:ADB_PATH='C:\ruta\al\Android\Sdk\platform-tools\adb.exe'
$env:TV_IP='192.168.1.66'
node server.js
```

En el celular, en la pestaña Mando, se cambia de NAVEGADOR a TV COMPLETA.

## Uso

**Mando.** Arriba está la pantalla en vivo; tocarla la abre en grande. En modo navegador el trackpad mueve el cursor, un toque hace clic y dos dedos desplazan la página. En modo TV completa el anillo funciona como la superficie táctil de un control moderno: deslizar mueve entre opciones, mantener el dedo desplazado repite como un joystick, y un toque es OK.

**Video.** Los gestos se hacen sobre la imagen: un toque pausa, deslizar a los lados atrasa o adelanta, deslizar arriba o abajo cambia el volumen, y un doble toque a un lado salta diez segundos.

**Pantalla completa.** Se gira el celular y la TV ocupa toda la pantalla. A la izquierda se elige cómo interactuar; abajo quedan atrás, inicio, reproducción, volumen y teclado.

**Lista.** Enlaces guardados para abrir con un toque, por ejemplo las clases de la semana.

**Ajustes.** Abrir al encender la TV, pantalla completa automática al reproducir, modo escritorio, tamaño y velocidad del cursor, sensibilidad de la cruceta y vibración.

## Desde el PC

```
$env:TV_SERVER='http://localhost:8080'
$env:TV_TOKEN='una-clave-de-al-menos-8-caracteres'
python pc/send.py https://www.youtube.com/watch?v=...
python pc/send.py --cmd toggle
python pc/send.py --cmd seek --value 60
```

También funciona con `curl` contra `/api/open` y `/api/cmd`, enviando la clave en el encabezado `Authorization: Bearer`.

## Limitaciones conocidas

- Netflix, Disney+ y otras plataformas con DRM no reproducen dentro del navegador; para eso está el modo TV completa, que abre y controla sus apps oficiales.
- En la pantalla en vivo, el contenido con DRM se ve en negro; el control sigue funcionando.
- La pantalla completa automática depende de cada página; en algunas el video está dentro de un iframe y se usa el atajo de teclado del reproductor.
- El volumen puede no responder si la TV tiene el volumen fijo por HDMI-CEC.
- `adb input text` no acepta tildes ni eñes; el servidor las reemplaza por la letra sin acento.

## Seguridad

El modo TV completa usa ADB, que da acceso total al dispositivo; el servidor debe quedar solo en la red de la casa o detrás de una VPN como Tailscale, nunca expuesto directamente a internet. La clave del servidor, `local.properties` y los datos de la lista están en `.gitignore` y no se suben al repositorio.

## Versiones

Cada versión tiene su etiqueta en git; `git tag` las lista y `git checkout v2.1`, por ejemplo, vuelve a una anterior.

- v1.0: navegador, cursor y control de video.
- v2.0: nueva interfaz, ajustes desde el celular y apertura al encender.
- v2.1: modo TV completa por ADB.
- v2.2: pantalla en vivo arriba, pantalla completa horizontal y trackpad fluido.

## Licencia

Este proyecto usa la licencia [PolyForm Noncommercial 1.0.0](LICENSE.md). Puedes usarlo, copiarlo y modificarlo libremente para fines personales, educativos o sin ánimo de lucro, siempre que conserves el aviso de autoría; no está permitido usarlo con fines comerciales sin mi autorización. Si quieres usarlo en algo comercial, escríbeme y lo hablamos.

Si lo usas o te basas en él, menciona el proyecto original:

```
Android TV Remote Control, por Miguel Ángel Nieves
https://github.com/MiguelAngelNieves/android-tv-remote-control
```

## Lo que sigue

- Mover el servidor a una Raspberry Pi para que esté siempre encendido.
- Acceso desde fuera de casa con Tailscale, con calidad de imagen adaptada a la conexión.
- Comandos por voz y dictado.
- Cambiar el motor del navegador a GeckoView para tener bloqueador de anuncios, pestañas e historial.
