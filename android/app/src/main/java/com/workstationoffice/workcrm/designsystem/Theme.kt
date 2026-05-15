package com.workstationoffice.workcrm.designsystem

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Visual language mirrored from workselected.com — sister brand. Black/near
 * black surfaces, warm-gold accent, sharp 8.dp corners on buttons, 12.dp on
 * cards, generous whitespace. The final hex values should be sampled from the
 * live site; values here are the same approximations as iOS DesignSystem/Theme.swift.
 */
object Tokens {
    val backgroundPrimary  = Color(0xFF0A0A0A)
    val backgroundElevated = Color(0xFF161616)
    val backgroundLight    = Color(0xFFFAFAFA)
    val surfaceBorder      = Color(0xFF2A2A2A)
    val accent             = Color(0xFFC9A961)
    val accentMuted        = Color(0xFF8C7341)
    val textPrimary        = Color.White
    val textSecondary      = Color(0xFFA8A8A8)
    val textOnLight        = Color(0xFF111111)
    val success            = Color(0xFF4ADE80)
    val danger             = Color(0xFFEF4444)
}

private val WorkCRMColors: ColorScheme = darkColorScheme(
    primary       = Tokens.accent,
    onPrimary     = Tokens.textOnLight,
    secondary     = Tokens.accentMuted,
    background    = Tokens.backgroundPrimary,
    onBackground  = Tokens.textPrimary,
    surface       = Tokens.backgroundElevated,
    onSurface     = Tokens.textPrimary,
    surfaceVariant = Tokens.backgroundElevated,
    error         = Tokens.danger,
    outline       = Tokens.surfaceBorder
)

private val WorkCRMTypography = Typography(
    displayMedium = TextStyle(fontSize = 32.sp, fontWeight = FontWeight.Bold,     letterSpacing = 0.sp),
    titleLarge    = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.sp),
    bodyLarge     = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Normal,   letterSpacing = 0.sp),
    bodyMedium    = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Normal,   letterSpacing = 0.sp),
    labelSmall    = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.2.sp)
)

private val WorkCRMShapes = Shapes(
    small  = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(12.dp),
    large  = RoundedCornerShape(16.dp)
)

@Composable
fun WorkCRMTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = WorkCRMColors,
        typography  = WorkCRMTypography,
        shapes      = WorkCRMShapes,
        content     = content
    )
}
