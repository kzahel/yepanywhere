package com.yepanywhere.mobile.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
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
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.yepanywhere.mobile.R
import com.yepanywhere.mobile.connection.YaConnectionPhase
import com.yepanywhere.mobile.profiles.YaPairedServerProfile
import com.yepanywhere.mobile.profiles.YaServerRouteKind

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun YaNativeHomeScreen(
    viewModel: YaNativeHomeViewModel,
    openWebClient: () -> Unit,
    openConversation: (YaSourcedSession) -> Unit,
) {
    val state by viewModel.state.collectAsState()
    var showAddServer by rememberSaveable { mutableStateOf(false) }
    var showSettings by rememberSaveable { mutableStateOf(false) }
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

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.app_name)) },
                navigationIcon = {
                    if (showSettings || showAddServer) {
                        TextButton(
                            onClick = {
                                if (showAddServer) {
                                    showAddServer = false
                                    showSettings = state.profiles.isNotEmpty()
                                } else {
                                    showSettings = false
                                }
                            },
                        ) {
                            Text(stringResource(R.string.back))
                        }
                    }
                },
                actions = {
                    if (!showSettings && !showAddServer && state.profiles.isNotEmpty()) {
                        TextButton(onClick = openWebClient) {
                            Text(stringResource(R.string.open_full_app))
                        }
                        TextButton(onClick = { showSettings = true }) {
                            Text(stringResource(R.string.settings))
                        }
                    }
                },
            )
        },
    ) { contentPadding ->
        Surface(
            modifier = Modifier
                .fillMaxSize()
                .padding(contentPadding),
            color = MaterialTheme.colorScheme.background,
        ) {
            when {
                state.profiles.isEmpty() -> PairingScreen(
                    actionInProgress = state.actionInProgress,
                    error = state.error,
                    onDismissError = viewModel::clearError,
                    onPair = viewModel::pair,
                )

                showAddServer -> PairingScreen(
                    actionInProgress = state.actionInProgress,
                    error = state.error,
                    onDismissError = viewModel::clearError,
                    onPair = {
                        showAddServer = false
                        viewModel.pair(it)
                    },
                    onCancel = { showAddServer = false },
                )

                showSettings -> ServerSettings(
                    state = state,
                    onSetIncluded = viewModel::setIncluded,
                    onReauthenticate = viewModel::reauthenticate,
                    onDismissError = viewModel::clearError,
                    onAddServer = { showAddServer = true },
                    onForgetServer = { confirmForgetProfileId = it },
                )

                else -> UnifiedHome(
                    state = state,
                    onSetFilter = viewModel::setFilter,
                    onRefresh = viewModel::refreshSessions,
                    onReauthenticate = viewModel::reauthenticate,
                    onDismissError = viewModel::clearError,
                    onRetry = viewModel::retryConnection,
                    onOpenConversation = openConversation,
                )
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
    onCancel: (() -> Unit)? = null,
) {
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var showAdvanced by remember { mutableStateOf(false) }
    var relayWebsocketUrl by remember { mutableStateOf("") }
    var directWebsocketUrl by remember { mutableStateOf("") }
    var routeKind by remember { mutableStateOf(YaPairingRouteKind.RELAY) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 20.dp),
    ) {
        Text(
            text = stringResource(R.string.connect_to_server),
            style = MaterialTheme.typography.headlineSmall,
        )
        Text(
            modifier = Modifier.padding(top = 8.dp),
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
            label = { Text(stringResource(R.string.username)) },
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
            modifier = Modifier.padding(top = 8.dp),
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
                    )
                },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                singleLine = true,
            )
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 20.dp),
            horizontalArrangement = Arrangement.End,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (onCancel != null) {
                TextButton(
                    enabled = !actionInProgress,
                    onClick = onCancel,
                ) {
                    Text(stringResource(R.string.cancel))
                }
                Spacer(Modifier.width(8.dp))
            }
            Button(
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
                        modifier = Modifier
                            .height(18.dp)
                            .width(18.dp),
                        strokeWidth = 2.dp,
                    )
                    Spacer(Modifier.width(8.dp))
                }
                Text(stringResource(R.string.connect))
            }
        }
    }
}

@Composable
private fun UnifiedHome(
    state: YaNativeHomeState,
    onOpenConversation: (YaSourcedSession) -> Unit,
    onSetFilter: (String?) -> Unit,
    onRefresh: () -> Unit,
    onReauthenticate: (String, String) -> Unit,
    onDismissError: () -> Unit,
    onRetry: (String) -> Unit,
) {
    val visibleSources = state.servers.values.filter { source ->
        source.included && (state.filterProfileId == null || source.profile.id == state.filterProfileId)
    }
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(
            start = 20.dp,
            top = 16.dp,
            end = 20.dp,
            bottom = 32.dp,
        ),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Text(
                text = stringResource(R.string.servers),
                style = MaterialTheme.typography.titleMedium,
            )
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                item {
                    FilterChip(
                        selected = state.filterProfileId == null,
                        onClick = { onSetFilter(null) },
                        label = { Text(stringResource(R.string.all_servers)) },
                    )
                }
                items(state.includedProfiles, key = YaPairedServerProfile::id) { profile ->
                    val source = state.servers[profile.id]
                    FilterChip(
                        selected = profile.id == state.filterProfileId,
                        onClick = { onSetFilter(profile.id) },
                        label = { Text(sourceLabel(profile.username, source?.hostIcon)) },
                    )
                }
            }
        }
        if (state.includedProfiles.isEmpty()) {
            item {
                Text(
                    text = stringResource(R.string.no_servers_included),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        item { ErrorCard(state.error, onDismissError) }
        items(visibleSources, key = { "status:${it.profile.id}" }) { source ->
            SourceStatusCard(
                source = source,
                onRetry = { onRetry(source.profile.id) },
            )
        }
        visibleSources
            .filter { it.connection.phase == YaConnectionPhase.REAUTHENTICATION_REQUIRED }
            .forEach { source ->
                item(key = "reauth:${source.profile.id}") {
                ReauthenticationCard(
                    actionInProgress = state.actionInProgress,
                        onReauthenticate = { onReauthenticate(source.profile.id, it) },
                )
            }
        }
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    modifier = Modifier.weight(1f),
                    text = stringResource(R.string.recent_sessions),
                    style = MaterialTheme.typography.titleLarge,
                )
                if (visibleSources.any(YaNativeServerState::sessionsLoading)) {
                    CircularProgressIndicator(
                        modifier = Modifier
                            .height(20.dp)
                            .width(20.dp),
                        strokeWidth = 2.dp,
                    )
                }
                TextButton(onClick = onRefresh) {
                    Text(stringResource(R.string.refresh))
                }
            }
        }
        if (state.sourcedSessions.isEmpty() && visibleSources.any {
                it.connection.phase == YaConnectionPhase.CONNECTED && !it.sessionsLoading
            }
        ) {
            item {
                Text(
                    text = stringResource(R.string.no_sessions_yet),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        items(state.sourcedSessions, key = YaSourcedSession::key) { sourced ->
            SessionCard(sourced) { onOpenConversation(sourced) }
        }
    }
}

@Composable
private fun SourceStatusCard(
    source: YaNativeServerState,
    onRetry: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = sourceLabel(source.profile.username, source.hostIcon),
                style = MaterialTheme.typography.labelLarge,
            )
            Text(
                text = if (source.sessionLoadFailed &&
                    source.connection.phase == YaConnectionPhase.CONNECTED
                ) {
                    stringResource(R.string.session_load_failed)
                } else {
                    connectionStatus(source.connection.phase)
                },
                color = connectionStatusColor(source.connection.phase),
                style = MaterialTheme.typography.labelMedium,
            )
        }
        if (source.connection.phase == YaConnectionPhase.FAILED) {
            TextButton(onClick = onRetry) {
                Text(stringResource(R.string.retry))
            }
        }
    }
}

@Composable
private fun ServerSettings(
    state: YaNativeHomeState,
    onSetIncluded: (String, Boolean) -> Unit,
    onReauthenticate: (String, String) -> Unit,
    onDismissError: () -> Unit,
    onAddServer: () -> Unit,
    onForgetServer: (String) -> Unit,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    modifier = Modifier.weight(1f),
                    text = stringResource(R.string.servers),
                    style = MaterialTheme.typography.headlineSmall,
                )
                Button(onClick = onAddServer) {
                    Text(stringResource(R.string.add_server))
                }
            }
        }
        item { ErrorCard(state.error, onDismissError) }
        items(state.profiles, key = YaPairedServerProfile::id) { profile ->
            val source = state.servers[profile.id]
                ?: YaNativeServerState(profile = profile, included = false)
            ServerSettingsCard(
                source = source,
                actionInProgress = state.actionInProgress,
                onSetIncluded = { onSetIncluded(profile.id, it) },
                onReauthenticate = { onReauthenticate(profile.id, it) },
                onForgetServer = { onForgetServer(profile.id) },
            )
        }
    }
}

@Composable
private fun ServerSettingsCard(
    source: YaNativeServerState,
    actionInProgress: Boolean,
    onSetIncluded: (Boolean) -> Unit,
    onReauthenticate: (String) -> Unit,
    onForgetServer: () -> Unit,
) {
    val profile = source.profile
    val preferredRoute = profile.routes.firstOrNull { it.id == profile.preferredRouteId }
        ?: profile.routes.first()
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = sourceLabel(profile.username, source.hostIcon),
                        style = MaterialTheme.typography.titleLarge,
                    )
                    Text(
                        text = connectionStatus(source.connection.phase),
                        color = connectionStatusColor(source.connection.phase),
                        style = MaterialTheme.typography.labelLarge,
                    )
                }
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Switch(
                        checked = source.included,
                        onCheckedChange = onSetIncluded,
                    )
                    Text(
                        text = stringResource(R.string.include_in_all_servers),
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            }
            HorizontalDivider(modifier = Modifier.padding(vertical = 12.dp))
            Text(
                text = if (preferredRoute.kind == YaServerRouteKind.DIRECT) {
                    stringResource(R.string.direct_connection)
                } else {
                    stringResource(R.string.relay_connection)
                },
                style = MaterialTheme.typography.labelMedium,
            )
            Text(
                text = preferredRoute.websocketUrl,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
            )
            Text(
                modifier = Modifier.padding(top = 10.dp),
                text = stringResource(R.string.notifications_setup_pending),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
            )
            if (source.connection.phase == YaConnectionPhase.REAUTHENTICATION_REQUIRED) {
                ReauthenticationCard(
                    actionInProgress = actionInProgress,
                    onReauthenticate = onReauthenticate,
                )
            }
            TextButton(
                modifier = Modifier.align(Alignment.End),
                enabled = !actionInProgress,
                onClick = onForgetServer,
            ) {
                val unregistersServer = profile.securityClient?.let {
                    !it.revoked && !it.capabilityMissing && it.clientId != null
                } == true
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
private fun SessionCard(sourced: YaSourcedSession, onClick: () -> Unit) {
    val session = sourced.session
    Card(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = sourceLabel(sourced.serverUsername, sourced.serverIcon),
                color = MaterialTheme.colorScheme.primary,
                style = MaterialTheme.typography.labelMedium,
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    modifier = Modifier.weight(1f),
                    text = session.title ?: stringResource(R.string.untitled_session),
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = if (session.hasUnread) FontWeight.Bold else FontWeight.Medium,
                )
                if (session.pendingInputType != null) {
                    Text(
                        text = pendingInputLabel(session.pendingInputType),
                        color = MaterialTheme.colorScheme.primary,
                        style = MaterialTheme.typography.labelMedium,
                    )
                }
            }
            Text(
                modifier = Modifier.padding(top = 4.dp),
                text = "${session.provider} · ${session.projectName}",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
            )
            if (session.activity != null) {
                Text(
                    modifier = Modifier.padding(top = 4.dp),
                    text = activityLabel(session.activity),
                    color = MaterialTheme.colorScheme.primary,
                    style = MaterialTheme.typography.labelSmall,
                )
            }
            if (session.lastAgentText != null) {
                Text(
                    modifier = Modifier.padding(top = 8.dp),
                    text = session.lastAgentText,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}

@Composable
private fun ErrorCard(error: YaNativeUiError?, onDismiss: () -> Unit) {
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
private fun pendingInputLabel(value: String): String = when (value) {
    "tool-approval" -> stringResource(R.string.approval_needed)
    "user-question" -> stringResource(R.string.answer_needed)
    else -> stringResource(R.string.input_needed)
}

@Composable
private fun activityLabel(value: String): String = when (value) {
    "in-turn" -> stringResource(R.string.session_working)
    "waiting-input" -> stringResource(R.string.session_waiting)
    else -> value
}

@Composable
private fun uiErrorLabel(error: YaNativeUiError): String = when (error) {
    YaNativeUiError.INVALID_SERVER_DETAILS -> stringResource(
        R.string.invalid_server_details,
    )
    YaNativeUiError.AUTHENTICATION_FAILED -> stringResource(
        R.string.authentication_failed,
    )
    YaNativeUiError.CONNECTION_FAILED -> stringResource(R.string.connection_failed_message)
}

private fun sourceLabel(username: String, icon: String?): String =
    if (icon == null) username else "$icon $username"
