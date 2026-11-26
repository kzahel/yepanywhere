package com.yepanywhere.mobile.web

import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.ComposeView
import com.yepanywhere.mobile.ui.YaNavigationToolbar
import com.yepanywhere.mobile.ui.theme.YepAnywhereTheme
import com.yepanywhere.mobile.ui.theme.nativeShellDark
import com.yepanywhere.mobile.ui.theme.nativeShellSurface
import androidx.core.content.edit
import androidx.core.net.toUri
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewFeature
import androidx.webkit.WebSettingsCompat
import com.yepanywhere.mobile.BuildConfig
import com.yepanywhere.mobile.R
import com.yepanywhere.mobile.MainActivity
import com.yepanywhere.mobile.YepAnywhereApplication
import com.yepanywhere.mobile.notifications.NotificationFoundation
import com.yepanywhere.mobile.notifications.NotificationNativeHostOperations
import com.yepanywhere.mobile.notifications.NotificationStatusReader

open class WebClientActivity : ComponentActivity() {
    protected val config by lazy(WebClientConfig::fromBuild)
    private var webView: WebView? = null
    private var nativeHost: YaNativeMessageHost? = null
    private var transportHost: YaNativeTransportHost? = null
    private var notificationOperations: NotificationNativeHostOperations? = null
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var mainFrameFailed = false
    private var transportErrorView: View? = null
    fun nativeTransportDiagnostics(): org.json.JSONObject? = transportHost?.diagnostics()

    protected lateinit var shellRoot: FrameLayout
    private lateinit var pageRoot: FrameLayout
    private lateinit var webColumn: LinearLayout
    protected var openTabs by mutableStateOf<List<NativeTabs.Tab>>(emptyList())
        private set
    protected var selectedTabId by mutableStateOf<String?>(null)
        private set
    protected var tabHostLabels by mutableStateOf<Map<String, String>>(emptyMap())
    private val tabs = NativeTabs()
    private val histories = mutableMapOf<String, Bundle>()
    private var activeTabId: String? = null
    private var activeProfileId: String? = null
    protected open val ownsTabs: Boolean = false
    private var pageForeground = true
    protected fun setPageForeground(value: Boolean) {
        pageForeground = value
        transportHost?.setForeground(value && lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED))
    }
    protected val selectedTab: NativeTabs.Tab? get() = tabs.selected
    protected val hasSelectedTab: Boolean get() = tabs.selected != null
    private val tabPreferences by lazy { getSharedPreferences("native-tabs", MODE_PRIVATE) }
    protected open fun showTabs() = Unit
    protected open fun showHostSwitcher() = showHostManagement()
    protected open fun showHostSettings() = showHostManagement()
    protected open fun showHostManagement() {
        startActivity(Intent(this, MainActivity::class.java).putExtra(MainActivity.SHOW_HOSTS, true))
        finish()
    }

    protected fun restoreTabs(profileIds: Set<String>) {
        tabs.restore(tabPreferences.getString("state", null))
        tabs.retainProfiles(profileIds)
        activateSelectedTab()
    }
    protected fun retainTabProfiles(ids: Set<String>) {
        tabs.retainProfiles(ids)
        histories.keys.retainAll(tabs.items.map { it.id }.toSet())
        activateSelectedTab()
    }
    protected fun openProfile(profileId: String, url: String? = null, newTab: Boolean = false): Boolean {
        val path = url?.takeIf { WebClientNavigation.decide(it, config.origin) == NavigationDecision.ALLOW_IN_APP }
            ?.toUri()?.encodedPath ?: "/projects"
        if (tabs.open(profileId, path, newTab) == null) { tabLimit(); return false }
        activateSelectedTab()
        if (url != null) webView?.loadUrl(config.origin + NativeTabs.safePath(path))
        return true
    }
    protected fun selectTab(id: String) {
        tabs.select(id)
        activateSelectedTab()
    }
    protected fun closeTab(id: String) {
        histories.remove(id)
        tabs.close(id)
        activateSelectedTab()
    }
    protected fun setShellModalVisible(visible: Boolean) {
        webColumn.importantForAccessibility = if (visible) {
            View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        } else View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
    }
    private fun persistTabs() {
        if (ownsTabs) tabPreferences.edit { putString("state", tabs.encode()) }
        updateTabPresentation()
    }
    private fun updateTabPresentation() {
        if (!ownsTabs) return
        openTabs = tabs.items.map { it.copy() }
        selectedTabId = tabs.selectedId
    }
    private fun activateSelectedTab() {
        val selected = tabs.selected
        if (activeTabId == selected?.id) { persistTabs(); return }
        activeTabId?.takeIf { id -> tabs.items.any { it.id == id } }?.let { id ->
            webView?.takeIf { it.copyBackForwardList().size <= 64 }?.let { view ->
                histories[id] = Bundle().also(view::saveState)
            }
        }
        destroyDocument()
        pageRoot.removeAllViews()
        activeTabId = selected?.id
        activeProfileId = selected?.profileId
        if (selected != null) {
            mountDocument(config.origin + selected.path, histories.remove(selected.id))
        }
        persistTabs()
    }
    protected fun tabLimit() = android.widget.Toast.makeText(this, getString(R.string.native_tab_limit, NativeTabs.MAX_TABS), android.widget.Toast.LENGTH_SHORT).show()
    private fun localPath(url: String): String {
        val uri = url.toUri()
        return NativeTabs.livePath((uri.encodedPath ?: "/projects") +
            (uri.encodedQuery?.let { "?$it" } ?: "") + (uri.encodedFragment?.let { "#$it" } ?: ""))
    }
    private fun openTab(url: String, foreground: Boolean) {
        when (WebClientNavigation.decide(url, config.origin)) {
            NavigationDecision.ALLOW_IN_APP -> {
                val profile = activeProfileId ?: return
                if (tabs.open(profile, localPath(url), newTab = true, foreground = foreground) == null) { tabLimit(); return }
                activateSelectedTab()
                persistTabs()
                if (!foreground) android.widget.Toast.makeText(this, getString(R.string.native_tab_opened), android.widget.Toast.LENGTH_SHORT).show()
            }
            NavigationDecision.OPEN_EXTERNALLY -> openExternal(url)
            NavigationDecision.BLOCK -> Unit
        }
    }
    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val callback = fileChooserCallback
        fileChooserCallback = null
        callback?.onReceiveValue(
            WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data),
        )
    }

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) {
        notificationOperations?.onPermissionResult()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val barStyle = if (!ownsTabs || nativeShellDark(resources.configuration)) {
            SystemBarStyle.dark(Color.TRANSPARENT)
        } else SystemBarStyle.light(Color.TRANSPARENT, Color.rgb(24, 24, 24))
        enableEdgeToEdge(statusBarStyle = barStyle, navigationBarStyle = barStyle)
        notificationOperations = NotificationNativeHostOperations(
            activity = this,
            statusReader = NotificationStatusReader(
                this,
                NotificationFoundation.installationStore(this),
            ),
            launchPermissionRequest = {
                notificationPermissionLauncher.launch(POST_NOTIFICATIONS_PERMISSION)
            },
            showNotificationManagement = { showHostSettings() },
        )
        val root = FrameLayout(this).apply {
            setBackgroundColor(if (ownsTabs) nativeShellSurface(resources.configuration) else Color.rgb(24, 24, 24))
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val handled = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            val bars = insets.getInsets(handled)
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            // Native layout owns these edges. Forward zeroes, rather than
            // consuming the event, so WebView clears old safe areas and still
            // receives keyboard/visual-viewport updates.
            WindowInsetsCompat.Builder(insets).setInsets(handled, Insets.NONE).build()
        }

        shellRoot = root
        webColumn = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        pageRoot = FrameLayout(this)
        if (ownsTabs) {
            webColumn.addView(ComposeView(this).apply {
                setContent {
                    YepAnywhereTheme {
                        val profileId = openTabs.firstOrNull { it.id == selectedTabId }?.profileId
                        YaNavigationToolbar(
                            host = tabHostLabels[profileId] ?: getString(R.string.app_name),
                            tabCount = openTabs.size,
                            onSwitchHost = ::showHostSwitcher,
                            onShowTabs = ::showTabs,
                        )
                    }
                }
            })
        }
        webColumn.addView(pageRoot, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(webColumn)
        setContentView(root)

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    val current = webView
                    if (current?.canGoBack() == true) {
                        current.goBack()
                    } else {
                        moveTaskToBack(true)
                    }
                }
            },
        )

        if (!ownsTabs) {
            activeProfileId = intent.getStringExtra(PROFILE_ID)
            val restoredPath = savedInstanceState?.getString(NATIVE_WEB_PATH)
            mountDocument(restoredPath?.let { config.origin + NativeTabs.safePath(it) } ?: consumeStartUrl())
        }
    }

    private fun mountDocument(url: String, history: Bundle? = null) {
        val clientView = createWebView()
        val errorView = createErrorView(clientView)
        transportErrorView = errorView
        pageRoot.addView(clientView, FrameLayout.LayoutParams(-1, -1))
        pageRoot.addView(errorView, FrameLayout.LayoutParams(-1, -1))
        clientView.webViewClient = createWebViewClient(errorView)
        if (config.bundled && activeProfileId != null && transportHost == null) {
            errorView.visibility = View.VISIBLE
            return
        }
        if (history == null || clientView.restoreState(history) == null) clientView.loadUrl(url)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        if (config.bundled && activeProfileId != null) {
            webView?.url?.takeIf { WebClientNavigation.decide(it, config.origin) == NavigationDecision.ALLOW_IN_APP }?.let {
                // Preserve native app navigation across recreation, without
                // persisting login fragments or query credentials in a Bundle.
                outState.putString(NATIVE_WEB_PATH, it.toUri().encodedPath)
            }
        }
        super.onSaveInstanceState(outState)
    }

    private fun consumeStartUrl(): String {
        val requestedUrl = intent.dataString
        intent.data = null
        return requestedUrl?.takeIf {
            WebClientNavigation.decide(it, config.origin) == NavigationDecision.ALLOW_IN_APP
        } ?: if (config.bundled && activeProfileId != null) "${config.origin}/projects" else config.startUrl
    }

    @Suppress("SetJavaScriptEnabled")
    private fun createWebView(): WebView {
        val view = WebView(this).apply {
            id = R.id.web_client
            setBackgroundColor(Color.rgb(24, 24, 24))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.javaScriptCanOpenWindowsAutomatically = false
            settings.setSupportMultipleWindows(ownsTabs)
            settings.builtInZoomControls = false
            settings.displayZoomControls = false
            if (WebViewFeature.isFeatureSupported(WebViewFeature.SAFE_BROWSING_ENABLE)) {
                WebSettingsCompat.setSafeBrowsingEnabled(settings, true)
            }
            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
            setOnLongClickListener { clicked ->
                val hit = hitTestResult
                val url = hit.extra
                if (ownsTabs && hit.type == WebView.HitTestResult.SRC_ANCHOR_TYPE && url != null &&
                    WebClientNavigation.decide(url, config.origin) == NavigationDecision.ALLOW_IN_APP) {
                    android.app.AlertDialog.Builder(this@WebClientActivity)
                        .setItems(arrayOf(getString(R.string.native_tab_open))) { _, _ -> if (clicked === webView) openTab(url, false) }.show()
                    true
                } else false
            }
            webChromeClient = object : WebChromeClient() {
                override fun onReceivedTitle(view: WebView, title: String?) {
                    val tab = tabs.selected ?: return
                    if (view !== webView) return
                    val label = NativeTabs.displayTitle(title)
                    if (tab.title != label) {
                        tab.title = label
                        updateTabPresentation()
                    }
                }
                override fun onCreateWindow(view: WebView, dialog: Boolean, userGesture: Boolean, result: android.os.Message): Boolean {
                    if (!ownsTabs || !userGesture || view !== webView) return false
                    // This temporary resolver has no JavaScript, cookies configured by us,
                    // asset loader or native bridge. It never loads the destination.
                    val popup = WebView(this@WebClientActivity)
                    var finished = false
                    fun dispose() { if (!finished) { finished = true; popup.destroy() } }
                    popup.webViewClient = object : WebViewClient() {
                        override fun shouldInterceptRequest(v: WebView, request: WebResourceRequest): WebResourceResponse =
                            WebResourceResponse("text/plain", "utf-8", java.io.ByteArrayInputStream(ByteArray(0)))
                        override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                            if (!finished && request.isForMainFrame && view === webView) openTab(request.url.toString(), true)
                            v.post { dispose() }
                            return true
                        }
                    }
                    (result.obj as WebView.WebViewTransport).webView = popup
                    result.sendToTarget()
                    view.postDelayed({ dispose() }, 5000)
                    return true
                }

                override fun onShowFileChooser(
                    webView: WebView,
                    filePathCallback: ValueCallback<Array<Uri>>,
                    fileChooserParams: FileChooserParams,
                ): Boolean {
                    fileChooserCallback?.onReceiveValue(null)
                    fileChooserCallback = filePathCallback
                    return try {
                        fileChooserLauncher.launch(fileChooserParams.createIntent())
                        true
                    } catch (_: ActivityNotFoundException) {
                        fileChooserCallback = null
                        filePathCallback.onReceiveValue(null)
                        false
                    }
                }
            }
            setDownloadListener { url, _, _, _, _ ->
                openExternal(url)
            }
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        nativeHost = YaNativeMessageHost.install(
            view,
            config,
            checkNotNull(notificationOperations),
        )
        activeProfileId?.let { profileId ->
            transportHost = YaNativeTransportHost.install(view, config,
                (application as YepAnywhereApplication).nativeRuntime, profileId, onFatal = {
                    mainFrameFailed = true
                    transportErrorView?.visibility = View.VISIBLE
                }) {
                showHostManagement()
            }
        }
        transportHost?.setForeground(pageForeground && lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED))
        webView = view
        return view
    }

    private fun createErrorView(clientView: WebView): View {
        return LinearLayout(this).apply errorView@ {
            id = R.id.web_error
            visibility = View.GONE
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(48, 48, 48, 48)
            setBackgroundColor(Color.rgb(24, 24, 24))

            addView(TextView(context).apply {
                text = getString(R.string.web_client_unavailable)
                setTextColor(Color.WHITE)
                textSize = 18f
                gravity = Gravity.CENTER
            })
            addView(Button(context).apply {
                val unavailableTransport = config.bundled && activeProfileId != null && transportHost == null
                text = getString(if (unavailableTransport) R.string.back else R.string.retry)
                setOnClickListener {
                    if (unavailableTransport) finish()
                    else {
                        this@errorView.visibility = View.GONE
                        clientView.reload()
                    }
                }
            })
        }
    }

    private fun createWebViewClient(errorView: View): WebViewClient {
        val assetLoader = if (config.bundled) {
            WebViewAssetLoader.Builder()
                .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
                .build()
        } else {
            null
        }

        return object : WebViewClient() {
            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                if (view === webView && url != null && WebClientNavigation.decide(url, config.origin) == NavigationDecision.ALLOW_IN_APP) {
                    tabs.selected?.path = localPath(url)
                    persistTabs()
                }
            }

            override fun onPageStarted(
                view: WebView,
                url: String,
                favicon: Bitmap?,
            ) {
                if (view !== webView) return
                mainFrameFailed = false
                errorView.visibility = View.GONE
                nativeHost?.onDocumentChanged()
                transportHost?.onDocumentChanged()
            }

            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? {
                (application as YepAnywhereApplication).artifactShell?.intercept(request)?.let { return it }
                if (
                    assetLoader != null &&
                    request.isForMainFrame &&
                    WebClientNavigation.decide(request.url.toString(), config.origin) ==
                    NavigationDecision.ALLOW_IN_APP &&
                    request.url.lastPathSegment?.contains('.') != true
                ) {
                    return assetLoader.shouldInterceptRequest(
                        "${config.origin}/index.html".toUri(),
                    )
                }
                return assetLoader?.shouldInterceptRequest(request.url)
            }

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                if (view !== webView) return true
                // The trusted parent's CSP chooses its embedded viewers. Keep
                // their HTTP(S) navigations inside the sandbox; main-frame
                // links still use native routing and the bridge stays main-only.
                if (!request.isForMainFrame && request.url.scheme in setOf("http", "https")) return false
                return when (
                    WebClientNavigation.decide(request.url.toString(), config.origin)
                ) {
                    NavigationDecision.ALLOW_IN_APP -> false
                    NavigationDecision.OPEN_EXTERNALLY -> {
                        openExternal(request.url.toString())
                        true
                    }
                    NavigationDecision.BLOCK -> true
                }
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (view !== webView) return
                if (!mainFrameFailed) {
                    errorView.visibility = View.GONE
                }
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError,
            ) {
                if (view === webView && request.isForMainFrame) {
                    mainFrameFailed = true
                    errorView.visibility = View.VISIBLE
                }
            }

            override fun onReceivedHttpError(
                view: WebView,
                request: WebResourceRequest,
                errorResponse: WebResourceResponse,
            ) {
                if (view === webView && request.isForMainFrame) {
                    mainFrameFailed = true
                    errorView.visibility = View.VISIBLE
                }
            }

            override fun onRenderProcessGone(
                view: WebView,
                detail: RenderProcessGoneDetail,
            ): Boolean {
                if (view !== webView) { view.destroy(); return true }
                transportHost?.close()
                transportHost = null
                nativeHost?.destroy()
                nativeHost = null
                webView = null
                (view.parent as? ViewGroup)?.removeView(view)
                view.destroy()
                recreate()
                return true
            }
        }
    }

    private fun openExternal(url: String) {
        if (
            WebClientNavigation.decide(url, config.origin) !=
            NavigationDecision.OPEN_EXTERNALLY
        ) {
            return
        }
        try {
            startActivity(
                Intent(Intent.ACTION_VIEW, url.toUri()).apply {
                    addCategory(Intent.CATEGORY_BROWSABLE)
                },
            )
        } catch (_: ActivityNotFoundException) {
            // The navigation remains blocked inside the privileged WebView.
        }
    }

    private fun destroyDocument() {
        transportHost?.close()
        transportHost = null
        transportErrorView = null
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = null
        nativeHost?.destroy()
        nativeHost = null
        webView?.let { view ->
            (view.parent as? ViewGroup)?.removeView(view)
            view.stopLoading()
            view.destroy()
        }
        webView = null
    }

    override fun onDestroy() {
        destroyDocument()
        notificationOperations?.destroy()
        notificationOperations = null
        super.onDestroy()
    }

    override fun onStop() {
        persistTabs()
        transportHost?.setForeground(false)
        webView?.onPause()
        super.onStop()
    }

    override fun onStart() {
        super.onStart()
        webView?.onResume()
        transportHost?.setForeground(pageForeground)
    }

    override fun onUserInteraction() {
        super.onUserInteraction()
        notificationOperations?.recordUserInteraction()
    }

    companion object {
        const val PROFILE_ID = "nativeProfileId"
        private const val NATIVE_WEB_PATH = "nativeWebPath"
        private const val POST_NOTIFICATIONS_PERMISSION =
            "android.permission.POST_NOTIFICATIONS"
    }
}
