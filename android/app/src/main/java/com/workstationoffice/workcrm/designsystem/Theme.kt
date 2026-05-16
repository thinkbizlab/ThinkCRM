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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
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

// Thai consonants stack two vowel + tone marks; the default 1.2× line-height
// multiplier (~1.2 of fontSize) is tight on multi-line bodies and clips the
// upper marks on smaller devices. We bump bodies to ~1.5× and centre the
// trimmed strut so neither the top nor bottom mark is cropped. `FontFamily.SansSerif`
// resolves to Roboto for Latin and Noto Sans Thai for Thai automatically via
// the system's TextLayout fallback chain.
private val WorkCRMTypography = Typography(
    displayMedium = TextStyle(
        fontFamily   = FontFamily.SansSerif,
        fontSize     = 32.sp,
        lineHeight   = 40.sp,
        fontWeight   = FontWeight.Bold,
        letterSpacing = 0.sp,
        lineHeightStyle = LineHeightStyle(alignment = LineHeightStyle.Alignment.Center, trim = LineHeightStyle.Trim.None)
    ),
    titleLarge = TextStyle(
        fontFamily   = FontFamily.SansSerif,
        fontSize     = 22.sp,
        lineHeight   = 32.sp,
        fontWeight   = FontWeight.SemiBold,
        letterSpacing = 0.sp,
        lineHeightStyle = LineHeightStyle(alignment = LineHeightStyle.Alignment.Center, trim = LineHeightStyle.Trim.None)
    ),
    bodyLarge = TextStyle(
        fontFamily   = FontFamily.SansSerif,
        fontSize     = 16.sp,
        lineHeight   = 24.sp,    // 1.5× — comfortable for Thai bodies
        fontWeight   = FontWeight.Normal,
        letterSpacing = 0.sp,
        lineHeightStyle = LineHeightStyle(alignment = LineHeightStyle.Alignment.Center, trim = LineHeightStyle.Trim.None)
    ),
    bodyMedium = TextStyle(
        fontFamily   = FontFamily.SansSerif,
        fontSize     = 14.sp,
        lineHeight   = 22.sp,
        fontWeight   = FontWeight.Normal,
        letterSpacing = 0.sp,
        lineHeightStyle = LineHeightStyle(alignment = LineHeightStyle.Alignment.Center, trim = LineHeightStyle.Trim.None)
    ),
    labelSmall = TextStyle(
        fontFamily   = FontFamily.SansSerif,
        fontSize     = 11.sp,
        lineHeight   = 18.sp,
        fontWeight   = FontWeight.SemiBold,
        letterSpacing = 1.2.sp
    )
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
