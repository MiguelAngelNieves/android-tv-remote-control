package com.miguel.tvremote

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Abre la app al encender la TV, solo si "Abrir al encender la TV" está activado en Ajustes.
 * En Android 10+ requiere (una sola vez, desde el PC):
 *   adb shell appops set com.miguel.tvremote SYSTEM_ALERT_WINDOW allow
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val a = intent.action ?: return
        if (a != Intent.ACTION_BOOT_COMPLETED && a != "android.intent.action.QUICKBOOT_POWERON") return
        val prefs = context.getSharedPreferences("cfg", Context.MODE_PRIVATE)
        if (!prefs.getBoolean("autostart", false)) return
        val launch = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        try { context.startActivity(launch) } catch (_: Exception) { }
    }
}
