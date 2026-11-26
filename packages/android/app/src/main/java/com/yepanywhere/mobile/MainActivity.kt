package com.yepanywhere.mobile

import android.content.Intent
import android.os.Bundle
import androidx.activity.viewModels
import androidx.core.net.toUri
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import com.yepanywhere.mobile.links.AppLinkDestination
import com.yepanywhere.mobile.connection.YaConnectionPhase
import com.yepanywhere.mobile.ui.YaHostManagementScreen
import com.yepanywhere.mobile.ui.YaHostManagementViewModel
import com.yepanywhere.mobile.ui.YaNavigationSheet
import com.yepanywhere.mobile.ui.YaPairingInput
import com.yepanywhere.mobile.ui.YaShellDestination
import com.yepanywhere.mobile.ui.theme.YepAnywhereTheme
import com.yepanywhere.mobile.web.WebClientActivity
import com.yepanywhere.mobile.web.WebClientConfig
import com.yepanywhere.mobile.web.NativeTabs
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.job
import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import com.yepanywhere.mobile.notifications.NativePushPresenter
import com.yepanywhere.mobile.notifications.resolveNativePushWhenReady
import com.yepanywhere.mobile.notifications.NotificationFoundation
import com.yepanywhere.mobile.notifications.NotificationStatusReader

class MainActivity : WebClientActivity() {
    override val ownsTabs get() = config.bundled
    private var managementView: androidx.compose.ui.platform.ComposeView? = null
    private var destination by mutableStateOf<YaShellDestination?>(null)
    private var initialized = false
    private lateinit var managementBack: androidx.activity.OnBackPressedCallback
    private val homeViewModel by viewModels<YaHostManagementViewModel>()
    private var launchJob: Job? = null
    private var pendingPushProfile: String? = null
    private data class PushLaunch(val subscription: String, val session: String?)
    private data class PushDestination(val path: String?)
    private var pendingPushLaunch: PushLaunch? = null
    private val pushPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val profile = pendingPushProfile
        pendingPushProfile = null
        // A denial refreshes the card into its blocked state and Settings link,
        // and lets a newly paired server open without notifications.
        if (!granted) homeViewModel.finishPushOffer()
        homeViewModel.refreshNotifications(enableWhenReady = profile.takeIf { granted })
    }
    private fun enablePush(profileId: String) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            pendingPushProfile = profileId
            NotificationStatusReader(this, NotificationFoundation.installationStore(this)).markPermissionRequested()
            pushPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else homeViewModel.setPush(profileId, true)
    }
    // A server the user asked to enable before Android sent them to Settings.
    private var pendingSettingsPushProfile: String? = null
    private fun openNotificationSettings(profileId: String) {
        pendingSettingsPushProfile = profileId.takeIf { homeViewModel.state.value.servers[it]?.pushEnabled != true }
        val intent = if (Build.VERSION.SDK_INT >= 26) {
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
        } else {
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, "package:$packageName".toUri())
        }
        startActivity(intent)
    }

    override fun onResume() {
        super.onResume()
        homeViewModel.refreshNotifications(enableWhenReady = pendingSettingsPushProfile)
        pendingSettingsPushProfile = null
    }
    // App Link credentials are transient visible UI state, never a ViewModel
    // value or saved-instance state.
    private var pairingInput by mutableStateOf<YaPairingInput?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pendingPushProfile = savedInstanceState?.getString("pendingPushProfile")
        pendingSettingsPushProfile = savedInstanceState?.getString("pendingSettingsPushProfile")
        pendingPushLaunch = savedInstanceState?.getString("pendingPushSubscription")?.let {
            PushLaunch(it, savedInstanceState.getString("pendingPushSession"))
        }
        managementBack = object : androidx.activity.OnBackPressedCallback(false) {
            override fun handleOnBackPressed() { backFromShell() }
        }
        onBackPressedDispatcher.addCallback(this, managementBack)
        lifecycleScope.launch {
            homeViewModel.openProfile.collect { selection ->
                cancelPendingPushLaunch()
                pairingInput = null
                if (ownsTabs) {
                    if (openProfile(selection.id, newTab = selection.newTab)) {
                        hideShell()
                    } else {
                        showShell(YaShellDestination.Details(selection.id, YaShellDestination.Hosts()))
                    }
                } else {
                    hideShell()
                    startWebClient(null, selection.id)
                }
            }
        }
        lifecycleScope.launch {
            val runtime = (application as YepAnywhereApplication).nativeRuntime
            val list = runtime.pairedServers.listState.first()
            tabHostLabels = list.profiles.associate { it.id to it.label }
            if (ownsTabs) restoreTabs(tabHostLabels.keys)
            initialized = true
            routeLaunch(intent, restorePendingPush = true)
            runtime.pairedServers.listState.collect { current ->
                tabHostLabels = current.profiles.associate { it.id to it.label }
                val hadSelectedTab = hasSelectedTab
                retainTabProfiles(tabHostLabels.keys)
                val screen = destination
                if (screen is YaShellDestination.Details && screen.profileId !in tabHostLabels) {
                    showShell(screen.returnTo.takeUnless { it.isSheet && !hasSelectedTab } ?: YaShellDestination.Hosts())
                } else if (!hasSelectedTab && (screen?.isSheet == true || (screen == null && hadSelectedTab))) {
                    showShell(YaShellDestination.Hosts())
                }
            }
        }
    }

    override fun showTabs() {
        if (hasSelectedTab) showShell(YaShellDestination.Tabs)
    }

    override fun showHostSwitcher() {
        if (hasSelectedTab) showShell(YaShellDestination.SwitchHost) else showSavedHosts()
    }

    override fun showHostManagement() {
        if (destination != null) return
        val id = selectedTab?.profileId
        val phase = id?.let {
            (application as YepAnywhereApplication).nativeRuntime.connectionManager(it).state.value.phase
        }
        if (id != null && (phase == YaConnectionPhase.REAUTHENTICATION_REQUIRED || phase == YaConnectionPhase.REVOKED)) {
            showShell(YaShellDestination.Details(id, YaShellDestination.Hosts()))
        } else showHostSwitcher()
    }

    override fun showHostSettings() {
        val id = selectedTab?.profileId
        if (id != null) showShell(YaShellDestination.Details(id, YaShellDestination.Hosts()))
        else showSavedHosts()
    }

    private fun showSavedHosts() {
        showShell(if (tabHostLabels.isEmpty()) YaShellDestination.AddHost(null) else YaShellDestination.Hosts())
    }

    private fun showShell(screen: YaShellDestination) {
        if (hasSelectedTab) cancelPendingPushLaunch()
        destination = screen
        setPageForeground(screen.isSheet)
        setShellModalVisible(true)
        managementBack.isEnabled = hasSelectedTab || screen is YaShellDestination.Details ||
            (screen is YaShellDestination.AddHost && screen.returnTo != null)
        if (managementView != null) return
        managementView = androidx.compose.ui.platform.ComposeView(this).apply {
            setContent {
                YepAnywhereTheme {
                    val state by homeViewModel.state.collectAsState()
                    when (val current = destination) {
                        YaShellDestination.Tabs, YaShellDestination.OtherHost, YaShellDestination.SwitchHost ->
                            key(current) {
                                YaNavigationSheet(
                                    destination = current,
                                    state = state,
                                    tabs = openTabs,
                                    selectedTabId = selectedTabId,
                                    hostLabels = tabHostLabels,
                                    onBack = ::backFromShell,
                                    onDismiss = ::dismissShell,
                                    onDismissError = homeViewModel::clearError,
                                    onSelectTab = { id -> selectTab(id); hideShell() },
                                    onCloseTab = { id ->
                                        closeTab(id)
                                        if (!hasSelectedTab) showShell(YaShellDestination.Hosts())
                                    },
                                    onOpenHost = ::openFromSheet,
                                    onOtherHost = { if (openTabs.size < NativeTabs.MAX_TABS) showShell(YaShellDestination.OtherHost) else tabLimit() },
                                    onAddHost = { beginPairing(YaShellDestination.OtherHost) },
                                    onManageHosts = { showShell(YaShellDestination.Hosts(fromSwitcher = true)) },
                                )
                            }
                        is YaShellDestination.Hosts, is YaShellDestination.Details, is YaShellDestination.AddHost ->
                            YaHostManagementScreen(
                                destination = current,
                                viewModel = homeViewModel,
                                tabs = openTabs,
                                pairingInput = pairingInput,
                                onClearPairingInput = { pairingInput = null },
                                onBack = ::backFromShell,
                                onAddHost = { beginPairing(current) },
                                onHostDetails = { id -> showShell(YaShellDestination.Details(id, current)) },
                                onEnablePush = ::enablePush,
                                onOpenNotificationSettings = ::openNotificationSettings,
                                onAcceptPushOffer = { homeViewModel.acceptPushOffer()?.let(::enablePush) },
                            )
                        null -> Unit
                    }
                }
            }
            shellRoot.addView(this, android.widget.FrameLayout.LayoutParams(-1, -1))
        }
    }

    private fun openFromSheet(id: String, newTab: Boolean) {
        val state = homeViewModel.state.value
        if (state.actionInProgress || state.profiles.none { it.id == id }) return
        if (openTabs.size >= NativeTabs.MAX_TABS && (newTab || openTabs.none { it.profileId == id })) {
            tabLimit()
            return
        }
        val phase = state.servers[id]?.connection?.phase
        if (phase == YaConnectionPhase.REVOKED || phase == YaConnectionPhase.REAUTHENTICATION_REQUIRED) {
            showShell(YaShellDestination.Details(id, checkNotNull(destination), newTab))
        } else {
            homeViewModel.select(id, newTab)
        }
    }

    private fun beginPairing(returnTo: YaShellDestination) {
        if (returnTo == YaShellDestination.OtherHost && openTabs.size >= NativeTabs.MAX_TABS) {
            tabLimit()
            return
        }
        pairingInput = null
        homeViewModel.clearError()
        showShell(YaShellDestination.AddHost(returnTo))
    }

    private fun backFromShell() {
        val state = homeViewModel.state.value
        if (state.actionInProgress || state.pushOffer != null) return
        homeViewModel.clearError()
        val previous = when (val current = destination) {
            YaShellDestination.OtherHost -> YaShellDestination.Tabs
            is YaShellDestination.Hosts -> YaShellDestination.SwitchHost.takeIf { current.fromSwitcher }
            is YaShellDestination.Details -> current.returnTo
            is YaShellDestination.AddHost -> {
                pairingInput = null
                current.returnTo
            }
            else -> null
        }
        if (previous != null) showShell(previous) else dismissShell()
    }

    private fun dismissShell() {
        if (hasSelectedTab && !homeViewModel.state.value.actionInProgress) {
            homeViewModel.clearError()
            hideShell()
        }
    }

    private fun hideShell() {
        pairingInput = null
        destination = null
        managementView?.let { shellRoot.removeView(it); it.disposeComposition() }
        managementView = null
        managementBack.isEnabled = false
        setShellModalVisible(false)
        setPageForeground(true)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        pendingPushProfile?.let { outState.putString("pendingPushProfile", it) }
        pendingSettingsPushProfile?.let { outState.putString("pendingSettingsPushProfile", it) }
        pendingPushLaunch?.let {
            outState.putString("pendingPushSubscription", it.subscription)
            outState.putString("pendingPushSession", it.session)
        }
        super.onSaveInstanceState(outState)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (initialized) routeLaunch(intent)
    }

    private fun cancelPendingPushLaunch() {
        if (pendingPushLaunch == null) return
        pendingPushLaunch = null
        launchJob?.cancel()
    }

    private fun routeLaunch(intent: Intent, restorePendingPush: Boolean = false) {
        launchJob?.cancel()
        val push = intent.getStringExtra(NativePushPresenter.SUBSCRIPTION_EXTRA)?.let { subscription ->
            PushLaunch(subscription, intent.getStringExtra(NativePushPresenter.SESSION_EXTRA)?.takeIf { Regex("^[A-Za-z0-9_-]{1,128}$").matches(it) })
        } ?: pendingPushLaunch.takeIf { restorePendingPush }
        pendingPushLaunch = push
        if (push != null) {
            intent.removeExtra(NativePushPresenter.SUBSCRIPTION_EXTRA)
            intent.removeExtra(NativePushPresenter.SESSION_EXTRA)
            launchJob = lifecycleScope.launch {
                val runtime = (application as YepAnywhereApplication).nativeRuntime
                val owner = currentCoroutineContext().job
                repeatOnLifecycle(Lifecycle.State.STARTED) {
                    val binding = NativePushPresenter.destination(runtime, push.subscription)
                    if (binding == null) {
                        pendingPushLaunch = null
                        owner.cancel()
                        return@repeatOnLifecycle
                    }
                    // Show the paired host while offline. Its normal foreground
                    // owner drives recovery and explains it to the user.
                    // A hosted client opens another Activity; opening it here
                    // would background and cancel this destination lookup.
                    if (config.bundled) startWebClient(null, binding.profileId)
                    val manager = runtime.connectionManager(binding.profileId)
                    val lease = manager.acquire()
                    try {
                        val destination = resolveNativePushWhenReady(manager.state) {
                            lease.request("GET", "/version")
                            if (NativePushPresenter.destination(runtime, push.subscription) != binding) return@resolveNativePushWhenReady null
                            val path = push.session?.let {
                                (lease.request("GET", "/security/clients/${binding.clientId}/native-push-subscription/destination?sessionId=$it").body as? org.json.JSONObject)?.optString("path")?.takeIf { path -> Regex("^/projects/[A-Za-z0-9_-]{1,2048}/sessions/[A-Za-z0-9_-]{1,128}$").matches(path) }
                            }
                            if (NativePushPresenter.destination(runtime, push.subscription) != binding) null else PushDestination(path)
                        }
                        if (destination != null) {
                            runtime.pairedServers.select(binding.profileId)
                            startWebClient(destination.path?.let { config.origin + it }, binding.profileId)
                        }
                        pendingPushLaunch = null
                        owner.cancel()
                    } finally { kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) { lease.releaseAndAwait() } }
                }
            }
            return
        }
        if (intent.getBooleanExtra(SHOW_HOSTS, false)) {
            intent.removeExtra(SHOW_HOSTS)
            showSavedHosts()
            return
        }
        if (WebClientConfig.fromBuild().bundled) {
            val pairingLink = AppLinkDestination.toNativePairingLink(intent.action, intent.dataString)
            if (pairingLink != null) {
                intent.data = null
                pairingInput = YaPairingInput(pairingLink.username, pairingLink.password, relayWebsocketUrl = pairingLink.relayWebsocketUrl)
                showShell(YaShellDestination.AddHost(YaShellDestination.Hosts().takeIf { tabHostLabels.isNotEmpty() }))
                return
            }
            // A malformed pairing link must never fall through to web login.
            if (intent.action == Intent.ACTION_VIEW && intent.data != null) {
                intent.data = null
                return
            }
        }
        if (hasSelectedTab && intent.action != Intent.ACTION_VIEW) return
        val requestedUrl = AppLinkDestination.toWebClientUrlForIntent(
            action = intent.action,
            appLink = intent.dataString,
            clientStartUrl = WebClientConfig.fromBuild().startUrl,
        )
        intent.data = null
        launchJob = lifecycleScope.launch {
            val list = (application as YepAnywhereApplication).nativeRuntime.pairedServers.listState.first()
            val profileId = selectedTab?.profileId ?: list.selectedProfileId ?: list.profiles.firstOrNull()?.id
            if (profileId != null) startWebClient(requestedUrl, profileId)
            else if (!WebClientConfig.fromBuild().bundled && requestedUrl != null) startWebClient(requestedUrl, null)
            else showHostManagement()
        }
    }

    private fun startWebClient(requestedUrl: String?, profileId: String?) {
        if (profileId != null && config.bundled) {
            if (openProfile(profileId, requestedUrl)) hideShell()
        } else {
            startActivity(Intent(this, WebClientActivity::class.java).apply { if (requestedUrl != null) data = requestedUrl.toUri() })
        }
    }

    companion object { const val SHOW_HOSTS = "showHosts" }
}
