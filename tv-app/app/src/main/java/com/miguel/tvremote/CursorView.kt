package com.miguel.tvremote

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.view.View

/** Puntero virtual dibujado sobre el WebView. */
class CursorView(ctx: Context) : View(ctx) {
    var cx = 0f
        private set
    var cy = 0f
        private set

    private val scale = ctx.resources.displayMetrics.density
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
    private val edge = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.BLACK; style = Paint.Style.STROKE; strokeWidth = 2f * ctx.resources.displayMetrics.density
    }
    private val arrow = Path()

    init {
        isFocusable = false
        isClickable = false
    }

    fun moveTo(x: Float, y: Float) {
        cx = x; cy = y
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        val s = scale * 0.9f
        arrow.reset()
        arrow.moveTo(cx, cy)
        arrow.lineTo(cx, cy + 22f * s)
        arrow.lineTo(cx + 5f * s, cy + 17f * s)
        arrow.lineTo(cx + 9.5f * s, cy + 26f * s)
        arrow.lineTo(cx + 13f * s, cy + 24.5f * s)
        arrow.lineTo(cx + 8.5f * s, cy + 15.5f * s)
        arrow.lineTo(cx + 15f * s, cy + 15.5f * s)
        arrow.close()
        canvas.drawPath(arrow, fill)
        canvas.drawPath(arrow, edge)
    }
}
