package com.yepanywhere.mobile.ui

import androidx.annotation.DrawableRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SheetValue
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.yepanywhere.mobile.R
import com.yepanywhere.mobile.connection.YaConnectionPhase
import com.yepanywhere.mobile.profiles.YaPairedServerProfile
import com.yepanywhere.mobile.profiles.YaServerRouteKind
import com.yepanywhere.mobile.web.NativeTabs

@Composable
internal fun YaNavigationToolbar(host: String, tabCount: Int, onSwitchHost: () -> Unit, onShowTabs: () -> Unit) {
    val switchLabel = stringResource(R.string.native_switch_host)
    val tabsLabel = pluralStringResource(R.plurals.native_tabs_count, tabCount, tabCount)
    Surface(color = MaterialTheme.colorScheme.surface) {
        Column {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                    TextButton(
                        modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = switchLabel },
                        shape = MaterialTheme.shapes.medium,
                        onClick = onSwitchHost,
                    ) {
                        ShellIcon(R.drawable.native_host)
                        Spacer(Modifier.width(6.dp))
                        Text(host, modifier = Modifier.weight(1f, fill = false), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Spacer(Modifier.width(4.dp))
                        ShellIcon(R.drawable.native_chevron_down, size = 14)
                    }
                }
                Spacer(Modifier.width(8.dp))
                OutlinedButton(
                    modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = tabsLabel },
                    shape = MaterialTheme.shapes.medium,
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                    onClick = onShowTabs,
                ) {
                    ShellIcon(R.drawable.native_tabs, size = 17)
                    Spacer(Modifier.width(6.dp))
                    Text(tabCount.toString())
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun YaNavigationSheet(
    destination: YaShellDestination,
    state: YaHostManagementState,
    tabs: List<NativeTabs.Tab>,
    selectedTabId: String?,
    onBack: () -> Unit,
    onDismiss: () -> Unit,
    onDismissError: () -> Unit,
    onSelectTab: (String) -> Unit,
    onCloseTab: (String) -> Unit,
    onOpenHost: (String, Boolean) -> Unit,
    onOtherHost: () -> Unit,
    onAddHost: () -> Unit,
    onManageHosts: () -> Unit,
    hostLabels: Map<String, String>,
) {
    val active = tabs.firstOrNull { it.id == selectedTabId }
    val activeHost = active?.let { hostLabels[it.profileId] }
    val canNavigate by rememberUpdatedState(!state.actionInProgress)
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true, confirmValueChange = {
        it != SheetValue.Hidden || canNavigate
    })
    val title = stringResource(when (destination) {
        YaShellDestination.Tabs -> R.string.native_tabs
        YaShellDestination.OtherHost -> R.string.native_tab_new_other_host
        else -> R.string.native_switch_host
    })
    ModalBottomSheet(
        onDismissRequest = if (destination == YaShellDestination.OtherHost) onBack else onDismiss,
        sheetState = sheetState,
        containerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
        contentColor = MaterialTheme.colorScheme.onSurface,
        scrimColor = MaterialTheme.colorScheme.scrim.copy(alpha = 0.32f),
    ) {
        Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (destination == YaShellDestination.OtherHost) {
                    ShellIconButton(R.drawable.native_back, R.string.back, onClick = onBack, enabled = canNavigate)
                }
                Text(title, modifier = Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                ShellIconButton(R.drawable.native_close, R.string.dismiss, onClick = onDismiss, enabled = canNavigate)
            }
            ErrorCard(state.error, onDismissError)
            if (destination == YaShellDestination.Tabs) {
                Surface(
                    modifier = Modifier.weight(1f, fill = false),
                    shape = MaterialTheme.shapes.medium,
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                ) {
                    LazyColumn {
                        itemsIndexed(tabs, key = { _, tab -> tab.id }) { index, tab ->
                            if (index > 0) ShellRowDivider()
                            TabRow(tab, hostLabels[tab.profileId], tab.id == selectedTabId, canNavigate, onSelectTab, onCloseTab)
                        }
                    }
                }
                if (active != null && activeHost != null) {
                    Button(
                        onClick = { onOpenHost(active.profileId, true) },
                        modifier = Modifier.fillMaxWidth().padding(top = 12.dp).heightIn(min = 48.dp),
                        shape = MaterialTheme.shapes.medium,
                        enabled = canNavigate,
                    ) {
                        ShellIcon(R.drawable.native_plus)
                        Spacer(Modifier.width(6.dp))
                        Text(stringResource(R.string.native_tab_new_on_host, activeHost))
                    }
                }
                ShellSecondaryButton(R.string.native_tab_new_other_host, onOtherHost, R.drawable.native_chevron, canNavigate)
            } else {
                val choosingOther = destination == YaShellDestination.OtherHost
                val profiles = state.profiles.filter { !choosingOther || it.id != active?.profileId }
                if (profiles.isEmpty()) {
                    Text(
                        stringResource(if (choosingOther) R.string.native_no_other_hosts else R.string.native_no_hosts),
                        modifier = Modifier.padding(vertical = 10.dp),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    Surface(
                        modifier = Modifier.weight(1f, fill = false),
                        shape = MaterialTheme.shapes.medium,
                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                    ) {
                        LazyColumn {
                            itemsIndexed(profiles, key = { _, profile -> profile.id }) { index, profile ->
                                if (index > 0) ShellRowDivider()
                                val count = tabs.count { it.profileId == profile.id }
                                val current = profile.id == active?.profileId
                                val phase = state.servers[profile.id]?.connection?.phase
                                val attention = phase == YaConnectionPhase.REVOKED || phase == YaConnectionPhase.REAUTHENTICATION_REQUIRED
                                HostNavigationRow(
                                    profile = profile,
                                    phase = phase,
                                    tabCount = count.takeUnless { choosingOther },
                                    selected = current,
                                    action = if (choosingOther || attention) null else stringResource(when {
                                        current -> R.string.native_tab_current
                                        count > 0 -> R.string.native_tab_resume
                                        else -> R.string.native_tab_open_projects
                                    }),
                                    enabled = canNavigate,
                                    onClick = { onOpenHost(profile.id, choosingOther) },
                                )
                            }
                        }
                    }
                }
                if (choosingOther) ShellSecondaryButton(R.string.native_tab_add_host, onAddHost, R.drawable.native_plus, canNavigate)
                else ShellSecondaryButton(R.string.native_manage_hosts, onManageHosts, enabled = canNavigate)
            }
        }
    }
}

@Composable
private fun TabRow(
    tab: NativeTabs.Tab,
    label: String?,
    current: Boolean,
    enabled: Boolean,
    onSelect: (String) -> Unit,
    onClose: (String) -> Unit,
) {
    val host = label ?: stringResource(R.string.native_tab_unavailable_host)
    val path = NativeTabs.safePath(tab.path)
    val title = when {
        tab.title !in setOf("Projects", "Yep Anywhere", "Yep Anywhere - Remote", "") -> tab.title
        path == "/projects" -> stringResource(R.string.native_tab_projects)
        else -> path
    }
    val selectLabel = stringResource(R.string.native_tab_select, host, path)
    val closeLabel = stringResource(R.string.native_tab_close, title, host)
    Row(
        modifier = Modifier.fillMaxWidth().background(
            if (current) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerLowest,
        ).padding(end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            modifier = Modifier.weight(1f).heightIn(min = 60.dp)
                .clickable(enabled = enabled, role = Role.Button) { onSelect(tab.id) }
                .semantics { selected = current; contentDescription = selectLabel }
                .padding(start = 12.dp, top = 7.dp, bottom = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ShellRowMark(if (path == "/projects") R.drawable.native_folder else R.drawable.native_tabs)
            Spacer(Modifier.width(10.dp))
            Column {
                Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleSmall)
                Text(
                    if (current) stringResource(R.string.native_tab_current_host, host) else host,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        IconButton(onClick = { onClose(tab.id) }, enabled = enabled, modifier = Modifier.size(48.dp)) {
            ShellIcon(R.drawable.native_close, closeLabel, 18)
        }
    }
}

@Composable
internal fun HostNavigationRow(
    profile: YaPairedServerProfile,
    phase: YaConnectionPhase?,
    tabCount: Int?,
    selected: Boolean = false,
    action: String? = null,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val route = if (preferredRoute(profile).kind == YaServerRouteKind.DIRECT) R.string.direct_connection else R.string.relay_connection
    val status = when (phase) {
        YaConnectionPhase.REAUTHENTICATION_REQUIRED -> R.string.connection_sign_in_required
        YaConnectionPhase.REVOKED -> R.string.connection_revoked
        else -> null
    }
    val detail = when {
        status != null -> stringResource(status)
        tabCount != null -> stringResource(
            R.string.native_host_tabs,
            stringResource(route),
            if (tabCount == 0) stringResource(R.string.native_no_open_tabs)
            else pluralStringResource(R.plurals.native_host_tab_count, tabCount, tabCount),
        )
        else -> stringResource(route)
    }
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = 60.dp)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .semantics { this.selected = selected }
            .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ShellRowMark(R.drawable.native_host)
        Column(modifier = Modifier.weight(1f)) {
            Text(profile.label, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(detail, color = if (status != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (action != null) Text(action, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelMedium)
        ShellIcon(if (selected) R.drawable.native_check else R.drawable.native_chevron, size = 16)
    }
}

internal fun preferredRoute(profile: YaPairedServerProfile) =
    profile.routes.firstOrNull { it.id == profile.preferredRouteId } ?: profile.routes.first()

@Composable
internal fun ShellRowDivider() = HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)

@Composable
internal fun ShellIcon(@DrawableRes icon: Int, description: String? = null, size: Int = 20) {
    Icon(painterResource(icon), contentDescription = description, modifier = Modifier.size(size.dp))
}

@Composable
internal fun ShellIconButton(@DrawableRes icon: Int, label: Int, onClick: () -> Unit, enabled: Boolean = true) {
    IconButton(onClick = onClick, enabled = enabled, modifier = Modifier.size(48.dp)) {
        ShellIcon(icon, stringResource(label))
    }
}

@Composable
private fun ShellRowMark(@DrawableRes icon: Int) {
    Surface(
        shape = MaterialTheme.shapes.small,
        color = MaterialTheme.colorScheme.secondaryContainer,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Box(modifier = Modifier.size(34.dp), contentAlignment = Alignment.Center) { ShellIcon(icon, size = 18) }
    }
}

@Composable
private fun ShellSecondaryButton(label: Int, onClick: () -> Unit, @DrawableRes icon: Int? = null, enabled: Boolean) {
    OutlinedButton(
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp).heightIn(min = 48.dp),
        onClick = onClick,
        enabled = enabled,
        shape = MaterialTheme.shapes.medium,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Text(stringResource(label))
        if (icon != null) {
            Spacer(Modifier.width(6.dp))
            ShellIcon(icon, size = 16)
        }
    }
}
