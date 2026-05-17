package com.workstationoffice.workcrm.designsystem

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/**
 * Primary CTA — solid white fill, black text. Mirrors workselected.com's
 * primary action style: on the near-black surface the dominant button pops
 * in white, not gold. Gold (Tokens.accent) is kept for accent usage —
 * eyebrows, KPI ring fills, active chips, link arrows — never bulk fills.
 */
@Composable
fun PrimaryButton(text: String, enabled: Boolean = true, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        enabled = enabled,
        shape   = RoundedCornerShape(8.dp),
        colors  = ButtonDefaults.buttonColors(
            containerColor = Tokens.textPrimary,
            contentColor   = Tokens.textOnLight
        ),
        modifier = Modifier.fillMaxWidth().height(48.dp)
    ) {
        Text(text)
    }
}

@Composable
fun SecondaryButton(text: String, enabled: Boolean = true, onClick: () -> Unit) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        shape   = RoundedCornerShape(8.dp),
        border  = BorderStroke(1.dp, Tokens.surfaceBorder),
        modifier = Modifier.fillMaxWidth().height(48.dp)
    ) {
        Text(text)
    }
}

/** UPPERCASE collection-style header that mirrors workselected.com's eyebrow.
 *  Announced as a heading to TalkBack so section landmarks work even though
 *  Material 3's labelSmall isn't styled like a Material heading. `.uppercase()`
 *  is a no-op on Thai script (no case), which is intentional. */
@Composable
fun Eyebrow(text: String) {
    Text(
        text     = text.uppercase(),
        color    = Tokens.textSecondary,
        style    = androidx.compose.material3.MaterialTheme.typography.labelSmall,
        modifier = Modifier.semantics { heading() }
    )
}

/** Card surface — minimal border, no shadow, matches iOS .card(). */
@Composable
fun WorkCard(content: @Composable () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(Tokens.backgroundElevated)
            .padding(20.dp)
    ) {
        content()
    }
}
