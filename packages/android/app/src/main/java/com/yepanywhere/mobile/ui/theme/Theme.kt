package com.yepanywhere.mobile.ui.theme

import android.content.res.Configuration
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.dp

// Native counterparts of the web client's light and dark tokens.
private val BrandGreen = Color(0xFF047857)
private val LightSurface = Color(0xFFF8F8F6)
private val DarkSurface = Color(0xFF2F2F2F)

private val LightColors = lightColorScheme(
    primary = BrandGreen,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFE6F3EE),
    onPrimaryContainer = Color(0xFF174F40),
    secondary = Color(0xFF4A4741),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFF2F1ED),
    onSecondaryContainer = Color(0xFF2D2A26),
    background = LightSurface,
    onBackground = Color(0xFF2D2A26),
    surface = LightSurface,
    onSurface = Color(0xFF2D2A26),
    onSurfaceVariant = Color(0xFF716E68),
    surfaceVariant = Color(0xFFE9E8E2),
    surfaceTint = Color.Transparent,
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Color(0xFFFBFBF9),
    surfaceContainer = Color(0xFFF2F1ED),
    surfaceContainerHigh = Color(0xFFE9E8E2),
    surfaceContainerHighest = Color(0xFFE1E0DA),
    outline = Color(0xFF8D8980),
    outlineVariant = Color(0xFFE3E1DA),
    error = Color(0xFFCF222E),
    scrim = Color.Black,
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF7DD39A),
    onPrimary = Color(0xFF122C20),
    primaryContainer = Color(0xFF264439),
    onPrimaryContainer = Color(0xFFDEF5E8),
    secondary = Color(0xFFC0C0C0),
    onSecondary = Color(0xFF252525),
    secondaryContainer = Color(0xFF363636),
    onSecondaryContainer = Color(0xFFE0E0E0),
    background = DarkSurface,
    onBackground = Color(0xFFE0E0E0),
    surface = DarkSurface,
    onSurface = Color(0xFFE0E0E0),
    onSurfaceVariant = Color(0xFFB3B3B3),
    surfaceVariant = Color(0xFF3D3D3D),
    surfaceTint = Color.Transparent,
    surfaceContainerLowest = Color(0xFF292929),
    surfaceContainerLow = Color(0xFF2F2F2F),
    surfaceContainer = Color(0xFF363636),
    surfaceContainerHigh = Color(0xFF3D3D3D),
    surfaceContainerHighest = Color(0xFF444444),
    outline = Color(0xFF898989),
    outlineVariant = Color(0xFF4A4A4A),
    error = Color(0xFFFF9C94),
    scrim = Color.Black,
)

internal fun nativeShellDark(configuration: Configuration): Boolean =
    configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES

internal fun nativeShellSurface(configuration: Configuration): Int =
    (if (nativeShellDark(configuration)) DarkSurface else LightSurface).toArgb()

@Composable
fun YepAnywhereTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        shapes = Shapes(
            small = RoundedCornerShape(6.dp),
            medium = RoundedCornerShape(8.dp),
            large = RoundedCornerShape(12.dp),
            extraLarge = RoundedCornerShape(18.dp),
        ),
        content = content,
    )
}
