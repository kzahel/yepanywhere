package com.yepanywhere.mobile.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.yepanywhere.mobile.R
import com.yepanywhere.mobile.connection.YaConnectionPhase
import com.yepanywhere.mobile.profiles.YaServerRouteKind
import com.yepanywhere.mobile.web.NativeTabs

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun YaHostManagementScreen(
    destination: YaShellDestination,
    tabs: List<NativeTabs.Tab>,
    viewModel: YaHostManagementViewModel,
    pairingInput: YaPairingInput? = null,
    onClearPairingInput: () -> Unit,
    onBack: () -> Unit,
    onAddHost: () -> Unit,
    onHostDetails: (String) -> Unit,
    onEnablePush: (String) -> Unit = {},
    onOpenNotificationSettings: (String) -> Unit = {},
    onAcceptPushOffer: () -> Unit = {},
) {
    val state by viewModel.state.collectAsState()
    var confirmForgetProfileId by rememberSaveable { mutableStateOf<String?>(null) }

    if (confirmForgetProfileId != null) {
        val profile = state.profiles.firstOrNull { it.id == confirmForgetProfileId }
        val unregistersServer = profile?.securityClient?.let {
            !it.revoked && !it.capabilityMissing && it.clientId != null
        } == true
        AlertDialog(
            onDismissRequest = { confirmForgetProfileId = null },
            title = {
                Text(
                    stringResource(
                        if (unregistersServer) {
                            R.string.remove_server_title
                        } else {
                            R.string.forget_server_title
                        },
                    ),
                )
            },
            text = {
                Text(
                    stringResource(
                        if (unregistersServer) {
                            R.string.remove_server_explanation
                        } else {
                            R.string.forget_server_explanation
                        },
                    ),
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        val profileId = checkNotNull(confirmForgetProfileId)
                        confirmForgetProfileId = null
                        viewModel.removeProfile(profileId)
                    },
                ) {
                    Text(
                        stringResource(
                            if (unregistersServer) {
                                R.string.remove_server
                            } else {
                                R.string.forget_server
                            },
                        ),
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmForgetProfileId = null }) {
                    Text(stringResource(R.string.cancel))
                }
            },
        )
    }

    state.pushOffer?.takeIf { !state.pushOfferAccepted }?.let { profileId ->
        val label = state.profiles.firstOrNull { it.id == profileId }?.label.orEmpty()
        AlertDialog(
            onDismissRequest = { viewModel.finishPushOffer() },
            title = { Text(stringResource(R.string.native_push_offer_title)) },
            text = { Text(stringResource(R.string.native_push_offer_body, label)) },
            confirmButton = {
                TextButton(onClick = onAcceptPushOffer) {
                    Text(stringResource(R.string.native_push_enable))
                }
            },
            dismissButton = {
                TextButton(onClick = { viewModel.finishPushOffer() }) {
                    Text(stringResource(R.string.native_push_offer_decline))
                }
            },
        )
    }

    state.removalPrompt?.let { prompt ->
        AlertDialog(
            onDismissRequest = viewModel::clearRemovalPrompt,
            title = {
                Text(
                    stringResource(
                        if (prompt.kind == YaRemovalPromptKind.SERVER_ALREADY_UNREGISTERED) {
                            R.string.finish_forgetting_title
                        } else {
                            R.string.forget_anyway_title
                        },
                    ),
                )
            },
            text = {
                Text(
                    stringResource(
                        if (prompt.kind == YaRemovalPromptKind.SERVER_ALREADY_UNREGISTERED) {
                            R.string.finish_forgetting_explanation
                        } else {
                            R.string.forget_anyway_explanation
                        },
                    ),
                )
            },
            confirmButton = {
                TextButton(onClick = { viewModel.forgetAnyway(prompt.profileId) }) {
                    Text(
                        stringResource(
                            if (prompt.kind == YaRemovalPromptKind.SERVER_ALREADY_UNREGISTERED) {
                                R.string.finish_forgetting
                            } else {
                                R.string.forget_anyway
                            },
                        ),
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = viewModel::clearRemovalPrompt) {
                    Text(stringResource(R.string.cancel))
                }
            },
        )
    }

    val details = (destination as? YaShellDestination.Details)?.let { screen ->
        state.servers[screen.profileId] ?: state.profiles.firstOrNull { it.id == screen.profileId }?.let { YaHostState(it) }
    }
    val pairing = destination as? YaShellDestination.AddHost
    val title = when {
        pairing != null -> stringResource(if (pairing.returnTo == null) R.string.connect_to_server else R.string.native_tab_add_host)
        details != null -> details.profile.label
        else -> stringResource(R.string.native_hosts)
    }
    val canGoBack = when (destination) {
        is YaShellDestination.AddHost -> destination.returnTo != null
        is YaShellDestination.Hosts -> tabs.isNotEmpty()
        else -> true
    }
    Scaffold(
        modifier = Modifier.fillMaxSize().imePadding(),
        topBar = {
            Column {
                TopAppBar(
                    title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    navigationIcon = {
                        if (canGoBack) {
                            ShellIconButton(
                                R.drawable.native_back, R.string.back, onBack,
                                enabled = !state.actionInProgress && state.pushOffer == null,
                            )
                        }
                    },
                    windowInsets = androidx.compose.foundation.layout.WindowInsets(0, 0, 0, 0),
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
                )
                ShellRowDivider()
            }
        },
    ) { contentPadding ->
        Surface(
            modifier = Modifier.fillMaxSize().padding(contentPadding),
            color = MaterialTheme.colorScheme.surface,
        ) {
            when {
                pairing != null -> PairingScreen(
                    actionInProgress = state.actionInProgress || state.pushOffer != null,
                    error = state.error,
                    onDismissError = viewModel::clearError,
                    onPair = { onClearPairingInput(); viewModel.pair(it) },
                    initialInput = pairingInput,
                )
                details != null -> HostDetails(
                    source = details,
                    tabCount = tabs.count { it.profileId == details.profile.id },
                    deviceNotifications = state.deviceNotifications,
                    actionInProgress = state.actionInProgress,
                    error = state.error,
                    onDismissError = viewModel::clearError,
                    onReauthenticate = { password -> viewModel.reauthenticate(details.profile.id, password, destination.newTab) },
                    onForgetServer = { confirmForgetProfileId = details.profile.id },
                    onOpenServer = { viewModel.select(details.profile.id, destination.newTab) },
                    onEnablePush = { onEnablePush(details.profile.id) },
                    onDisablePush = { viewModel.setPush(details.profile.id, false) },
                    onTestPush = { viewModel.testPush(details.profile.id) },
                    onOpenNotificationSettings = { onOpenNotificationSettings(details.profile.id) },
                )
                else -> HostList(state, tabs, onAddHost, onHostDetails, viewModel::clearError)
            }
        }
    }
}

@Composable
private fun PairingScreen(
    actionInProgress: Boolean,
    error: YaNativeUiError?,
    onDismissError: () -> Unit,
    onPair: (YaPairingInput) -> Unit,
    initialInput: YaPairingInput? = null,
) {
    var username by remember { mutableStateOf(initialInput?.username.orEmpty()) }
    var password by remember { mutableStateOf(initialInput?.password.orEmpty()) }
    var showAdvanced by remember { mutableStateOf(initialInput?.relayWebsocketUrl?.isNotEmpty() == true) }
    var relayWebsocketUrl by remember { mutableStateOf(initialInput?.relayWebsocketUrl.orEmpty()) }
    var directWebsocketUrl by remember { mutableStateOf("") }
    var routeKind by remember { mutableStateOf(YaPairingRouteKind.RELAY) }
    val uriHandler = LocalUriHandler.current

    LaunchedEffect(initialInput) {
        if (initialInput != null) {
            username = initialInput.username
            password = initialInput.password
            relayWebsocketUrl = initialInput.relayWebsocketUrl
            showAdvanced = relayWebsocketUrl.isNotEmpty()
            routeKind = YaPairingRouteKind.RELAY
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 22.dp, vertical = 20.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Surface(shape = MaterialTheme.shapes.medium, color = Color(0xFF047857)) {
                Icon(
                    painterResource(R.drawable.ic_launcher_foreground),
                    contentDescription = null,
                    tint = Color.White,
                    modifier = Modifier.size(36.dp),
                )
            }
            Text(
                stringResource(R.string.native_wordmark),
                style = MaterialTheme.typography.titleLarge,
                fontFamily = FontFamily.Serif,
                fontWeight = FontWeight.SemiBold,
            )
        }
        Text(
            modifier = Modifier.padding(top = 12.dp),
            text = stringResource(R.string.connect_to_server_explanation),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        ErrorCard(error, onDismissError)
        OutlinedTextField(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 20.dp)
                .semantics { contentType = ContentType.Username },
            value = username,
            onValueChange = { username = it },
            label = {
                Text(stringResource(if (routeKind == YaPairingRouteKind.RELAY) R.string.native_relay_server_name else R.string.username))
            },
            singleLine = true,
        )
        OutlinedTextField(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 12.dp)
                .semantics { contentType = ContentType.Password },
            value = password,
            onValueChange = { password = it },
            label = { Text(stringResource(R.string.password)) },
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            singleLine = true,
        )
        TextButton(
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp).heightIn(min = 48.dp),
            shape = MaterialTheme.shapes.medium,
            enabled = !actionInProgress,
            onClick = { showAdvanced = !showAdvanced },
        ) {
            Text(
                stringResource(
                    if (showAdvanced) {
                        R.string.hide_advanced_connection
                    } else {
                        R.string.advanced_connection
                    },
                ),
            )
            Spacer(Modifier.width(4.dp))
            ShellIcon(if (showAdvanced) R.drawable.native_chevron_down else R.drawable.native_chevron, size = 14)
        }
        if (showAdvanced) {
            Text(
                modifier = Modifier.padding(top = 8.dp),
                text = stringResource(R.string.connection_route),
                style = MaterialTheme.typography.labelLarge,
            )
            Row(
                modifier = Modifier.padding(top = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                FilterChip(
                    selected = routeKind == YaPairingRouteKind.RELAY,
                    onClick = { routeKind = YaPairingRouteKind.RELAY },
                    label = { Text(stringResource(R.string.relay_connection)) },
                )
                FilterChip(
                    selected = routeKind == YaPairingRouteKind.DIRECT,
                    onClick = { routeKind = YaPairingRouteKind.DIRECT },
                    label = { Text(stringResource(R.string.direct_connection)) },
                )
            }
            Text(
                text = if (routeKind == YaPairingRouteKind.DIRECT) {
                    stringResource(R.string.direct_connection_explanation)
                } else {
                    stringResource(R.string.relay_connection_explanation)
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedTextField(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 12.dp),
                value = if (routeKind == YaPairingRouteKind.RELAY) {
                    relayWebsocketUrl
                } else {
                    directWebsocketUrl
                },
                onValueChange = {
                    if (routeKind == YaPairingRouteKind.RELAY) {
                        relayWebsocketUrl = it
                    } else {
                        directWebsocketUrl = it
                    }
                },
                label = {
                    Text(
                        stringResource(
                            if (routeKind == YaPairingRouteKind.RELAY) {
                                R.string.custom_relay_url
                            } else {
                                R.string.websocket_url
                            },
                        ),
                    )
                },
                placeholder = {
                    Text(
                        stringResource(
                            if (routeKind == YaPairingRouteKind.RELAY) {
                                R.string.default_relay_url
                            } else {
                                R.string.websocket_url_example
                            },
                        ),
                        // The theme default is nearly as bright as entered text,
                        // so an empty field read as already filled in.
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                    )
                },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                singleLine = true,
            )
        }
        Button(
            modifier = Modifier.fillMaxWidth().padding(top = 14.dp).heightIn(min = 48.dp),
            shape = MaterialTheme.shapes.medium,
            enabled = !actionInProgress,
            onClick = {
                val enteredPassword = password
                password = ""
                onPair(
                    YaPairingInput(
                        username = username,
                        password = enteredPassword,
                        routeKind = routeKind,
                        relayWebsocketUrl = relayWebsocketUrl,
                        directWebsocketUrl = directWebsocketUrl,
                    ),
                )
            },
        ) {
            if (actionInProgress) {
                CircularProgressIndicator(
                    modifier = Modifier.size(18.dp),
                    strokeWidth = 2.dp,
                )
                Spacer(Modifier.width(8.dp))
            }
            Text(stringResource(R.string.connect))
        }
        TextButton(onClick = { uriHandler.openUri("https://graehlarts.com/privacy.html#yepanywhere") }) {
            Text(stringResource(R.string.privacy_policy))
        }
    }
}

@Composable
private fun HostList(
    state: YaHostManagementState,
    tabs: List<NativeTabs.Tab>,
    onAddHost: () -> Unit,
    onHostDetails: (String) -> Unit,
    onDismissError: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        ErrorCard(state.error, onDismissError)
        if (state.profiles.isEmpty()) {
            Text(stringResource(R.string.native_no_hosts), color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            Surface(
                modifier = Modifier.weight(1f, fill = false),
                shape = MaterialTheme.shapes.medium,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                color = MaterialTheme.colorScheme.surfaceContainerLowest,
            ) {
                LazyColumn {
                    itemsIndexed(state.profiles, key = { _, profile -> profile.id }) { index, profile ->
                        if (index > 0) ShellRowDivider()
                        HostNavigationRow(
                            profile = profile,
                            phase = state.servers[profile.id]?.connection?.phase,
                            tabCount = tabs.count { it.profileId == profile.id },
                            enabled = !state.actionInProgress,
                            onClick = { onHostDetails(profile.id) },
                        )
                    }
                }
            }
        }
        Button(
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            shape = MaterialTheme.shapes.medium,
            onClick = onAddHost,
            enabled = !state.actionInProgress,
        ) {
            ShellIcon(R.drawable.native_plus)
            Spacer(Modifier.width(6.dp))
            Text(stringResource(R.string.native_tab_add_host))
        }
    }
}

@Composable
private fun HostDetails(
    source: YaHostState,
    tabCount: Int,
    deviceNotifications: YaDeviceNotifications,
    actionInProgress: Boolean,
    error: YaNativeUiError?,
    onDismissError: () -> Unit,
    onReauthenticate: (String) -> Unit,
    onForgetServer: () -> Unit,
    onOpenServer: () -> Unit,
    onEnablePush: () -> Unit,
    onDisablePush: () -> Unit,
    onTestPush: () -> Unit,
    onOpenNotificationSettings: () -> Unit,
) {
    val profile = source.profile
    val route = preferredRoute(profile)
    val phase = source.connection.phase
    val unregistersServer = profile.securityClient?.let {
        !it.revoked && !it.capabilityMissing && it.clientId != null
    } == true
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        ErrorCard(error, onDismissError)
        Surface(
            shape = MaterialTheme.shapes.medium,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
            color = MaterialTheme.colorScheme.surfaceContainerLowest,
        ) {
            Column {
                HostDetailRow(
                    R.string.native_host_connection,
                    stringResource(if (route.kind == YaServerRouteKind.DIRECT) R.string.direct_connection else R.string.relay_connection),
                )
                ShellRowDivider()
                HostDetailRow(R.string.native_host_address, route.websocketUrl)
                ShellRowDivider()
                HostDetailRow(R.string.native_host_open_tabs, tabCount.toString())
                ShellRowDivider()
                HostDetailRow(R.string.native_host_status, connectionStatus(phase), connectionStatusColor(phase))
            }
        }
        if (phase == YaConnectionPhase.REAUTHENTICATION_REQUIRED) {
            ReauthenticationCard(actionInProgress, onReauthenticate)
        } else if (phase != YaConnectionPhase.REVOKED) {
            Button(
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                shape = MaterialTheme.shapes.medium,
                onClick = onOpenServer,
                enabled = !actionInProgress,
            ) { Text(stringResource(R.string.open_full_app)) }
        }
        if (deviceNotifications != YaDeviceNotifications.UNAVAILABLE) {
            Text(stringResource(R.string.native_host_notifications), style = MaterialTheme.typography.titleSmall)
            PushControls(
                pushEnabled = source.pushEnabled,
                deviceNotifications = deviceNotifications,
                actionInProgress = actionInProgress,
                revoked = phase == YaConnectionPhase.REVOKED,
                onEnablePush = onEnablePush,
                onDisablePush = onDisablePush,
                onTestPush = onTestPush,
                onOpenNotificationSettings = onOpenNotificationSettings,
            )
        }
        OutlinedButton(
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            shape = MaterialTheme.shapes.medium,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.error),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
            enabled = !actionInProgress,
            onClick = onForgetServer,
        ) {
            Text(stringResource(if (unregistersServer) R.string.remove_server else R.string.forget_server))
        }
    }
}

@Composable
private fun HostDetailRow(label: Int, value: String, valueColor: Color = MaterialTheme.colorScheme.onSurfaceVariant) {
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = 46.dp).padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(stringResource(label), style = MaterialTheme.typography.labelLarge)
        Text(value, modifier = Modifier.weight(1f), color = valueColor,
            style = MaterialTheme.typography.bodyMedium, textAlign = androidx.compose.ui.text.style.TextAlign.End)
    }
}

/**
 * Server enrollment and Android's own notification switches are separate. A
 * blocked device can only be fixed in Settings, so offer that instead of an
 * Enable action that would silently do nothing.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PushControls(
    pushEnabled: Boolean,
    deviceNotifications: YaDeviceNotifications,
    actionInProgress: Boolean,
    revoked: Boolean,
    onEnablePush: () -> Unit,
    onDisablePush: () -> Unit,
    onTestPush: () -> Unit,
    onOpenNotificationSettings: () -> Unit,
) {
    val blocked = deviceNotifications == YaDeviceNotifications.BLOCKED ||
        (pushEnabled && deviceNotifications != YaDeviceNotifications.READY)
    Text(
        modifier = Modifier.padding(top = 10.dp),
        text = stringResource(
            when {
                pushEnabled && blocked -> R.string.native_push_enabled_blocked
                pushEnabled -> R.string.native_push_enabled
                blocked -> R.string.native_push_blocked
                else -> R.string.native_push_disabled
            },
        ),
        color = if (blocked) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodySmall,
    )
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (blocked) {
            TextButton(onClick = onOpenNotificationSettings) {
                Text(stringResource(R.string.native_push_open_settings))
            }
        } else if (!pushEnabled) {
            TextButton(onClick = onEnablePush, enabled = !actionInProgress && !revoked) {
                Text(stringResource(R.string.native_push_enable))
            }
        }
        if (pushEnabled) {
            TextButton(onClick = onDisablePush, enabled = !actionInProgress && !revoked) {
                Text(stringResource(R.string.native_push_disable))
            }
            if (!blocked) TextButton(onClick = onTestPush, enabled = !actionInProgress) {
                Text(stringResource(R.string.native_push_test))
            }
        }
    }
}

@Composable
private fun ReauthenticationCard(
    actionInProgress: Boolean,
    onReauthenticate: (String) -> Unit,
) {
    var password by remember { mutableStateOf("") }
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.secondaryContainer,
        ),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = stringResource(R.string.sign_in_again),
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                modifier = Modifier.padding(top = 4.dp),
                text = stringResource(R.string.sign_in_again_explanation),
                color = MaterialTheme.colorScheme.onSecondaryContainer,
            )
            OutlinedTextField(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 12.dp)
                    .semantics { contentType = ContentType.Password },
                value = password,
                onValueChange = { password = it },
                label = { Text(stringResource(R.string.password)) },
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                singleLine = true,
            )
            Button(
                modifier = Modifier
                    .align(Alignment.End)
                    .padding(top = 12.dp),
                enabled = !actionInProgress,
                onClick = {
                    val enteredPassword = password
                    password = ""
                    onReauthenticate(enteredPassword)
                },
            ) {
                Text(stringResource(R.string.sign_in))
            }
        }
    }
}

@Composable
internal fun ErrorCard(error: YaNativeUiError?, onDismiss: () -> Unit) {
    if (error == null) return
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 12.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.errorContainer,
        ),
    ) {
        Row(
            modifier = Modifier.padding(start = 16.dp, top = 12.dp, end = 8.dp, bottom = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                modifier = Modifier.weight(1f),
                text = uiErrorLabel(error),
                color = MaterialTheme.colorScheme.onErrorContainer,
            )
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.dismiss))
            }
        }
    }
}

@Composable
private fun connectionStatus(phase: YaConnectionPhase): String = when (phase) {
    YaConnectionPhase.IDLE -> stringResource(R.string.connection_idle)
    YaConnectionPhase.CONNECTING -> stringResource(R.string.connection_connecting)
    YaConnectionPhase.CONNECTED -> stringResource(R.string.connection_connected)
    YaConnectionPhase.RETRYING -> stringResource(R.string.connection_retrying)
    YaConnectionPhase.REAUTHENTICATION_REQUIRED -> stringResource(
        R.string.connection_sign_in_required,
    )
    YaConnectionPhase.REVOKED -> stringResource(R.string.connection_revoked)
    YaConnectionPhase.FAILED -> stringResource(R.string.connection_failed)
}

@Composable
private fun connectionStatusColor(phase: YaConnectionPhase) = when (phase) {
    YaConnectionPhase.CONNECTED -> MaterialTheme.colorScheme.primary
    YaConnectionPhase.REAUTHENTICATION_REQUIRED,
    YaConnectionPhase.REVOKED,
    YaConnectionPhase.FAILED,
    -> MaterialTheme.colorScheme.error
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}

@Composable
private fun uiErrorLabel(error: YaNativeUiError): String = when (error) {
    YaNativeUiError.INVALID_SERVER_DETAILS -> stringResource(
        R.string.invalid_server_details,
    )
    YaNativeUiError.AUTHENTICATION_FAILED -> stringResource(
        R.string.authentication_failed,
    )
    YaNativeUiError.SERVER_UNAVAILABLE -> stringResource(R.string.server_unavailable)
    YaNativeUiError.CONNECTION_FAILED -> stringResource(R.string.connection_failed_message)
    YaNativeUiError.PUSH_FAILED -> stringResource(R.string.native_push_failed)
    YaNativeUiError.SERVER_UPDATE_REQUIRED -> stringResource(R.string.native_push_update_required)
}
