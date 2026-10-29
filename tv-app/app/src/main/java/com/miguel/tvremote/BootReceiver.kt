package com.miguel.tvremote

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Settings

/**
 * Al encender el Chromecast:
 *  1. Reactiva la depuración inalámbrica (para que la Raspberry/PC siga controlando la TV completa).
 *     Requiere, una sola vez: adb shell pm grant com.miguel.tvremote android.permission.WRITE_SECURE_SETTINGS
 *  2. Abre la app si "Abrir al encender la TV" está activado.
 *     En Android 10+ requiere, una sola vez: adb shell appops set com.miguel.tvremote SYSTEM_ALERT_WINDOW allow
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val a = intent.action ?: return
        if (a != Intent.ACTION_BOOT_COMPLETED && a != "android.intent.action.QUICKBOOT_POWERON") return

        enableWirelessAdb(context)

        val prefs = context.getSharedPreferences("cfg", Context.MODE_PRIVATE)
        if (!prefs.getBoolean("autostart", false)) return
        val launch = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        try { context.startActivity(launch) } catch (_: Exception) { }
    }

    companion object {
        fun enableWirelessAdb(context: Context) {
            try {
                val cr = context.contentResolver
                Settings.Global.putInt(cr, Settings.Global.ADB_ENABLED, 1)
                Settings.Global.putInt(cr, "adb_wifi_enabled", 1)
            } catch (_: SecurityException) {
                // Permiso WRITE_SECURE_SETTINGS no concedido todavía: no pasa nada.
            } catch (_: Exception) { }
        }
    }
}
