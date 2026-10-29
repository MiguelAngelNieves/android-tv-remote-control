package com.miguel.tvremote

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.media.AudioManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max
import kotlin.math.min

class MainActivity : Activity() {

    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private lateinit var cursor: CursorView
    private var customView: View? = null
    private var customCb: WebChromeClient.CustomViewCallback? = null

    private val ui = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val http = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private var ws: WebSocket? = null
    private var connected = false
    private var retry = 0
    private var watching = false
    private var tick = 0
    private val frameBusy = AtomicBoolean(false)
    private var desktopUa = true

    private val desktopUserAgent =
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

    // ---------- Ciclo de vida ----------

    @SuppressLint("SetJavaScriptEnabled", "ClickableViewAccessibility")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        applyConfigExtras(intent)

        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        web = WebView(this)
        cursor = CursorView(this)
        root.addView(web, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        root.addView(cursor, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        setContentView(root)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            loadWithOverviewMode = true
            useWideViewPort = true
            setSupportMultipleWindows(false)
            userAgentString = desktopUserAgent
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(web, true)
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val s = request.url.scheme ?: return true
                return !(s == "http" || s == "https")   // ignora intent://, market://, etc.
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (customView != null) { callback.onCustomViewHidden(); return }
                customView = view; customCb = callback
                web.visibility = View.INVISIBLE
                root.addView(view, root.indexOfChild(cursor), ViewGroup.LayoutParams(-1, -1))
            }
            override fun onHideCustomView() { hideCustomView() }
        }
        web.requestFocus()

        root.post { cursor.moveTo(root.width / 2f, root.height / 2f) }
        web.loadUrl(intent?.dataString ?: homeUrl())

        connect()
        ui.postDelayed(loop, 1000)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        applyConfigExtras(intent)
        intent.dataString?.let { openUrl(it) }
    }

    override fun onResume() {
        super.onResume()
        hideSystemUi()
        web.onResume()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemUi()
    }

    override fun onDestroy() {
        ui.removeCallbacksAndMessages(null)
        ws?.cancel()
        io.shutdownNow()
        web.destroy()
        super.onDestroy()
    }

    @Suppress("DEPRECATION")
    private fun hideSystemUi() {
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION)
    }

    // ---------- Configuración ----------
    // Valores de compilación (local.properties), sobreescribibles por adb:
    // adb shell am start -n com.miguel.tvremote/.MainActivity --es server https://... --es token XXXX

    private fun cfg(key: String, def: String) =
        getSharedPreferences("cfg", Context.MODE_PRIVATE).getString(key, null) ?: def

    private fun applyConfigExtras(i: Intent?) {
        val server = i?.getStringExtra("server")
        val token = i?.getStringExtra("token")
        if (server == null && token == null) return
        getSharedPreferences("cfg", Context.MODE_PRIVATE).edit().apply {
            server?.let { putString("server", it) }
            token?.let { putString("token", it) }
        }.apply()
        if (::web.isInitialized) { ws?.cancel() }
    }

    private fun serverBase() = cfg("server", BuildConfig.SERVER_URL).trimEnd('/')
    private fun homeUrl() = serverBase() + "/tv.html"

    // ---------- WebSocket ----------

    private fun connect() {
        val token = cfg("token", BuildConfig.TOKEN)
        val wsUrl = serverBase().replaceFirst("http", "ws") + "/ws?role=tv&token=" + Uri.encode(token)
        val req = try { Request.Builder().url(wsUrl).build() } catch (e: Exception) { scheduleReconnect(); return }
        ws = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                ui.post { if (webSocket === ws) { connected = true; retry = 0 } }
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                ui.post {
                    if (webSocket !== ws) return@post
                    try { handle(JSONObject(text)) } catch (_: Exception) { }
                }
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = lost(webSocket)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = lost(webSocket)
        })
    }

    private fun lost(socket: WebSocket) {
        ui.post {
            if (socket !== ws) return@post
            connected = false; watching = false
            scheduleReconnect()
        }
    }

    private fun scheduleReconnect() {
        val delay = min(1000L shl min(retry, 5), 30000L)
        retry++
        ui.postDelayed({ connect() }, delay)
    }

    // ---------- Comandos ----------

    private fun handle(m: JSONObject) {
        when (m.optString("type")) {
            "open" -> openUrl(m.optString("url"))
            "nav" -> when (m.optString("action")) {
                "back" -> if (customView != null) hideCustomView() else if (web.canGoBack()) web.goBack()
                "forward" -> if (web.canGoForward()) web.goForward()
                "reload" -> web.reload()
                "home" -> web.loadUrl(homeUrl())
            }
            "move" -> moveCursor(m.optDouble("dx").toFloat(), m.optDouble("dy").toFloat())
            "click" -> click()
            "scroll" -> scrollPage(m.optDouble("dy").toFloat())
            "text" -> typeText(m.optString("text"))
            "key" -> pressKey(m.optString("key"))
            "media" -> media(m.optString("action"), m.optDouble("value", 0.0))
            "volume" -> volume(m.optString("dir"))
            "ua" -> setDesktop(m.optBoolean("desktop", true))
            "watch" -> watching = m.optBoolean("on")
        }
    }

    private fun openUrl(raw: String) {
        var u = raw.trim()
        if (u.isEmpty()) return
        if (!Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://").containsMatchIn(u)) {
            u = if (!u.contains(' ') && u.contains('.')) "https://$u"
            else "https://www.google.com/search?q=" + Uri.encode(u)
        }
        if (customView != null) hideCustomView()
        web.loadUrl(u)
    }

    private fun setDesktop(on: Boolean) {
        desktopUa = on
        web.settings.userAgentString = if (on) desktopUserAgent else null
        web.reload()
    }

    private fun hideCustomView() {
        val v = customView ?: return
        root.removeView(v)
        customView = null
        customCb?.onCustomViewHidden()
        customCb = null
        web.visibility = View.VISIBLE
        web.requestFocus()
    }

    // ---------- Cursor, clic, scroll ----------

    private fun moveCursor(dx: Float, dy: Float) {
        val x = (cursor.cx + dx).coerceIn(0f, (root.width - 1).toFloat())
        val y = (cursor.cy + dy).coerceIn(0f, (root.height - 1).toFloat())
        cursor.moveTo(x, y)
    }

    private fun click() {
        val target: View = customView ?: web
        val x = cursor.cx
        val y = cursor.cy
        val t = SystemClock.uptimeMillis()
        val down = MotionEvent.obtain(t, t, MotionEvent.ACTION_DOWN, x, y, 0)
        down.source = InputDevice.SOURCE_TOUCHSCREEN
        target.dispatchTouchEvent(down)
        down.recycle()
        ui.postDelayed({
            val t2 = SystemClock.uptimeMillis()
            val up = MotionEvent.obtain(t2, t2, MotionEvent.ACTION_UP, x, y, 0)
            up.source = InputDevice.SOURCE_TOUCHSCREEN
            target.dispatchTouchEvent(up)
            up.recycle()
        }, 60)
    }

    private fun scrollPage(dy: Float) {
        val d = resources.displayMetrics.density
        val js = "(function(x,y,dy){var e=document.elementFromPoint(x,y);" +
                "while(e&&e!==document.body&&e!==document.documentElement){var s=getComputedStyle(e);" +
                "if((s.overflowY=='auto'||s.overflowY=='scroll')&&e.scrollHeight>e.clientHeight){e.scrollTop+=dy;return}" +
                "e=e.parentElement}window.scrollBy(0,dy)})(${cursor.cx / d},${cursor.cy / d},${dy / d})"
        web.evaluateJavascript(js, null)
    }

    // ---------- Teclado ----------

    private fun sendKey(code: Int) {
        val t = SystemClock.uptimeMillis()
        web.dispatchKeyEvent(KeyEvent(t, t, KeyEvent.ACTION_DOWN, code, 0))
        web.dispatchKeyEvent(KeyEvent(t, t, KeyEvent.ACTION_UP, code, 0))
    }

    private fun pressKey(key: String) {
        val code = when (key) {
            "Enter" -> KeyEvent.KEYCODE_ENTER
            "Backspace" -> KeyEvent.KEYCODE_DEL
            "Escape" -> KeyEvent.KEYCODE_ESCAPE
            "Tab" -> KeyEvent.KEYCODE_TAB
            "ArrowUp" -> KeyEvent.KEYCODE_DPAD_UP
            "ArrowDown" -> KeyEvent.KEYCODE_DPAD_DOWN
            "ArrowLeft" -> KeyEvent.KEYCODE_DPAD_LEFT
            "ArrowRight" -> KeyEvent.KEYCODE_DPAD_RIGHT
            " " -> KeyEvent.KEYCODE_SPACE
            else -> return
        }
        sendKey(code)
    }

    private fun typeText(text: String) {
        if (text.isEmpty()) return
        val js = "(function(t){var e=document.activeElement;if(!e)return 'none';" +
                "if(e.isContentEditable){document.execCommand('insertText',false,t);return 'ok'}" +
                "if('value' in e){var s=e.selectionStart==null?e.value.length:e.selectionStart," +
                "en=e.selectionEnd==null?s:e.selectionEnd;" +
                "var set=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value').set;" +
                "set.call(e,e.value.slice(0,s)+t+e.value.slice(en));" +
                "try{e.selectionStart=e.selectionEnd=s+t.length}catch(x){}" +
                "e.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'}return 'none'})(" +
                JSONObject.quote(text) + ")"
        web.evaluateJavascript(js, null)
    }

    // ---------- Media ----------

    // Elige el <video> que se está reproduciendo, o el más grande de la página.
    private fun mediaJs(body: String) =
        "(function(){try{var vs=[].slice.call(document.querySelectorAll('video'));" +
                "var v=vs.filter(function(x){return !x.paused&&x.readyState>2})[0]||" +
                "vs.sort(function(a,b){return b.clientWidth*b.clientHeight-a.clientWidth*a.clientHeight})[0];" +
                "if(!v)return 'none';$body;return 'ok'}catch(e){return 'err'}})()"

    private fun media(action: String, value: Double) {
        val body = when (action) {
            "toggle" -> "v.paused?v.play():v.pause()"
            "play" -> "v.play()"
            "pause" -> "v.pause()"
            "seek" -> "v.currentTime=Math.max(0,v.currentTime+($value))"
            "seekto" -> "v.currentTime=$value"
            "speed" -> "v.playbackRate=$value"
            "mute" -> "v.muted=!v.muted"
            "fullscreen" -> "if(document.fullscreenElement){document.exitFullscreen()}else{(v.requestFullscreen||v.webkitRequestFullscreen).call(v)}"
            else -> return
        }
        web.evaluateJavascript(mediaJs(body)) { r ->
            // Sin <video> accesible (p. ej. dentro de un iframe): usa atajos de teclado del reproductor.
            if (r != null && r.contains("none")) {
                when (action) {
                    "toggle", "play", "pause" -> sendKey(KeyEvent.KEYCODE_SPACE)
                    "seek" -> sendKey(if (value < 0) KeyEvent.KEYCODE_DPAD_LEFT else KeyEvent.KEYCODE_DPAD_RIGHT)
                    "fullscreen" -> sendKey(KeyEvent.KEYCODE_F)
                    "mute" -> sendKey(KeyEvent.KEYCODE_M)
                }
            }
        }
    }

    private fun volume(dir: String) {
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val d = if (dir == "up") AudioManager.ADJUST_RAISE else AudioManager.ADJUST_LOWER
        am.adjustStreamVolume(AudioManager.STREAM_MUSIC, d, AudioManager.FLAG_SHOW_UI)
    }

    // ---------- Estado y captura hacia el mando ----------

    private val stateJs = "(function(){var vs=[].slice.call(document.querySelectorAll('video'));" +
            "var v=vs.filter(function(x){return !x.paused})[0]||" +
            "vs.sort(function(a,b){return b.clientWidth*b.clientHeight-a.clientWidth*a.clientHeight})[0];" +
            "return JSON.stringify(v?{has:1,paused:v.paused,pos:v.currentTime||0," +
            "dur:isFinite(v.duration)?v.duration:0,muted:v.muted,rate:v.playbackRate}:{has:0})})()"

    private val loop = object : Runnable {
        override fun run() {
            if (connected) {
                sendState()
                if (watching && (++tick % 2 == 0)) sendFrame()
            }
            ui.postDelayed(this, 1000)
        }
    }

    private fun sendState() {
        web.evaluateJavascript(stateJs) { r ->
            val o = try {
                JSONObject(JSONTokener(r).nextValue() as String)
            } catch (_: Exception) {
                JSONObject().put("has", 0)
            }
            o.put("type", "state")
                .put("url", web.url ?: "")
                .put("title", web.title ?: "")
                .put("canBack", web.canGoBack())
                .put("desktop", desktopUa)
            ws?.send(o.toString())
        }
    }

    private fun sendFrame() {
        val w = root.width
        val h = root.height
        if (w == 0 || h == 0 || !frameBusy.compareAndSet(false, true)) return
        val tw = 640
        val th = h * tw / w
        val bmp = try { Bitmap.createBitmap(tw, th, Bitmap.Config.RGB_565) } catch (e: OutOfMemoryError) { frameBusy.set(false); return }
        val c = Canvas(bmp)
        val s = tw.toFloat() / w
        c.scale(s, s)
        root.draw(c)
        io.execute {
            try {
                val out = ByteArrayOutputStream()
                bmp.compress(Bitmap.CompressFormat.JPEG, 55, out)
                val b64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
                ws?.send(JSONObject().put("type", "frame").put("data", b64).toString())
            } finally {
                bmp.recycle()
                frameBusy.set(false)
            }
        }
    }

    // ---------- Control remoto físico de la TV (D-pad) ----------
    // Mamá también puede usar el control: flechas = cursor, OK = clic, Atrás = volver.

    private var dpadRepeat = 0

    override fun dispatchKeyEvent(e: KeyEvent): Boolean {
        val down = e.action == KeyEvent.ACTION_DOWN
        when (e.keyCode) {
            KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN,
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT -> {
                if (down) {
                    dpadRepeat = if (e.repeatCount == 0) 0 else min(dpadRepeat + 1, 20)
                    val step = 22f + dpadRepeat * 6f
                    val dx = if (e.keyCode == KeyEvent.KEYCODE_DPAD_LEFT) -step else if (e.keyCode == KeyEvent.KEYCODE_DPAD_RIGHT) step else 0f
                    val dy = if (e.keyCode == KeyEvent.KEYCODE_DPAD_UP) -step else if (e.keyCode == KeyEvent.KEYCODE_DPAD_DOWN) step else 0f
                    val atEdge = (dy > 0 && cursor.cy >= root.height - 2) || (dy < 0 && cursor.cy <= 1)
                    if (atEdge) scrollPage(dy * 4) else moveCursor(dx, dy)
                }
                return true
            }
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> {
                if (down && e.repeatCount == 0) click()
                return true
            }
            KeyEvent.KEYCODE_BACK -> {
                if (down) {
                    if (customView != null) hideCustomView()
                    else if (web.canGoBack()) web.goBack()
                }
                return true
            }
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE -> {
                if (down) media("toggle", 0.0)
                return true
            }
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> { if (down) media("seek", 10.0); return true }
            KeyEvent.KEYCODE_MEDIA_REWIND -> { if (down) media("seek", -10.0); return true }
        }
        return super.dispatchKeyEvent(e)
    }
}
