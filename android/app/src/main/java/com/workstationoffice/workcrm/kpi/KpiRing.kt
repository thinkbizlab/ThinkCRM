package com.workstationoffice.workcrm.kpi

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import com.workstationoffice.workcrm.designsystem.Eyebrow
import com.workstationoffice.workcrm.designsystem.Tokens
import kotlin.math.min

/**
 * Circular progress ring with overage arc — mirrors iOS KpiRing.
 * `progress` is in 0..∞; 1.0 = 100% of target. Values > 1 render the overage
 * portion in success green to celebrate going above target.
 */
@Composable
fun KpiRing(
    progress: Double,
    label: String,
    primaryText: String,
    secondaryText: String? = null,
    modifier: Modifier = Modifier
) {
    val clamped = if (progress.isFinite()) progress.coerceAtLeast(0.0) else 0.0

    Column(
        modifier = modifier.width(120.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Box(modifier = Modifier.size(120.dp), contentAlignment = Alignment.Center) {
            Canvas(modifier = Modifier.fillMaxSize()) {
                val stroke = Stroke(width = 8.dp.toPx(), cap = StrokeCap.Round)
                val side = min(size.width, size.height) - stroke.width
                val topLeft = Offset((size.width - side) / 2, (size.height - side) / 2)
                val arcSize = Size(side, side)

                drawArc(
                    color = Tokens.surfaceBorder,
                    startAngle = 0f,
                    sweepAngle = 360f,
                    useCenter = false,
                    topLeft = topLeft,
                    size = arcSize,
                    style = stroke
                )
                val accentSweep = (min(clamped, 1.0) * 360f).toFloat()
                drawArc(
                    color = Tokens.accent,
                    startAngle = -90f,
                    sweepAngle = accentSweep,
                    useCenter = false,
                    topLeft = topLeft,
                    size = arcSize,
                    style = stroke
                )
                if (clamped > 1.0) {
                    val overSweep = (min(clamped - 1.0, 1.0) * 360f).toFloat()
                    drawArc(
                        color = Tokens.success,
                        startAngle = -90f,
                        sweepAngle = overSweep,
                        useCenter = false,
                        topLeft = topLeft,
                        size = arcSize,
                        style = stroke
                    )
                }
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(primaryText, color = Tokens.textPrimary, style = MaterialTheme.typography.titleLarge)
                secondaryText?.let {
                    Text(it, color = Tokens.textSecondary, style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
        Eyebrow(label)
    }
}
